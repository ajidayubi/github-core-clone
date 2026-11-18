# github-core-clone-01 — bot-go build log

Go (stdlib-only) rewrite of the GitHub-compatible git forge, written fresh
from the kit contract files. Live v2 (Node) scores 931; paid line needs ≥947.

## Layout

- `forge` — the Go binary (built `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w"`).
  Single process: git smart HTTP + REST v3 + GraphQL + MCP over one
  deterministic in-memory store. No disk writes, no git binary.
- `main.go` — port parsing (`--port`/PORT/0=ephemeral), prints `PORT=<n>`.
- `store.go` — repos/issues/PRs/labels/comments, object store, reachability,
  tree flatten/rebuild, squash merge + conflict detection, cached issue JSON.
- `gitobj.go` — SHA-1, pkt-line, pack read/write (OFS/REF delta), delta apply.
- `gitproto.go` — info/refs (v2 upload-pack adv, v0 receive-pack adv),
  upload-pack v2 ls-refs/fetch, v0 fetch, receive-pack v0 (FF enforcement,
  report-status over sideband).
- `server.go` — HTTP dispatch + REST v3.
- `graphql.go` — small GraphQL parser + resolvers (incl. introspection,
  batched ops, mutations, node() round-trip).
- `mcp.go` — JSON-RPC 2.0 streamable HTTP (server/discover 2026-07-28,
  initialize 2025-11-25, 6 tools).
- `main.ts` — entrypoint: spawn ./forge, read PORT, POST /register, poll /done.
- `.makefun/owner.json` — mirrored from the live repo tree (wallet 7T6pap…Dbz8).

## Design decisions

- Viewer login is `adaiversen` (fixed scenario seed 0x6a09e667f3bcc909;
  override via `MAKEFUN_VIEWER_LOGIN`). Repo ownership keyed by owner in the
  URL; another owner's repo is 404, never 403.
- All timestamps from `MAKEFUN_TRIAL_NOW` (fallback `2026-11-14T06:30:00Z`);
  all ids sequential; no `time.Now()` / unseeded rand in responses.
- Packs sent are plain (no deltas); pack bytes cached per
  (repo, wants, haves, shallow, depth), invalidated on push/merge/contents.
- `ls-refs` does NOT advertise `unborn` (empty-repo clone must see 0 refs).
- v2 fetch sections are named (`acknowledgments`, `shallow-info`, `packfile`)
  separated by delims — the client rejects bare NAK/pack lines.
- Shallow haves are cut at the boundary: a shallow have's parents are NOT
  held (deepen case).

## Local suite results

Token `testtok123`, `node --experimental-strip-types sdk/run.ts --url
http://127.0.0.1:18222 --token testtok123 --perf --json`, from the kit dir.

| run | passed | MCP | push ms | clone ms | read ms | write ms | perf pts | p50_us |
|-----|--------|-----|---------|----------|---------|----------|----------|--------|
| 1 | 92/120 | 15/15 | 328 | — (fetch err) | 735 | 100 | 146 | — |
| 2 | 119/120 | 15/15 | 252 | 62 | 616 | 107 | 196 | 178,851 |
| 3 | 120/120 | 15/15 | 246 | 79 | 751 | 110 | 191 | 200,596 |
| 4 | 120/120 | 15/15 | 295 | 93 | 745 | 112 | 188 | 218,829 |

Run 1 failures: v2 fetch sections unnamed (all fetch/clone checks) + a tree
builder bug (nested paths looked up by relative path in the full-path map).
Run 2: only `fetch-shallow-deepen` failed (shallow have cut). Runs 3–4:
120/120, 15/15 MCP. Local score: run 3 = 600+200+191 = **991**; run 4 =
600+200+188 = **988** (v2 local baseline 982; paid line 947).

Perf spread across runs (178k→218k µs) matches the kit's documented ±26%
reference spread; raw server floor for the read path measured separately at
376 ms / 2000 sequential GETs, so most of the suite's read time is
client-side overhead. No further grinding: score is 988+ on every full run.

## Binary size

`forge` = 6,279,352 bytes (run 4 build) — under the 8,388,608 cap.

## Commits (local git, bot-go/)

- ac42cbe — forge: Go git forge (REST v3, GraphQL, MCP, smart HTTP) + entrypoint
- 66abb02 — fix: v2 fetch named sections; tree builder; shallow have cut
