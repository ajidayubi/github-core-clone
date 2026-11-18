// Git smart HTTP: info/refs advertisements, upload-pack v2 (ls-refs, fetch)
// and v0, and receive-pack v0 (push). All state lives in the store.
package main

import (
	"bytes"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

const agentCap = "forge/1.0.0"

func gitHTTP(w http.ResponseWriter, r *http.Request, parts []string) {
	owner, repoName := parts[0], strings.TrimSuffix(parts[1], ".git")
	service := parts[2] // info or git-upload-pack / git-receive-pack
	repo := db.get(owner, repoName)
	if repo == nil {
		writeErr(w, 404, "Not Found")
		return
	}
	if service == "info" && len(parts) == 4 && parts[3] == "refs" {
		svc := r.URL.Query().Get("service")
		if svc == "git-receive-pack" {
			advertiseReceivePack(w, repo)
			return
		}
		advertiseUploadPack(w, repo)
		return
	}
	if service == "git-upload-pack" && r.Method == "POST" {
		uploadPack(w, r, repo)
		return
	}
	if service == "git-receive-pack" && r.Method == "POST" {
		receivePack(w, r, repo)
		return
	}
	writeErr(w, 404, "Not Found")
}

func defaultTip(repo *repo) string {
	return repo.Refs["refs/heads/"+repo.DefaultBranch]
}

// ---------------------------------------------------------------- advertisements

// advertiseUploadPack serves the v2 capability advertisement.
func advertiseUploadPack(w http.ResponseWriter, repo *repo) {
	var buf bytes.Buffer
	buf.Write(pktLine([]byte("# service=git-upload-pack\n")))
	buf.Write(pktFlush())
	buf.Write(pktLine([]byte("version 2\n")))
	buf.Write(pktLine([]byte("agent=" + agentCap + "\n")))
	buf.Write(pktLine([]byte("ls-refs=ref-prefix\n")))
	buf.Write(pktLine([]byte("fetch=shallow thin-pack ofs-delta\n")))
	buf.Write(pktLine([]byte("object-format=sha1\n")))
	buf.Write(pktFlush())
	w.Header().Set("Content-Type", "application/x-git-upload-pack-advertisement")
	w.WriteHeader(200)
	_, _ = w.Write(buf.Bytes())
}

// advertiseReceivePack serves the v0 advertisement for git-receive-pack.
func advertiseReceivePack(w http.ResponseWriter, repo *repo) {
	caps := "report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/" + repo.DefaultBranch + " agent=" + agentCap
	var buf bytes.Buffer
	buf.Write(pktLine([]byte("# service=git-receive-pack\n")))
	buf.Write(pktFlush())
	db.mu.RLock()
	defer db.mu.RUnlock()
	refs := repo.sortedRefs()
	if len(refs) == 0 {
		buf.Write(pktLine([]byte(zeroOID + " capabilities^{}\x00" + caps + "\n")))
	} else {
		for i, ref := range refs {
			oid := repo.Refs[ref]
			line := oid + " " + ref
			if i == 0 {
				line += "\x00" + caps
			}
			buf.Write(pktLine([]byte(line + "\n")))
		}
	}
	buf.Write(pktFlush())
	w.Header().Set("Content-Type", "application/x-git-receive-pack-advertisement")
	w.WriteHeader(200)
	_, _ = w.Write(buf.Bytes())
}

// ---------------------------------------------------------------- upload-pack

func uploadPack(w http.ResponseWriter, r *http.Request, repo *repo) {
	body, err := readBody(r, 64<<20)
	if err != nil {
		writeErr(w, 400, "read error")
		return
	}
	pkts, _, err := decodePktLines(body)
	if err != nil || len(pkts) == 0 || pkts[0].kind != 'd' {
		// Malformed body: do not crash; answer 400 and stay up.
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(400)
		_, _ = w.Write([]byte("bad pkt-line\n"))
		return
	}
	first := string(pkts[0].data)
	if strings.HasPrefix(first, "command=ls-refs") {
		lsRefsV2(w, r, repo, pkts)
		return
	}
	if strings.HasPrefix(first, "command=fetch") {
		fetchV2(w, r, repo, pkts)
		return
	}
	if strings.HasPrefix(first, "want ") {
		fetchV0(w, r, repo, pkts, body)
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(400)
	_, _ = w.Write([]byte("unknown command\n"))
}

// lsRefsV2 answers a v2 ls-refs command.
func lsRefsV2(w http.ResponseWriter, r *http.Request, repo *repo, pkts []pkt) {
	var prefixes []string
	peel, symrefs := false, false
	for _, p := range pkts {
		if p.kind != 'd' {
			continue
		}
		line := strings.TrimSuffix(string(p.data), "\n")
		switch {
		case line == "peel":
			peel = true
		case line == "symrefs":
			symrefs = true
		case strings.HasPrefix(line, "ref-prefix "):
			prefixes = append(prefixes, strings.TrimPrefix(line, "ref-prefix "))
		}
	}
	keep := func(name string) bool {
		if len(prefixes) == 0 {
			return true
		}
		for _, pre := range prefixes {
			if strings.HasPrefix(name, pre) {
				return true
			}
		}
		return false
	}
	var buf bytes.Buffer
	db.mu.RLock()
	defer db.mu.RUnlock()
	tip := defaultTip(repo)
	if len(prefixes) == 0 && tip != "" && symrefs {
		buf.Write(pktLine([]byte(tip + " HEAD symref-target:refs/heads/" + repo.DefaultBranch + "\n")))
	}
	for _, ref := range repo.sortedRefs() {
		if !keep(ref) {
			continue
		}
		oid := repo.Refs[ref]
		line := oid + " " + ref
		if peel {
			if o := repo.Objects[oid]; o != nil && o.typ == "tag" {
				if tv, err := parseTag(o.data); err == nil && tv.typ == "commit" {
					line += " peeled:" + tv.object
				}
			}
		}
		buf.Write(pktLine([]byte(line + "\n")))
	}
	buf.Write(pktFlush())
	w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
	w.WriteHeader(200)
	_, _ = w.Write(buf.Bytes())
}

// fetchV2 answers a v2 fetch command.
func fetchV2(w http.ResponseWriter, r *http.Request, repo *repo, pkts []pkt) {
	var wants, haves, shallowIn []string
	depth := 0
	for _, p := range pkts {
		if p.kind != 'd' {
			continue
		}
		line := strings.TrimSuffix(string(p.data), "\n")
		switch {
		case strings.HasPrefix(line, "want "):
			wants = append(wants, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "have "):
			haves = append(haves, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "shallow "):
			shallowIn = append(shallowIn, strings.TrimSpace(line[8:]))
		case strings.HasPrefix(line, "deepen "):
			fmt.Sscanf(line, "deepen %d", &depth)
		}
	}
	pack, shallowOut, unshallowOut := buildFetch(repo, wants, haves, shallowIn, depth)

	var buf bytes.Buffer
	// Section 1: acknowledgments.
	buf.Write(pktLine([]byte("acknowledgments\n")))
	if len(haves) == 0 {
		buf.Write(pktLine([]byte("NAK\n")))
	} else {
		db.mu.RLock()
		for _, h := range haves {
			if repo.Objects[h] != nil {
				buf.Write(pktLine([]byte("ACK " + h + "\n")))
			}
		}
		db.mu.RUnlock()
		buf.Write(pktLine([]byte("ready\n")))
	}
	if len(shallowOut) > 0 || len(unshallowOut) > 0 {
		buf.Write(pktDelim())
		buf.Write(pktLine([]byte("shallow-info\n")))
		for _, s := range shallowOut {
			buf.Write(pktLine([]byte("shallow " + s + "\n")))
		}
		for _, s := range unshallowOut {
			buf.Write(pktLine([]byte("unshallow " + s + "\n")))
		}
	}
	if len(pack) > 0 {
		buf.Write(pktDelim())
		buf.Write(pktLine([]byte("packfile\n")))
		// Packfile section: sideband band 1, chunked.
		for off := 0; off < len(pack); {
			n := len(pack) - off
			if n > 65515 {
				n = 65515
			}
			chunk := make([]byte, 1+n)
			chunk[0] = 1
			copy(chunk[1:], pack[off:off+n])
			buf.Write(pktLine(chunk))
			off += n
		}
	}
	buf.Write(pktFlush())
	w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
	w.WriteHeader(200)
	_, _ = w.Write(buf.Bytes())
}

// buildFetch computes the pack bytes and shallow-info for a fetch.
// Returns (packBytes, shallowLines, unshallowLines).
func buildFetch(repo *repo, wants, haves, shallowIn []string, depth int) ([]byte, []string, []string) {
	key := strings.Join(wants, ",") + "|" + strings.Join(haves, ",") + "|" + strings.Join(shallowIn, ",") + "|" + fmt.Sprint(depth)
	db.mu.RLock()
	if cached, ok := repo.PackCache["fetch:"+key]; ok {
		_, sh, un := shallowLines(repo, wants, haves, shallowIn, depth)
		db.mu.RUnlock()
		return cached, sh, un
	}
	db.mu.RUnlock()

	db.mu.RLock()
	wantSet := repo.reachable(wants, depth)
	// Haves are held in full — except shallow boundaries, which the client
	// holds only as single commits (their parents are not held).
	cut := make(map[string]bool, len(shallowIn))
	for _, s := range shallowIn {
		cut[s] = true
	}
	haveSet := repo.reachableCut(haves, cut)
	var objs []*packObject
	// Deterministic order: sort oids so identical fetches give identical packs.
	var oids []string
	for oid := range wantSet {
		if !haveSet[oid] {
			oids = append(oids, oid)
		}
	}
	sort.Strings(oids)
	for _, oid := range oids {
		o := repo.Objects[oid]
		if o == nil {
			continue
		}
		objs = append(objs, &packObject{typ: o.typ, data: o.data})
	}
	pack := writePack(objs)
	_, sh, un := shallowLines(repo, wants, haves, shallowIn, depth)
	db.mu.RUnlock()
	db.mu.Lock()
	repo.PackCache["fetch:"+key] = pack
	db.mu.Unlock()
	return pack, sh, un
}

// shallowLines computes the shallow-info section for a fetch.
func shallowLines(repo *repo, wants, haves, shallowIn []string, depth int) (bool, []string, []string) {
	if depth == 0 && len(shallowIn) == 0 {
		return false, nil, nil
	}
	// Boundary commits: included commits whose parent is not included.
	included := repo.reachable(wants, depth)
	var shallow []string
	for _, w := range wants {
		// Walk commits within the depth limit.
		seen := make(map[string]bool)
		var walk func(oid string, gen int)
		walk = func(oid string, gen int) {
			if seen[oid] {
				return
			}
			seen[oid] = true
			o := repo.Objects[oid]
			if o == nil || o.typ != "commit" {
				return
			}
			cv, err := parseCommit(o.data)
			if err != nil {
				return
			}
			for _, p := range cv.parents {
				if !included[p] {
					// This commit is a boundary (parent cut off).
					shallow = append(shallow, oid)
					break
				}
				if depth == 0 || gen+1 < depth {
					walk(p, gen+1)
				}
			}
		}
		walk(w, 1)
	}
	// Deduplicate, keep order.
	seen := make(map[string]bool)
	var sh []string
	for _, s := range shallow {
		if !seen[s] {
			seen[s] = true
			sh = append(sh, s)
		}
	}
	// Unshallow: previous shallow commits that are now fully included (their
	// parents are included too).
	var un []string
	for _, s := range shallowIn {
		if included[s] {
			o := repo.Objects[s]
			if o == nil || o.typ != "commit" {
				continue
			}
			cv, err := parseCommit(o.data)
			if err != nil {
				continue
			}
			allIn := true
			for _, p := range cv.parents {
				if !included[p] {
					allIn = false
				}
			}
			if allIn && len(cv.parents) > 0 {
				un = append(un, s)
			}
		}
	}
	return true, sh, un
}

// fetchV0 answers a v0 fetch (want lines + done).
func fetchV0(w http.ResponseWriter, r *http.Request, repo *repo, pkts []pkt, body []byte) {
	var wants []string
	for _, p := range pkts {
		if p.kind != 'd' {
			continue
		}
		line := strings.TrimSuffix(string(p.data), "\n")
		if strings.HasPrefix(line, "want ") {
			wants = append(wants, strings.Fields(line[5:])[0])
		}
	}
	pack, _, _ := buildFetch(repo, wants, nil, nil, 0)
	var buf bytes.Buffer
	buf.Write(pktLine([]byte("NAK\n")))
	if len(pack) > 0 {
		for off := 0; off < len(pack); {
			n := len(pack) - off
			if n > 65515 {
				n = 65515
			}
			chunk := make([]byte, 1+n)
			chunk[0] = 1
			copy(chunk[1:], pack[off:off+n])
			buf.Write(pktLine(chunk))
			off += n
		}
	}
	buf.Write(pktFlush())
	w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
	w.WriteHeader(200)
	_, _ = w.Write(buf.Bytes())
}

// ---------------------------------------------------------------- receive-pack

type pushCmd struct {
	old, new, ref string
}

func receivePack(w http.ResponseWriter, r *http.Request, repo *repo) {
	body, err := readBody(r, 64<<20)
	if err != nil {
		writeErr(w, 400, "read error")
		return
	}
	pkts, rest, err := decodePktLines(body)
	if err != nil || len(pkts) == 0 {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(400)
		_, _ = w.Write([]byte("bad pkt-line\n"))
		return
	}
	var cmds []pushCmd
	for _, p := range pkts {
		if p.kind != 'd' {
			continue
		}
		line := strings.TrimSuffix(string(p.data), "\n")
		// First line may carry capabilities after NUL.
		if i := strings.IndexByte(line, 0); i >= 0 {
			line = line[:i]
		}
		fields := strings.Fields(line)
		if len(fields) != 3 {
			continue
		}
		cmds = append(cmds, pushCmd{old: fields[0], new: fields[1], ref: fields[2]})
	}
	db.mu.Lock()
	defer db.mu.Unlock()

	// Store pack objects (if any). rest holds the raw packfile.
	if len(rest) > 0 {
		objects, err := readPack(rest, func(oid string) *packObject {
			if o := repo.Objects[oid]; o != nil {
				return &packObject{typ: o.typ, data: o.data}
			}
			return nil
		})
		if err == nil {
			for oid, o := range objects {
				if _, ok := repo.Objects[oid]; !ok {
					repo.Objects[oid] = &obj{typ: o.typ, data: o.data}
				}
			}
		}
	}

	var report bytes.Buffer
	report.Write(pktLine(append([]byte{1}, []byte("unpack ok\n")...)))
	for _, c := range cmds {
		cur, exists := repo.Refs[c.ref]
		if !exists {
			cur = zeroOID
		}
		ok := true
		reason := ""
		switch {
		case c.old != cur:
			ok = false
			reason = "stale ref"
		case c.new == zeroOID:
			// delete
		case c.old == zeroOID:
			// create: new must exist
			if repo.Objects[c.new] == nil {
				ok = false
				reason = "object not found"
			}
		default:
			if !repo.isAncestor(c.old, c.new) {
				ok = false
				reason = "non-fast-forward"
			}
		}
		if ok {
			if c.new == zeroOID {
				delete(repo.Refs, c.ref)
			} else {
				if _, seen := repo.Refs[c.ref]; !seen {
					repo.RefOrder = append(repo.RefOrder, c.ref)
				}
				repo.Refs[c.ref] = c.new
			}
			report.Write(pktLine(append([]byte{1}, []byte("ok "+c.ref+"\n")...)))
		} else {
			report.Write(pktLine(append([]byte{1}, []byte("ng "+c.ref+" "+reason+"\n")...)))
		}
	}
	repo.invalidatePackCache()
	report.Write(pktFlush())
	w.Header().Set("Content-Type", "application/x-git-receive-pack-result")
	w.WriteHeader(200)
	_, _ = w.Write(report.Bytes())
}
