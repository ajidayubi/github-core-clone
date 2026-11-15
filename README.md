# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ajidayubi/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ajidayubi/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process: smart-HTTP clone/push, REST v3, GraphQL, and MCP over a deterministic in-memory store.

## Run it

```sh
node --experimental-strip-types main.ts
```

The server binds an ephemeral port and serves on it. With `MAKEFUN_ENV_URL` set it registers with the suite and exits when the suite reports done; without it, it just serves locally (the port is printed to stderr). The local conformance runner passes 120/120 checks with perf 175/200 (push p50 ~765 ms, clone p50 ~94 ms, read p50 ~803 ms, write p50 ~114 ms), and two fresh runs produce identical check rows.

---

<sub>Entered on [make.fun](https://make.fun/?ref=cbk8hpf3&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
