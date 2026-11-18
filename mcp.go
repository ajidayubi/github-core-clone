// MCP: JSON-RPC 2.0 streamable HTTP. Supports the 2026-07-28 revision
// (server/discover) and the 2025-11-25 handshake (initialize). Tools act on
// the same store as REST.
package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

type mcpTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

var mcpTools = []mcpTool{
	{
		Name:        "create_repo",
		Description: "Create a new repository owned by the viewer.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"name":        map[string]any{"type": "string"},
				"description": map[string]any{"type": "string"},
				"private":     map[string]any{"type": "boolean"},
			},
			"required": []string{"name"},
		},
	},
	{
		Name:        "get_repo",
		Description: "Get a repository by owner and name.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"owner": map[string]any{"type": "string"},
				"repo":  map[string]any{"type": "string"},
			},
			"required": []string{"owner", "repo"},
		},
	},
	{
		Name:        "create_issue",
		Description: "Create an issue in a repository.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"owner": map[string]any{"type": "string"},
				"repo":  map[string]any{"type": "string"},
				"title": map[string]any{"type": "string"},
				"body":  map[string]any{"type": "string"},
			},
			"required": []string{"owner", "repo", "title"},
		},
	},
	{
		Name:        "list_issues",
		Description: "List issues in a repository.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"owner": map[string]any{"type": "string"},
				"repo":  map[string]any{"type": "string"},
				"state": map[string]any{"type": "string"},
			},
			"required": []string{"owner", "repo"},
		},
	},
	{
		Name:        "create_pull_request",
		Description: "Create a pull request between two branches.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"owner": map[string]any{"type": "string"},
				"repo":  map[string]any{"type": "string"},
				"title": map[string]any{"type": "string"},
				"head":  map[string]any{"type": "string"},
				"base":  map[string]any{"type": "string"},
				"body":  map[string]any{"type": "string"},
			},
			"required": []string{"owner", "repo", "title", "head", "base"},
		},
	},
	{
		Name:        "merge_pull_request",
		Description: "Squash-merge a pull request onto its base branch.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"owner":       map[string]any{"type": "string"},
				"repo":        map[string]any{"type": "string"},
				"pull_number": map[string]any{"type": "number"},
			},
			"required": []string{"owner", "repo", "pull_number"},
		},
	},
}

var toolsListResult []byte
var toolsListOnce sync.Once

func toolsListJSON() []byte {
	toolsListOnce.Do(func() {
		toolsListResult, _ = json.Marshal(map[string]any{"tools": mcpTools})
	})
	return toolsListResult
}

func mcpHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeErr(w, 404, "Not Found")
		return
	}
	body, err := readBody(r, 4<<20)
	if err != nil {
		writeJSON(w, 400, map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32700, "message": "Parse error"}})
		return
	}
	var req struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, 400, map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32700, "message": "Parse error"}})
		return
	}
	// Notifications have no id: answer 202 with an empty body.
	if len(req.ID) == 0 {
		w.WriteHeader(202)
		return
	}
	if sid := r.Header.Get("Mcp-Session-Id"); sid != "" {
		w.Header().Set("Mcp-Session-Id", sid)
	}
	reply := func(result any) {
		resp := map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(req.ID), "result": result}
		writeJSON(w, 200, resp)
	}
	replyErr := func(code int, msg string) {
		resp := map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(req.ID), "error": map[string]any{"code": code, "message": msg}}
		writeJSON(w, 200, resp)
	}
	serverInfo := map[string]any{"name": "forge", "version": "1.0.0"}
	switch req.Method {
	case "server/discover":
		reply(map[string]any{
			"supportedVersions": []string{"2026-07-28", "2025-11-25"},
			"capabilities":      map[string]any{"tools": map[string]any{}},
			"serverInfo":        serverInfo,
			"_meta":             map[string]any{"io.modelcontextprotocol/serverInfo": serverInfo},
		})
	case "initialize":
		ver := "2025-11-25"
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &params)
		if params.ProtocolVersion == "2026-07-28" || params.ProtocolVersion == "2025-11-25" {
			ver = params.ProtocolVersion
		}
		reply(map[string]any{
			"protocolVersion": ver,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      serverInfo,
			"_meta":           map[string]any{"io.modelcontextprotocol/serverInfo": serverInfo},
		})
	case "ping":
		reply(map[string]any{})
	case "tools/list":
		resp := map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(req.ID), "result": json.RawMessage(toolsListJSON())}
		writeJSON(w, 200, resp)
	case "tools/call":
		var params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			replyErr(-32602, "invalid params")
			return
		}
		if params.Arguments == nil {
			params.Arguments = map[string]any{}
		}
		result, isErr, rpcErr := callTool(params.Name, params.Arguments)
		if rpcErr != "" {
			replyErr(-32602, rpcErr)
			return
		}
		text, _ := json.Marshal(result)
		res := map[string]any{
			"content":           []map[string]any{{"type": "text", "text": string(text)}},
			"structuredContent": result,
		}
		if isErr {
			res["isError"] = true
		}
		reply(res)
	default:
		replyErr(-32601, "method not found: "+req.Method)
	}
}

func argString(args map[string]any, k string) (string, bool) {
	v, ok := args[k]
	if !ok {
		return "", false
	}
	s, ok := v.(string)
	return s, ok
}

func argNumber(args map[string]any, k string) (int, bool) {
	v, ok := args[k]
	if !ok {
		return 0, false
	}
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	case json.Number:
		i, err := n.Int64()
		return int(i), err == nil
	case string:
		i, err := strconv.Atoi(n)
		return i, err == nil
	}
	return 0, false
}

func toolError(msg string) (map[string]any, bool, string) {
	return map[string]any{"error": msg}, true, ""
}

// callTool runs one MCP tool. Returns (result, isError, rpcError).
func callTool(name string, args map[string]any) (map[string]any, bool, string) {
	need := func(keys ...string) (map[string]any, bool, string) {
		for _, k := range keys {
			if _, ok := args[k]; !ok {
				return map[string]any{"error": "missing required argument: " + k}, true, ""
			}
		}
		return nil, false, ""
	}
	switch name {
	case "create_repo":
		if res, isErr, rpcErr := need("name"); isErr || rpcErr != "" {
			return res, isErr, rpcErr
		}
		nm, _ := argString(args, "name")
		desc, _ := argString(args, "description")
		priv := false
		if v, ok := args["private"]; ok {
			if b, ok := v.(bool); ok {
				priv = b
			}
		}
		repo, created := db.create(viewerLogin, nm, desc, priv)
		if !created {
			return toolError("repository already exists: " + nm)
		}
		var out map[string]any
		_ = json.Unmarshal(repoJSON(repo), &out)
		return out, false, ""
	case "get_repo":
		if res, isErr, rpcErr := need("owner", "repo"); isErr || rpcErr != "" {
			return res, isErr, rpcErr
		}
		owner, _ := argString(args, "owner")
		nm, _ := argString(args, "repo")
		repo := db.get(owner, nm)
		if repo == nil {
			return toolError("repository not found: " + owner + "/" + nm)
		}
		var out map[string]any
		_ = json.Unmarshal(repoJSON(repo), &out)
		return out, false, ""
	case "create_issue":
		if res, isErr, rpcErr := need("owner", "repo", "title"); isErr || rpcErr != "" {
			return res, isErr, rpcErr
		}
		owner, _ := argString(args, "owner")
		nm, _ := argString(args, "repo")
		title, _ := argString(args, "title")
		body, _ := argString(args, "body")
		db.mu.Lock()
		defer db.mu.Unlock()
		repo := db.repos[owner+"/"+nm]
		if repo == nil {
			return toolError("repository not found: " + owner + "/" + nm)
		}
		num := repo.NextNum
		repo.NextNum++
		iss := &issue{ID: repo.DBID*100000 + num, Number: num, Title: title, Body: body, State: "open", CreatedSeq: num}
		repo.Issues = append(repo.Issues, iss)
		var out map[string]any
		_ = json.Unmarshal(issueJSON(repo, iss), &out)
		return out, false, ""
	case "list_issues":
		if res, isErr, rpcErr := need("owner", "repo"); isErr || rpcErr != "" {
			return res, isErr, rpcErr
		}
		owner, _ := argString(args, "owner")
		nm, _ := argString(args, "repo")
		state, _ := argString(args, "state")
		if state == "" {
			state = "open"
		}
		db.mu.RLock()
		defer db.mu.RUnlock()
		repo := db.repos[owner+"/"+nm]
		if repo == nil {
			return toolError("repository not found: " + owner + "/" + nm)
		}
		var items []map[string]any
		for _, iss := range repo.Issues {
			if state != "all" && iss.State != state {
				continue
			}
			var m map[string]any
			_ = json.Unmarshal(issueJSON(repo, iss), &m)
			items = append(items, m)
		}
		if items == nil {
			items = []map[string]any{}
		}
		return map[string]any{"issues": items}, false, ""
	case "create_pull_request":
		if res, isErr, rpcErr := need("owner", "repo", "title", "head", "base"); isErr || rpcErr != "" {
			return res, isErr, rpcErr
		}
		owner, _ := argString(args, "owner")
		nm, _ := argString(args, "repo")
		title, _ := argString(args, "title")
		head, _ := argString(args, "head")
		base, _ := argString(args, "base")
		body, _ := argString(args, "body")
		if i := strings.LastIndex(head, ":"); i >= 0 {
			head = head[i+1:]
		}
		if i := strings.LastIndex(base, ":"); i >= 0 {
			base = base[i+1:]
		}
		db.mu.Lock()
		defer db.mu.Unlock()
		repo := db.repos[owner+"/"+nm]
		if repo == nil {
			return toolError("repository not found: " + owner + "/" + nm)
		}
		headSHA, ok1 := repo.commitAt(head)
		baseSHA, ok2 := repo.commitAt(base)
		if !ok1 || !ok2 {
			return toolError("head or base branch not found")
		}
		num := repo.NextNum
		repo.NextNum++
		pr := &pull{ID: repo.DBID*100000 + num, Number: num, Title: title, Body: body, Head: head, Base: base, State: "open", HeadSHA: headSHA, BaseSHA: baseSHA, CreatedSeq: num}
		repo.Pulls = append(repo.Pulls, pr)
		var out map[string]any
		_ = json.Unmarshal(pullJSON(repo, pr), &out)
		return out, false, ""
	case "merge_pull_request":
		if res, isErr, rpcErr := need("owner", "repo", "pull_number"); isErr || rpcErr != "" {
			return res, isErr, rpcErr
		}
		owner, _ := argString(args, "owner")
		nm, _ := argString(args, "repo")
		num, _ := argNumber(args, "pull_number")
		db.mu.Lock()
		defer db.mu.Unlock()
		repo := db.repos[owner+"/"+nm]
		if repo == nil {
			return toolError("repository not found: " + owner + "/" + nm)
		}
		pr := findPull(repo, num)
		if pr == nil {
			return toolError("pull request not found")
		}
		if pr.State != "open" {
			return toolError("pull request is not open")
		}
		sha, conflict := squashMerge(repo, pr)
		if conflict {
			return toolError("merge conflict")
		}
		return map[string]any{"merged": true, "sha": sha, "message": "Merge pull request #" + strconv.Itoa(pr.Number)}, false, ""
	}
	return nil, false, "unknown tool: " + name
}
