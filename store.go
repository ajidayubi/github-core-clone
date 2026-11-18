// In-memory store: repositories, issues, pull requests, labels, comments, and
// the git object store they all share. One global RWMutex guards everything;
// reads take the read lock, mutations the write lock.
//
// Determinism: every timestamp comes from fixedNow (MAKEFUN_TRIAL_NOW or a
// fixed fallback), every id is a sequential counter. Map iteration order is
// never allowed to leak into a response — lists are built from ordered slices.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

var (
	viewerLogin = "adaiversen"
	viewerID    = 1000
	fixedNow    = "2026-11-14T06:30:00Z"
	shopToken   = ""
	reqCounter  uint64
	commitSeq   uint64
)

func initStore() {
	if v := os.Getenv("MAKEFUN_VIEWER_LOGIN"); v != "" {
		viewerLogin = v
	}
	if v := os.Getenv("MAKEFUN_TRIAL_NOW"); v != "" {
		fixedNow = v
	}
	shopToken = os.Getenv("MAKEFUN_SHOP_TOKEN")
}

func nowStr() string { return fixedNow }

func nextReqID() string {
	return "req-" + strconv.FormatUint(atomic.AddUint64(&reqCounter, 1), 10)
}

// commitIdent is the deterministic author/committer identity for commits the
// forge creates itself (contents writes, squash merges).
func commitIdent() string {
	// Fixed base epoch plus a per-commit second, so timestamps stay ordered
	// and reproducible.
	seq := atomic.AddUint64(&commitSeq, 1)
	return fmt.Sprintf("%s <%s@example.invalid> %d +0000", viewerLogin, viewerLogin, 1790000000+int(seq))
}

type obj struct {
	typ  string
	data []byte
}

type label struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

type comment struct {
	ID   int
	Body string
}

type issue struct {
	ID         int
	Number     int
	Title      string
	Body       string
	State      string // "open" | "closed"
	Labels     []string
	Comments   []*comment
	CreatedSeq int
	jsonCache  []byte
}

type pull struct {
	ID         int
	Number     int
	Title      string
	Body       string
	Head       string // branch name
	Base       string // branch name
	State      string // "open" | "closed"
	Merged     bool
	MergedAt   string
	MergeSHA   string
	HeadSHA    string // captured at creation
	BaseSHA    string // captured at creation
	CreatedSeq int
}

type repo struct {
	Owner         string
	Name          string
	Description   string
	Private       bool
	DBID          int
	DefaultBranch string
	Refs          map[string]string // full ref -> oid
	RefOrder      []string
	Objects       map[string]*obj // oid -> object
	Labels        map[string]*label
	LabelOrder    []string
	Issues        []*issue
	Pulls         []*pull
	NextNum       int // shared issue/PR number counter
	NextCommentID int
	Seq           int // creation order within the store
	PackCache     map[string][]byte
}

type store struct {
	mu     sync.RWMutex
	repos  map[string]*repo // owner + "/" + name -> repo
	order  []*repo          // creation order
	nextID int
}

var db = &store{repos: make(map[string]*repo), nextID: 5000}

func (s *store) get(owner, name string) *repo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.repos[owner+"/"+name]
}

func (s *store) create(owner, name, desc string, priv bool) (*repo, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := owner + "/" + name
	if _, ok := s.repos[key]; ok {
		return nil, false
	}
	r := &repo{
		Owner:         owner,
		Name:          name,
		Description:   desc,
		Private:       priv,
		DBID:          s.nextID,
		DefaultBranch: "main",
		Refs:          make(map[string]string),
		Objects:       make(map[string]*obj),
		Labels:        make(map[string]*label),
		NextNum:       1,
		NextCommentID: 1,
		Seq:           len(s.order),
		PackCache:     make(map[string][]byte),
	}
	s.nextID++
	s.repos[key] = r
	s.order = append(s.order, r)
	return r, true
}

func (s *store) delete(owner, name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := owner + "/" + name
	if _, ok := s.repos[key]; !ok {
		return false
	}
	delete(s.repos, key)
	for i, r := range s.order {
		if r.Owner == owner && r.Name == name {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
	return true
}

func (s *store) listByOwner(owner string) []*repo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*repo
	for _, r := range s.order {
		if r.Owner == owner {
			out = append(out, r)
		}
	}
	return out
}

// ---------------------------------------------------------------- git helpers

// getObj returns the object, or nil.
func (r *repo) getObj(oid string) *obj {
	return r.Objects[oid]
}

func (r *repo) putObj(typ string, data []byte) string {
	oid := hashObject(typ, data)
	if _, ok := r.Objects[oid]; !ok {
		r.Objects[oid] = &obj{typ: typ, data: data}
	}
	return oid
}

// commitAt resolves a ref name or oid to a commit oid.
func (r *repo) commitAt(ref string) (string, bool) {
	if isOID(ref) {
		if o := r.Objects[ref]; o != nil && o.typ == "commit" {
			return ref, true
		}
		if o := r.Objects[ref]; o != nil && o.typ == "tag" {
			if tv, err := parseTag(o.data); err == nil {
				return tv.object, true
			}
		}
		return "", false
	}
	oid, ok := r.Refs["refs/heads/"+ref]
	if !ok {
		oid, ok = r.Refs[ref]
	}
	if !ok {
		return "", false
	}
	if o := r.Objects[oid]; o != nil && o.typ == "tag" {
		if tv, err := parseTag(o.data); err == nil {
			return tv.object, true
		}
	}
	return oid, true
}

// reachableCut walks commits from roots, including each root's trees and
// blobs, but never descends past a commit in cut: a shallow boundary the
// client holds only as a single commit, not its history.
func (r *repo) reachableCut(roots []string, cut map[string]bool) map[string]bool {
	out := make(map[string]bool)
	var walkTree func(oid string)
	walkTree = func(oid string) {
		if out[oid] {
			return
		}
		o := r.Objects[oid]
		if o == nil || o.typ != "tree" {
			return
		}
		out[oid] = true
		entries, err := parseTree(o.data)
		if err != nil {
			return
		}
		for _, e := range entries {
			if e.mode == "40000" {
				walkTree(e.oid)
			} else {
				out[e.oid] = true
			}
		}
	}
	var walkCommit func(oid string)
	walkCommit = func(oid string) {
		if out[oid] {
			return
		}
		o := r.Objects[oid]
		if o == nil {
			return
		}
		if o.typ == "tag" {
			out[oid] = true
			if tv, err := parseTag(o.data); err == nil && tv.typ == "commit" {
				walkCommit(tv.object)
			}
			return
		}
		if o.typ != "commit" {
			return
		}
		out[oid] = true
		cv, err := parseCommit(o.data)
		if err != nil {
			return
		}
		walkTree(cv.tree)
		if cut[oid] {
			return
		}
		for _, p := range cv.parents {
			walkCommit(p)
		}
	}
	for _, root := range roots {
		walkCommit(root)
	}
	return out
}

// reachable walks commits (bounded by depth generations when depth > 0),
// their trees and blobs, and annotated tags. depth counts generations from
// each root: 1 means only the root commits themselves.
func (r *repo) reachable(roots []string, depth int) map[string]bool {
	out := make(map[string]bool)
	var walkCommit func(oid string, gen int)
	var walkTree func(oid string)
	walkTree = func(oid string) {
		if out[oid] {
			return
		}
		o := r.Objects[oid]
		if o == nil || o.typ != "tree" {
			return
		}
		out[oid] = true
		entries, err := parseTree(o.data)
		if err != nil {
			return
		}
		for _, e := range entries {
			if e.mode == "40000" {
				walkTree(e.oid)
			} else {
				out[e.oid] = true
			}
		}
	}
	walkCommit = func(oid string, gen int) {
		if out[oid] {
			return
		}
		o := r.Objects[oid]
		if o == nil {
			return
		}
		if o.typ == "tag" {
			out[oid] = true
			if tv, err := parseTag(o.data); err == nil && tv.typ == "commit" {
				walkCommit(tv.object, gen)
			}
			return
		}
		if o.typ != "commit" {
			return
		}
		out[oid] = true
		cv, err := parseCommit(o.data)
		if err != nil {
			return
		}
		walkTree(cv.tree)
		if depth <= 0 || gen < depth {
			for _, p := range cv.parents {
				walkCommit(p, gen+1)
			}
		}
	}
	for _, root := range roots {
		walkCommit(root, 1)
	}
	return out
}

// isAncestor reports whether anc is reachable from tip by parent edges.
func (r *repo) isAncestor(anc, tip string) bool {
	if anc == tip {
		return true
	}
	seen := make(map[string]bool)
	stack := []string{tip}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[cur] {
			continue
		}
		seen[cur] = true
		o := r.Objects[cur]
		if o == nil || o.typ != "commit" {
			continue
		}
		cv, err := parseCommit(o.data)
		if err != nil {
			continue
		}
		for _, p := range cv.parents {
			if p == anc {
				return true
			}
			stack = append(stack, p)
		}
	}
	return false
}

// mergeBase finds the newest common ancestor commit of a and b (BFS from both).
func (r *repo) mergeBase(a, b string) string {
	if a == "" || b == "" {
		return ""
	}
	// Collect ancestors of a with generation numbers.
	gen := make(map[string]int)
	queue := []string{a}
	gen[a] = 0
	for i := 0; i < len(queue); i++ {
		cur := queue[i]
		o := r.Objects[cur]
		if o == nil || o.typ != "commit" {
			continue
		}
		cv, err := parseCommit(o.data)
		if err != nil {
			continue
		}
		for _, p := range cv.parents {
			if _, ok := gen[p]; !ok {
				gen[p] = gen[cur] + 1
				queue = append(queue, p)
			}
		}
	}
	// Walk b's ancestry, return the first commit also in a's set (lowest b-gen).
	best := ""
	bestGen := -1
	seen := make(map[string]bool)
	q := []string{b}
	bgen := map[string]int{b: 0}
	for i := 0; i < len(q); i++ {
		cur := q[i]
		if seen[cur] {
			continue
		}
		seen[cur] = true
		if g, ok := gen[cur]; ok {
			if best == "" || bgen[cur] < bestGen || (bgen[cur] == bestGen && g < gen[best]) {
				best, bestGen = cur, bgen[cur]
			}
		}
		o := r.Objects[cur]
		if o == nil || o.typ != "commit" {
			continue
		}
		cv, err := parseCommit(o.data)
		if err != nil {
			continue
		}
		for _, p := range cv.parents {
			if _, ok := bgen[p]; !ok {
				bgen[p] = bgen[cur] + 1
				q = append(q, p)
			}
		}
	}
	return best
}

// flattenTree returns path -> blob oid for every file under a tree.
func (r *repo) flattenTree(treeOID string) map[string]string {
	out := make(map[string]string)
	var walk func(oid, prefix string)
	walk = func(oid, prefix string) {
		o := r.Objects[oid]
		if o == nil || o.typ != "tree" {
			return
		}
		entries, err := parseTree(o.data)
		if err != nil {
			return
		}
		for _, e := range entries {
			p := prefix + e.name
			if e.mode == "40000" {
				walk(e.oid, p+"/")
			} else {
				out[p] = e.oid
			}
		}
	}
	walk(treeOID, "")
	return out
}

// buildTreeFromFlat materialises a tree hierarchy for a flat path->blob map
// and returns the root tree oid. Missing intermediate trees are created.
func (r *repo) buildTreeFromFlat(flat map[string]string) string {
	var build func(m map[string]string) string
	build = func(m map[string]string) string {
		groups := make(map[string]map[string]string)
		var dirNames []string
		var entries []treeEntry
		for p, oid := range m {
			if i := strings.IndexByte(p, '/'); i >= 0 {
				seg := p[:i]
				if groups[seg] == nil {
					groups[seg] = make(map[string]string)
					dirNames = append(dirNames, seg)
				}
				groups[seg][p[i+1:]] = oid
			} else {
				entries = append(entries, treeEntry{mode: "100644", name: p, oid: oid})
			}
		}
		sort.Strings(dirNames)
		for _, d := range dirNames {
			entries = append(entries, treeEntry{mode: "40000", name: d, oid: build(groups[d])})
		}
		return r.putObj("tree", buildTree(entries))
	}
	if len(flat) == 0 {
		return r.putObj("tree", buildTree(nil))
	}
	return build(flat)
}

// treeOIDOf returns the tree oid of a commit, or "".
func (r *repo) treeOIDOf(commitOID string) string {
	o := r.Objects[commitOID]
	if o == nil || o.typ != "commit" {
		return ""
	}
	cv, err := parseCommit(o.data)
	if err != nil {
		return ""
	}
	return cv.tree
}

// makeCommit creates a commit object (and stores it) on top of parents.
func (r *repo) makeCommit(treeOID string, parents []string, message string) string {
	data := buildCommit(treeOID, parents, commitIdent(), message)
	return r.putObj("commit", data)
}

// invalidatePackCache drops cached pack bytes for this repo.
func (r *repo) invalidatePackCache() { r.PackCache = make(map[string][]byte) }

// sortedRefs returns ref names in a stable order: HEAD's default branch first,
// then the rest sorted.
func (r *repo) sortedRefs() []string {
	names := make([]string, 0, len(r.Refs))
	for name := range r.Refs {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ---------------------------------------------------------------- JSON shapes

func repoJSON(r *repo) []byte {
	m := map[string]any{
		"id":             r.DBID,
		"name":           r.Name,
		"full_name":      r.Owner + "/" + r.Name,
		"owner":          map[string]any{"login": r.Owner, "id": viewerID},
		"private":        r.Private,
		"description":    r.Description,
		"default_branch": r.DefaultBranch,
		"created_at":     fixedNow,
		"updated_at":     fixedNow,
		"html_url":       "https://example.invalid/" + r.Owner + "/" + r.Name,
		"url":            "https://example.invalid/api/v3/repos/" + r.Owner + "/" + r.Name,
		"clone_url":      "https://example.invalid/" + r.Owner + "/" + r.Name + ".git",
	}
	b, _ := json.Marshal(m)
	return b
}

func issueJSON(r *repo, iss *issue) []byte {
	if iss.jsonCache != nil {
		return iss.jsonCache
	}
	var labels []map[string]any
	for _, ln := range iss.Labels {
		if lb, ok := r.Labels[ln]; ok {
			labels = append(labels, map[string]any{"name": lb.Name, "color": lb.Color})
		}
	}
	if labels == nil {
		labels = []map[string]any{}
	}
	m := map[string]any{
		"id":         iss.ID,
		"number":     iss.Number,
		"title":      iss.Title,
		"body":       iss.Body,
		"state":      iss.State,
		"labels":     labels,
		"created_at": fixedNow,
		"updated_at": fixedNow,
		"user":       map[string]any{"login": viewerLogin, "id": viewerID},
	}
	b, _ := json.Marshal(m)
	iss.jsonCache = b
	return b
}

func (iss *issue) invalidateJSON() { iss.jsonCache = nil }

func pullJSON(r *repo, p *pull) []byte {
	m := map[string]any{
		"id":     p.ID,
		"number": p.Number,
		"title":  p.Title,
		"body":   p.Body,
		"state":  p.State,
		"merged": p.Merged,
		"head": map[string]any{
			"ref": p.Head,
			"sha": p.HeadSHA,
		},
		"base": map[string]any{
			"ref": p.Base,
			"sha": p.BaseSHA,
		},
		"created_at": fixedNow,
		"updated_at": fixedNow,
	}
	if p.Merged {
		m["merged_at"] = p.MergedAt
		m["merge_commit_sha"] = p.MergeSHA
	}
	b, _ := json.Marshal(m)
	return b
}

// diffFiles computes the file-level diff between two tree oids.
type fileChange struct {
	Filename  string
	Status    string // "added" | "modified" | "removed"
	Additions int
	Deletions int
	Changes   int
}

func (r *repo) diffFiles(baseTree, headTree string) []fileChange {
	base := r.flattenTree(baseTree)
	head := r.flattenTree(headTree)
	paths := make(map[string]bool)
	for p := range base {
		paths[p] = true
	}
	for p := range head {
		paths[p] = true
	}
	var names []string
	for p := range paths {
		names = append(names, p)
	}
	sort.Strings(names)
	var out []fileChange
	for _, p := range names {
		b, inBase := base[p]
		h, inHead := head[p]
		switch {
		case inBase && !inHead:
			out = append(out, fileChange{Filename: p, Status: "removed", Additions: 0, Deletions: 1, Changes: 1})
		case !inBase && inHead:
			out = append(out, fileChange{Filename: p, Status: "added", Additions: 1, Deletions: 0, Changes: 1})
		case b != h:
			// Count changed lines by comparing blob contents.
			add, del := lineDiff(r, b, h)
			out = append(out, fileChange{Filename: p, Status: "modified", Additions: add, Deletions: del, Changes: add + del})
		}
	}
	return out
}

func lineDiff(r *repo, a, b string) (add, del int) {
	ba := r.Objects[a]
	bb := r.Objects[b]
	if ba == nil || bb == nil {
		return 1, 0
	}
	al := bytes.Count(ba.data, []byte("\n"))
	bl := bytes.Count(bb.data, []byte("\n"))
	if al == 0 && len(ba.data) > 0 {
		al = 1
	}
	if bl == 0 && len(bb.data) > 0 {
		bl = 1
	}
	if bl > al {
		add = bl - al
	} else {
		del = al - bl
	}
	if add == 0 && del == 0 {
		add = 1
	}
	return add, del
}

// b64 helpers
func b64decode(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(strings.TrimSpace(s))
}
func b64encode(b []byte) string { return base64.StdEncoding.EncodeToString(b) }
