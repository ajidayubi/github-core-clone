// GraphQL: a small parser for the fixed documents the suite sends, plus
// resolvers over the same store REST uses. Unknown fields produce HTTP 200
// with an errors array naming the field; unknown repositories give
// data.repository = null with no errors.
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------- tokenizer

type token struct {
	kind string // name, string, int, float, punct, var, eof
	val  string
}

func tokenize(src string) ([]token, error) {
	var out []token
	i := 0
	for i < len(src) {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',':
			i++
		case c == '#':
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case c == '"' || c == '\'':
			// Block strings """...""" are not used by the suite; plain strings only.
			if strings.HasPrefix(src[i:], `"""`) {
				end := strings.Index(src[i+3:], `"""`)
				if end < 0 {
					return nil, fmt.Errorf("unterminated block string")
				}
				out = append(out, token{kind: "string", val: src[i+3 : i+3+end]})
				i += 3 + end + 3
				continue
			}
			j := i + 1
			var sb strings.Builder
			for j < len(src) && src[j] != c {
				if src[j] == '\\' && j+1 < len(src) {
					switch src[j+1] {
					case 'n':
						sb.WriteByte('\n')
					case 't':
						sb.WriteByte('\t')
					case 'r':
						sb.WriteByte('\r')
					case '"':
						sb.WriteByte('"')
					case '\\':
						sb.WriteByte('\\')
					default:
						sb.WriteByte(src[j+1])
					}
					j += 2
					continue
				}
				sb.WriteByte(src[j])
				j++
			}
			if j >= len(src) {
				return nil, fmt.Errorf("unterminated string")
			}
			out = append(out, token{kind: "string", val: sb.String()})
			i = j + 1
		case c == '$':
			j := i + 1
			for j < len(src) && (isNameChar(src[j])) {
				j++
			}
			out = append(out, token{kind: "var", val: src[i+1 : j]})
			i = j
		case c >= '0' && c <= '9' || c == '-':
			j := i
			for j < len(src) && (src[j] >= '0' && src[j] <= '9' || src[j] == '.' || src[j] == 'e' || src[j] == 'E' || src[j] == '+' || src[j] == '-') {
				j++
			}
			v := src[i:j]
			kind := "int"
			if strings.ContainsAny(v, ".eE") {
				kind = "float"
			}
			out = append(out, token{kind: kind, val: v})
			i = j
		case isNameStart(c):
			j := i
			for j < len(src) && isNameChar(src[j]) {
				j++
			}
			out = append(out, token{kind: "name", val: src[i:j]})
			i = j
		case strings.ContainsRune("{}():![]=@.&|", rune(c)):
			if c == '.' && strings.HasPrefix(src[i:], "...") {
				out = append(out, token{kind: "punct", val: "..."})
				i += 3
				continue
			}
			out = append(out, token{kind: "punct", val: string(c)})
			i++
		default:
			return nil, fmt.Errorf("unexpected char %q", c)
		}
	}
	out = append(out, token{kind: "eof"})
	return out, nil
}

func isNameStart(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}
func isNameChar(c byte) bool { return isNameStart(c) || (c >= '0' && c <= '9') }

// ---------------------------------------------------------------- parser

type gqlField struct {
	name     string
	alias    string
	args     map[string]any
	sel      []gqlField
	fragCond string // non-empty for "... on Type" fragments
	fragName string // non-empty for "...Name" fragments
}

type gqlOp struct {
	kind      string // query | mutation
	variables map[string]any
	sel       []gqlField
	fragments map[string][]gqlField
}

type parser struct {
	toks []token
	pos  int
	vars map[string]any
}

func (p *parser) peek() token { return p.toks[p.pos] }
func (p *parser) next() token { t := p.toks[p.pos]; p.pos++; return t }
func (p *parser) expect(v string) error {
	t := p.next()
	if t.val != v {
		return fmt.Errorf("expected %q got %q", v, t.val)
	}
	return nil
}

func parseOperation(src string, vars map[string]any) (*gqlOp, error) {
	toks, err := tokenize(src)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks, vars: vars}
	op := &gqlOp{kind: "query", variables: vars, fragments: map[string][]gqlField{}}
	// Optional "query"/"mutation" keyword, optional name, optional var defs.
	for p.peek().kind == "name" && (p.peek().val == "query" || p.peek().val == "mutation") {
		op.kind = p.next().val
		if p.peek().kind == "name" {
			p.next() // operation name
		}
		if p.peek().val == "(" {
			if err := p.skipVarDefs(); err != nil {
				return nil, err
			}
		}
		break
	}
	if p.peek().val == "{" {
		sel, err := p.parseSelectionSet()
		if err != nil {
			return nil, err
		}
		op.sel = sel
	}
	// Trailing fragment definitions.
	for p.peek().kind == "name" && p.peek().val == "fragment" {
		p.next()
		name := p.next().val
		if err := p.expect("on"); err != nil {
			return nil, err
		}
		p.next() // type condition (kept implicitly by caller)
		sel, err := p.parseSelectionSet()
		if err != nil {
			return nil, err
		}
		op.fragments[name] = sel
	}
	return op, nil
}

func (p *parser) skipVarDefs() error {
	depth := 0
	for {
		t := p.next()
		if t.kind == "eof" {
			return fmt.Errorf("unterminated variable definitions")
		}
		if t.val == "(" || t.val == "[" || t.val == "{" {
			depth++
		} else if t.val == ")" || t.val == "]" || t.val == "}" {
			depth--
			if depth == 0 {
				return nil
			}
		}
	}
}

func (p *parser) parseSelectionSet() ([]gqlField, error) {
	if err := p.expect("{"); err != nil {
		return nil, err
	}
	var out []gqlField
	for p.peek().val != "}" {
		if p.peek().kind == "eof" {
			return nil, fmt.Errorf("unterminated selection set")
		}
		f, err := p.parseField()
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	p.next() // }
	return out, nil
}

func (p *parser) parseField() (gqlField, error) {
	var f gqlField
	t := p.next()
	if t.val == "..." {
		// Fragment spread or inline fragment.
		if p.peek().kind == "name" && p.peek().val == "on" {
			p.next()
			cond := p.next()
			f.fragCond = cond.val
		} else if p.peek().kind == "name" {
			f.fragName = p.next().val
		}
		sel, err := p.parseSelectionSet()
		if err != nil {
			return f, err
		}
		f.sel = sel
		return f, nil
	}
	if t.kind != "name" {
		return f, fmt.Errorf("expected field name, got %q", t.val)
	}
	f.name = t.val
	// alias: name
	if p.peek().val == ":" {
		p.next()
		f.alias = f.name
		f.name = p.next().val
	}
	// arguments
	if p.peek().val == "(" {
		p.next()
		args := map[string]any{}
		for p.peek().val != ")" {
			if p.peek().kind == "eof" {
				return f, fmt.Errorf("unterminated arguments")
			}
			name := p.next().val
			if err := p.expect(":"); err != nil {
				return f, err
			}
			v, err := p.parseValue()
			if err != nil {
				return f, err
			}
			args[name] = v
		}
		p.next() // )
		f.args = args
	}
	// directives: skip @name(...) blocks
	for p.peek().val == "@" {
		p.next()
		p.next() // directive name
		if p.peek().val == "(" {
			p.next()
			depth := 1
			for depth > 0 {
				t := p.next()
				if t.val == "(" {
					depth++
				} else if t.val == ")" {
					depth--
				}
			}
		}
	}
	// nested selection set
	if p.peek().val == "{" {
		sel, err := p.parseSelectionSet()
		if err != nil {
			return f, err
		}
		f.sel = sel
	}
	return f, nil
}

func (p *parser) parseValue() (any, error) {
	t := p.next()
	switch t.kind {
	case "string":
		return t.val, nil
	case "int":
		n, err := strconv.Atoi(t.val)
		if err != nil {
			return nil, err
		}
		return n, nil
	case "float":
		f, err := strconv.ParseFloat(t.val, 64)
		if err != nil {
			return nil, err
		}
		return f, nil
	case "var":
		if v, ok := p.vars[t.val]; ok {
			return v, nil
		}
		return nil, nil
	case "name":
		switch t.val {
		case "true":
			return true, nil
		case "false":
			return false, nil
		case "null":
			return nil, nil
		default:
			return t.val, nil // enum value
		}
	case "punct":
		switch t.val {
		case "[":
			var arr []any
			for p.peek().val != "]" {
				v, err := p.parseValue()
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			p.next()
			if arr == nil {
				arr = []any{}
			}
			return arr, nil
		case "{":
			m := map[string]any{}
			for p.peek().val != "}" {
				k := p.next().val
				if err := p.expect(":"); err != nil {
					return nil, err
				}
				v, err := p.parseValue()
				if err != nil {
					return nil, err
				}
				m[k] = v
			}
			p.next()
			return m, nil
		}
	}
	return nil, fmt.Errorf("unexpected value token %q", t.val)
}

// ---------------------------------------------------------------- execution

type gqlExec struct {
	op     *gqlOp
	errors []map[string]any
}

func (e *gqlExec) errf(format string, args ...any) {
	e.errors = append(e.errors, map[string]any{"message": fmt.Sprintf(format, args...)})
}

func argInt(args map[string]any, k string, def int) int {
	if v, ok := args[k]; ok {
		switch n := v.(type) {
		case int:
			return n
		case float64:
			return int(n)
		case json.Number:
			if i, err := n.Int64(); err == nil {
				return int(i)
			}
		}
	}
	return def
}

func argStr(args map[string]any, k string) string {
	if v, ok := args[k]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// expand resolves fragment spreads against the operation's fragment table.
func (e *gqlExec) expand(sel []gqlField) []gqlField {
	var out []gqlField
	for _, f := range sel {
		if f.fragName != "" {
			if frag, ok := e.op.fragments[f.fragName]; ok {
				out = append(out, e.expand(frag)...)
			}
			continue
		}
		out = append(out, f)
	}
	return out
}

func (e *gqlExec) outName(f gqlField) string {
	if f.alias != "" {
		return f.alias
	}
	return f.name
}

// resolveObject resolves the selection set for a typed parent value.
// parent is one of: "viewer", *repo, *issue, *pull, *commentNode, gqlTypeInfo,
// or a connection value. parentType names the GraphQL type for error text.
func (e *gqlExec) resolveObject(parent any, parentType string, sel []gqlField) map[string]any {
	out := map[string]any{}
	for _, f := range e.expand(sel) {
		if f.fragCond != "" {
			// Inline fragment: only apply when the condition matches the type.
			if f.fragCond != parentType {
				continue
			}
			for k, v := range e.resolveObject(parent, parentType, f.sel) {
				out[k] = v
			}
			continue
		}
		val, ok := e.resolveField(parent, parentType, f)
		if !ok {
			e.errf("Cannot query field \"%s\" on type \"%s\".", f.name, parentType)
			out[e.outName(f)] = nil
			continue
		}
		out[e.outName(f)] = val
	}
	return out
}

func repoGlobalID(r *repo) string { return "R_" + strconv.Itoa(r.DBID) }
func issueGlobalID(r *repo, iss *issue) string {
	return "I_" + strconv.Itoa(r.DBID) + "_" + strconv.Itoa(iss.Number)
}
func pullGlobalID(r *repo, pr *pull) string {
	return "P_" + strconv.Itoa(r.DBID) + "_" + strconv.Itoa(pr.Number)
}

func parseGlobalID(id string) (kind string, dbid, num, cid int, ok bool) {
	parts := strings.Split(id, "_")
	if len(parts) < 2 {
		return "", 0, 0, 0, false
	}
	dbid, err := strconv.Atoi(parts[1])
	if err != nil {
		return "", 0, 0, 0, false
	}
	switch parts[0] {
	case "R":
		return "R", dbid, 0, 0, true
	case "I":
		if len(parts) < 3 {
			return "", 0, 0, 0, false
		}
		num, err = strconv.Atoi(parts[2])
		if err != nil {
			return "", 0, 0, 0, false
		}
		return "I", dbid, num, 0, true
	case "P":
		if len(parts) < 3 {
			return "", 0, 0, 0, false
		}
		num, err = strconv.Atoi(parts[2])
		if err != nil {
			return "", 0, 0, 0, false
		}
		return "P", dbid, num, 0, true
	case "C":
		if len(parts) < 4 {
			return "", 0, 0, 0, false
		}
		num, _ = strconv.Atoi(parts[2])
		cid, _ = strconv.Atoi(parts[3])
		return "C", dbid, num, cid, true
	}
	return "", 0, 0, 0, false
}

func findRepoByDBID(dbid int) *repo {
	db.mu.RLock()
	defer db.mu.RUnlock()
	for _, r := range db.order {
		if r.DBID == dbid {
			return r
		}
	}
	return nil
}

// resolveField returns (value, known). value may itself be a nested object
// (already resolved to map) or a scalar.
func (e *gqlExec) resolveField(parent any, parentType string, f gqlField) (any, bool) {
	switch parentType {
	case "CreateIssuePayload", "CloseIssuePayload", "CreatePullRequestPayload", "MergePullRequestPayload", "AddCommentPayload":
		if payload, ok := parent.(map[string]any); ok {
			return e.resolvePayloadField(payload, f)
		}
		return nil, false
	case "Query":
		return e.resolveQueryField(f)
	case "Mutation":
		return e.resolveMutationField(f)
	case "Viewer":
		if f.name == "login" {
			return viewerLogin, true
		}
		return nil, false
	case "Repository":
		return e.resolveRepoField(parent.(*repo), f)
	case "Issue":
		return e.resolveIssueField(parent.(*issue), f)
	case "PullRequest":
		return e.resolvePullField(parent.(*pull), f)
	case "User":
		if f.name == "login" {
			return viewerLogin, true
		}
		return nil, false
	case "Ref":
		if f.name == "name" {
			if r, ok := parent.(*repo); ok {
				return r.DefaultBranch, true
			}
		}
		return nil, false
	case "Comment":
		if c, ok := parent.(*comment); ok {
			switch f.name {
			case "id":
				return "C_" + strconv.Itoa(c.ID), true
			case "body":
				return c.Body, true
			}
		}
		return nil, false
	case "__Type":
		return e.resolveTypeField(parent.(map[string]any), f)
	}
	return nil, false
}

func (e *gqlExec) resolveQueryField(f gqlField) (any, bool) {
	switch f.name {
	case "viewer":
		if len(f.sel) == 0 {
			return map[string]any{"login": viewerLogin}, true
		}
		return e.resolveObject("viewer", "Viewer", f.sel), true
	case "repository":
		owner := argStr(f.args, "owner")
		name := argStr(f.args, "name")
		db.mu.RLock()
		r := db.repos[owner+"/"+name]
		db.mu.RUnlock()
		if r == nil {
			return nil, true // data.repository = null, no errors
		}
		return e.resolveObject(r, "Repository", f.sel), true
	case "node":
		id := argStr(f.args, "id")
		kind, dbid, num, _, ok := parseGlobalID(id)
		if !ok {
			return nil, true
		}
		r := findRepoByDBID(dbid)
		if r == nil {
			return nil, true
		}
		switch kind {
		case "R":
			return e.resolveObject(r, "Repository", f.sel), true
		case "I":
			iss := findIssue(r, num)
			if iss == nil {
				return nil, true
			}
			return e.resolveObject(iss, "Issue", f.sel), true
		case "P":
			pr := findPull(r, num)
			if pr == nil {
				return nil, true
			}
			return e.resolveObject(pr, "PullRequest", f.sel), true
		}
		return nil, true
	case "__type":
		name := argStr(f.args, "name")
		info := typeInfo(name)
		if info == nil {
			return nil, true
		}
		return e.resolveObject(info, "__Type", f.sel), true
	case "__schema":
		return map[string]any{"queryType": map[string]any{"name": "Query"}}, true
	}
	return nil, false
}

// typeInfo returns a minimal introspection record for the named type.
func typeInfo(name string) map[string]any {
	fields := func(names ...string) []map[string]any {
		var out []map[string]any
		for _, n := range names {
			out = append(out, map[string]any{"name": n})
		}
		return out
	}
	switch name {
	case "Issue":
		return map[string]any{"name": "Issue", "kind": "OBJECT", "fields": fields("id", "number", "title", "state", "body")}
	case "PullRequest":
		return map[string]any{"name": "PullRequest", "kind": "OBJECT", "fields": fields("id", "number", "headRefName", "baseRefName", "mergeable", "state", "merged", "files", "title", "body")}
	case "Repository":
		return map[string]any{"name": "Repository", "kind": "OBJECT", "fields": fields("id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest")}
	case "SearchType":
		return map[string]any{"name": "SearchType", "kind": "ENUM", "enumValues": []map[string]any{{"name": "ISSUE"}, {"name": "REPOSITORY"}, {"name": "USER"}}}
	case "Query":
		return map[string]any{"name": "Query", "kind": "OBJECT", "fields": fields("viewer", "repository", "node")}
	case "Viewer":
		return map[string]any{"name": "Viewer", "kind": "OBJECT", "fields": fields("login")}
	}
	return nil
}

func (e *gqlExec) resolveTypeField(info map[string]any, f gqlField) (any, bool) {
	switch f.name {
	case "name":
		return info["name"], true
	case "kind":
		return info["kind"], true
	case "fields":
		return info["fields"], true
	case "enumValues":
		if v, ok := info["enumValues"]; ok {
			return v, true
		}
		return nil, true
	}
	return nil, false
}

func (e *gqlExec) resolveRepoField(r *repo, f gqlField) (any, bool) {
	switch f.name {
	case "id":
		return repoGlobalID(r), true
	case "databaseId":
		return r.DBID, true
	case "name":
		return r.Name, true
	case "nameWithOwner":
		return r.Owner + "/" + r.Name, true
	case "owner":
		return e.resolveObject("viewer", "User", f.sel), true
	case "defaultBranchRef":
		return e.resolveObject(r, "Ref", f.sel), true
	case "viewerPermission":
		return "ADMIN", true
	case "hasIssuesEnabled":
		return true, true
	case "issue":
		num := argInt(f.args, "number", 0)
		iss := findIssue(r, num)
		if iss == nil {
			return nil, true
		}
		return e.resolveObject(iss, "Issue", f.sel), true
	case "issues":
		return e.issuesConnection(r, f), true
	case "pullRequests":
		return e.pullsConnection(r, f), true
	case "pullRequest":
		num := argInt(f.args, "number", 0)
		pr := findPull(r, num)
		if pr == nil {
			return nil, true
		}
		return e.resolveObject(pr, "PullRequest", f.sel), true
	}
	return nil, false
}

func (e *gqlExec) issuesConnection(r *repo, f gqlField) any {
	first := argInt(f.args, "first", 100)
	after := argStr(f.args, "after")
	var states []string
	if v, ok := f.args["states"]; ok {
		if arr, ok := v.([]any); ok {
			for _, s := range arr {
				if str, ok := s.(string); ok {
					states = append(states, str)
				}
			}
		}
	}
	desc := false
	if v, ok := f.args["orderBy"]; ok {
		if m, ok := v.(map[string]any); ok {
			if d, ok := m["direction"].(string); ok && d == "DESC" {
				desc = true
			}
		}
	}
	db.mu.RLock()
	defer db.mu.RUnlock()
	var list []*issue
	for _, iss := range r.Issues {
		if len(states) > 0 {
			want := false
			for _, s := range states {
				if (s == "OPEN" && iss.State == "open") || (s == "CLOSED" && iss.State == "closed") {
					want = true
				}
			}
			if !want {
				continue
			}
		}
		list = append(list, iss)
	}
	if desc {
		sort.Slice(list, func(i, j int) bool { return list[i].Number > list[j].Number })
	} else {
		sort.Slice(list, func(i, j int) bool { return list[i].Number < list[j].Number })
	}
	// Cursor: base64 of the last seen issue number.
	start := 0
	if after != "" {
		if raw, err := base64.StdEncoding.DecodeString(after); err == nil {
			if n, err := strconv.Atoi(string(raw)); err == nil {
				for i, iss := range list {
					if iss.Number == n {
						start = i + 1
						break
					}
				}
			}
		}
	}
	end := start + first
	if end > len(list) {
		end = len(list)
	}
	page := list[start:end]
	// The node fields live under the `nodes` (or `edges { node }`) subfield.
	nodeSel := []gqlField{}
	for _, sf := range e.expand(f.sel) {
		if sf.name == "nodes" {
			nodeSel = sf.sel
		}
		if sf.name == "edges" {
			for _, ef := range e.expand(sf.sel) {
				if ef.name == "node" {
					nodeSel = ef.sel
				}
			}
		}
	}
	var nodes []any
	for _, iss := range page {
		nodes = append(nodes, e.resolveObject(iss, "Issue", nodeSel))
	}
	if nodes == nil {
		nodes = []any{}
	}
	var endCursor string
	if len(page) > 0 {
		endCursor = base64.StdEncoding.EncodeToString([]byte(strconv.Itoa(page[len(page)-1].Number)))
	}
	// The connection object itself: resolve its subfields (nodes, pageInfo).
	out := map[string]any{}
	for _, sf := range e.expand(f.sel) {
		switch sf.name {
		case "nodes":
			out["nodes"] = nodes
		case "edges":
			var edges []any
			for _, n := range nodes {
				edges = append(edges, map[string]any{"node": n})
			}
			out["edges"] = edges
		case "totalCount":
			out["totalCount"] = len(list)
		case "pageInfo":
			out["pageInfo"] = map[string]any{
				"hasNextPage":     end < len(list),
				"hasPreviousPage": start > 0,
				"endCursor":       endCursor,
			}
		}
	}
	return out
}

func (e *gqlExec) pullsConnection(r *repo, f gqlField) any {
	first := argInt(f.args, "first", 100)
	db.mu.RLock()
	defer db.mu.RUnlock()
	var list []*pull
	for _, pr := range r.Pulls {
		list = append(list, pr)
	}
	if first < len(list) {
		list = list[:first]
	}
	nodeSel := []gqlField{}
	for _, sf := range e.expand(f.sel) {
		if sf.name == "nodes" {
			nodeSel = sf.sel
		}
	}
	var nodes []any
	for _, pr := range list {
		nodes = append(nodes, e.resolveObject(pr, "PullRequest", nodeSel))
	}
	if nodes == nil {
		nodes = []any{}
	}
	out := map[string]any{}
	for _, sf := range e.expand(f.sel) {
		switch sf.name {
		case "nodes":
			out["nodes"] = nodes
		case "totalCount":
			out["totalCount"] = len(r.Pulls)
		case "pageInfo":
			out["pageInfo"] = map[string]any{"hasNextPage": false, "endCursor": ""}
		}
	}
	return out
}

func (e *gqlExec) resolveIssueField(iss *issue, f gqlField) (any, bool) {
	switch f.name {
	case "id":
		// Global id needs the repo; find it by scanning (id embeds dbid).
		return "I_" + strconv.Itoa(iss.ID/100000) + "_" + strconv.Itoa(iss.Number), true
	case "number":
		return iss.Number, true
	case "title":
		return iss.Title, true
	case "state":
		if iss.State == "closed" {
			return "CLOSED", true
		}
		return "OPEN", true
	case "body":
		return iss.Body, true
	}
	return nil, false
}

func (e *gqlExec) resolvePullField(pr *pull, f gqlField) (any, bool) {
	switch f.name {
	case "id":
		return "P_" + strconv.Itoa(pr.ID/100000) + "_" + strconv.Itoa(pr.Number), true
	case "number":
		return pr.Number, true
	case "title":
		return pr.Title, true
	case "body":
		return pr.Body, true
	case "state":
		if pr.Merged {
			return "MERGED", true
		}
		if pr.State == "closed" {
			return "CLOSED", true
		}
		return "OPEN", true
	case "merged":
		return pr.Merged, true
	case "headRefName":
		return pr.Head, true
	case "baseRefName":
		return pr.Base, true
	case "mergeable":
		// Resolve via the repo: find it by dbid embedded in the pull id.
		r := findRepoByDBID(pr.ID / 100000)
		if r == nil {
			return "UNKNOWN", true
		}
		db.mu.RLock()
		defer db.mu.RUnlock()
		headSHA, ok1 := r.commitAt(pr.Head)
		baseSHA, ok2 := r.commitAt(pr.Base)
		if !ok1 || !ok2 || pr.State != "open" {
			return "UNKNOWN", true
		}
		if _, conflict := checkMergeConflict(r, headSHA, baseSHA); conflict {
			return "CONFLICTING", true
		}
		return "MERGEABLE", true
	case "files":
		r := findRepoByDBID(pr.ID / 100000)
		if r == nil {
			return map[string]any{"nodes": []any{}}, true
		}
		db.mu.RLock()
		headSHA, _ := r.commitAt(pr.Head)
		baseSHA, _ := r.commitAt(pr.Base)
		changes := r.diffFiles(r.treeOIDOf(baseSHA), r.treeOIDOf(headSHA))
		db.mu.RUnlock()
		first := argInt(f.args, "first", 100)
		var nodes []any
		for i, c := range changes {
			if i >= first {
				break
			}
			nodes = append(nodes, map[string]any{"path": c.Filename})
		}
		if nodes == nil {
			nodes = []any{}
		}
		return map[string]any{"nodes": nodes}, true
	}
	return nil, false
}

// checkMergeConflict reports whether merging head onto base would conflict.
func checkMergeConflict(r *repo, headSHA, baseSHA string) (string, bool) {
	mb := r.mergeBase(baseSHA, headSHA)
	baseFlat := r.flattenTree(r.treeOIDOf(baseSHA))
	headFlat := r.flattenTree(r.treeOIDOf(headSHA))
	mbFlat := map[string]string{}
	if mb != "" {
		mbFlat = r.flattenTree(r.treeOIDOf(mb))
	}
	paths := make(map[string]bool)
	for p := range mbFlat {
		paths[p] = true
	}
	for p := range headFlat {
		paths[p] = true
	}
	for p := range baseFlat {
		paths[p] = true
	}
	for p := range paths {
		if headFlat[p] != mbFlat[p] && baseFlat[p] != mbFlat[p] && headFlat[p] != baseFlat[p] {
			return "", true
		}
	}
	return "", false
}

// ---------------------------------------------------------------- mutations

func (e *gqlExec) resolveMutationField(f gqlField) (any, bool) {
	input, _ := f.args["input"].(map[string]any)
	switch f.name {
	case "createIssue":
		repoID := argStr(input, "repositoryId")
		_, dbid, _, _, ok := parseGlobalID(repoID)
		if !ok {
			e.errf("repository not found: %s", repoID)
			return nil, true
		}
		r := findRepoByDBID(dbid)
		if r == nil {
			e.errf("repository not found: %s", repoID)
			return nil, true
		}
		db.mu.Lock()
		num := r.NextNum
		r.NextNum++
		iss := &issue{ID: r.DBID*100000 + num, Number: num, Title: argStr(input, "title"), Body: argStr(input, "body"), State: "open", CreatedSeq: num}
		r.Issues = append(r.Issues, iss)
		db.mu.Unlock()
		return e.resolveObject(map[string]any{"issue": iss, "repo": r}, "CreateIssuePayload", f.sel), true
	case "closeIssue":
		issueID := argStr(input, "issueId")
		_, dbid, num, _, ok := parseGlobalID(issueID)
		if !ok {
			e.errf("issue not found: %s", issueID)
			return nil, true
		}
		r := findRepoByDBID(dbid)
		if r == nil {
			e.errf("issue not found: %s", issueID)
			return nil, true
		}
		db.mu.Lock()
		iss := findIssue(r, num)
		if iss == nil {
			db.mu.Unlock()
			e.errf("issue not found: %s", issueID)
			return nil, true
		}
		iss.State = "closed"
		iss.invalidateJSON()
		db.mu.Unlock()
		return e.resolveObject(map[string]any{"issue": iss, "repo": r}, "CloseIssuePayload", f.sel), true
	case "createPullRequest":
		repoID := argStr(input, "repositoryId")
		_, dbid, _, _, ok := parseGlobalID(repoID)
		if !ok {
			e.errf("repository not found: %s", repoID)
			return nil, true
		}
		r := findRepoByDBID(dbid)
		if r == nil {
			e.errf("repository not found: %s", repoID)
			return nil, true
		}
		head := argStr(input, "headRefName")
		base := argStr(input, "baseRefName")
		db.mu.Lock()
		headSHA, ok1 := r.commitAt(head)
		baseSHA, ok2 := r.commitAt(base)
		if !ok1 || !ok2 {
			db.mu.Unlock()
			e.errf("head or base branch not found")
			return nil, true
		}
		num := r.NextNum
		r.NextNum++
		pr := &pull{ID: r.DBID*100000 + num, Number: num, Title: argStr(input, "title"), Body: argStr(input, "body"), Head: head, Base: base, State: "open", HeadSHA: headSHA, BaseSHA: baseSHA, CreatedSeq: num}
		r.Pulls = append(r.Pulls, pr)
		db.mu.Unlock()
		return e.resolveObject(map[string]any{"pullRequest": pr, "repo": r}, "CreatePullRequestPayload", f.sel), true
	case "mergePullRequest":
		prID := argStr(input, "pullRequestId")
		_, dbid, num, _, ok := parseGlobalID(prID)
		if !ok {
			e.errf("pull request not found: %s", prID)
			return nil, true
		}
		r := findRepoByDBID(dbid)
		if r == nil {
			e.errf("pull request not found: %s", prID)
			return nil, true
		}
		db.mu.Lock()
		pr := findPull(r, num)
		if pr == nil || pr.State != "open" {
			db.mu.Unlock()
			e.errf("pull request not found: %s", prID)
			return nil, true
		}
		if _, conflict := squashMerge(r, pr); conflict {
			db.mu.Unlock()
			e.errf("merge conflict")
			return nil, true
		}
		db.mu.Unlock()
		return e.resolveObject(map[string]any{"pullRequest": pr, "repo": r}, "MergePullRequestPayload", f.sel), true
	case "addComment":
		subjectID := argStr(input, "subjectId")
		_, dbid, num, _, ok := parseGlobalID(subjectID)
		if !ok {
			e.errf("subject not found: %s", subjectID)
			return nil, true
		}
		r := findRepoByDBID(dbid)
		if r == nil {
			e.errf("subject not found: %s", subjectID)
			return nil, true
		}
		db.mu.Lock()
		iss := findIssue(r, num)
		if iss == nil {
			db.mu.Unlock()
			e.errf("subject not found: %s", subjectID)
			return nil, true
		}
		c := &comment{ID: r.NextCommentID, Body: argStr(input, "body")}
		r.NextCommentID++
		iss.Comments = append(iss.Comments, c)
		db.mu.Unlock()
		return e.resolveObject(map[string]any{"comment": c, "repo": r}, "AddCommentPayload", f.sel), true
	}
	return nil, false
}

// resolveObject for mutation payloads: the payload is a map with the created
// object under its field name.
func (e *gqlExec) resolvePayloadField(payload map[string]any, f gqlField) (any, bool) {
	switch f.name {
	case "issue":
		if iss, ok := payload["issue"].(*issue); ok {
			r := payload["repo"].(*repo)
			_ = r
			return e.resolveObject(iss, "Issue", f.sel), true
		}
	case "pullRequest":
		if pr, ok := payload["pullRequest"].(*pull); ok {
			return e.resolveObject(pr, "PullRequest", f.sel), true
		}
	case "commentEdge":
		if c, ok := payload["comment"].(*comment); ok {
			// commentEdge { node { id body } }
			node := map[string]any{}
			for _, sf := range e.expand(f.sel) {
				if sf.name == "node" {
					node = e.resolveObject(c, "Comment", sf.sel)
				}
			}
			return map[string]any{"node": node}, true
		}
	}
	return nil, false
}

// ---------------------------------------------------------------- HTTP entry

func graphqlHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeErr(w, 404, "Not Found")
		return
	}
	body, err := readBody(r, 16<<20)
	if err != nil {
		writeErr(w, 400, "read error")
		return
	}
	// Batched operations: a JSON array.
	var batch []json.RawMessage
	isBatch := false
	trimmed := strings.TrimSpace(string(body))
	if strings.HasPrefix(trimmed, "[") {
		if err := json.Unmarshal(body, &batch); err != nil {
			writeErr(w, 400, "Invalid JSON")
			return
		}
		isBatch = true
	}
	runOne := func(raw json.RawMessage) map[string]any {
		var req struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			return map[string]any{"errors": []map[string]any{{"message": "Invalid JSON"}}}
		}
		if req.Variables == nil {
			req.Variables = map[string]any{}
		}
		op, err := parseOperation(req.Query, req.Variables)
		if err != nil {
			return map[string]any{"errors": []map[string]any{{"message": err.Error()}}}
		}
		e := &gqlExec{op: op}
		rootType := "Query"
		if op.kind == "mutation" {
			rootType = "Mutation"
		}
		data := map[string]any{}
		for _, f := range e.expand(op.sel) {
			val, ok := e.resolveField(nil, rootType, f)
			if !ok {
				e.errf("Cannot query field \"%s\" on type \"%s\".", f.name, rootType)
				data[e.outName(f)] = nil
				continue
			}
			data[e.outName(f)] = val
		}
		res := map[string]any{"data": data}
		if len(e.errors) > 0 {
			res["errors"] = e.errors
		}
		return res
	}
	if isBatch {
		var results []map[string]any
		for _, raw := range batch {
			results = append(results, runOne(raw))
		}
		writeJSON(w, 200, results)
		return
	}
	writeJSON(w, 200, runOne(body))
}
