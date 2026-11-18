# github-core-clone

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/alawymuhsin/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/alawymuhsin/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node.js process — standard
library only, no git binary, no outside service, no UI. Built for the
[make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01).

## What it serves

- **Git smart HTTP** — `upload-pack` protocol v2 (with `ls-refs`, `fetch`,
  shallow clones, `filter`, `object-format=sha1`) and the v0 fallback,
  plus `receive-pack` v0 with `report-status`, `side-band-64k` and
  `delete-refs`. Fast-forward rules enforced per ref, with one report line
  per ref on mixed pushes. Packfiles are written plain (no deltas) and read
  back with full OFS/REF delta support, so clones from real git round-trip
  byte-exactly.
- **REST v3** under `/api/v3` — repositories (create/read/patch/delete,
  paginated listing with `Link` headers), contents (create/update/delete with
  sha guards, directory listings), git refs, issues (labels, comments,
  state, sort), pull requests (diff files, squash merge onto the base
  branch, conflict detection). Every reply is JSON with
  `X-GitHub-Request-Id`; unknown routes are JSON 404s.
- **GraphQL** at `/api/graphql` — `viewer`, `repository` (with `issue`,
  `issues`, `pullRequest`, `pullRequests` connections, cursors and
  `orderBy`), `node(id:)` with stable opaque global ids, `__type`
  introspection, the `createIssue` / `closeIssue` / `createPullRequest` /
  `mergePullRequest` / `addComment` mutations, and batched operation
  documents answered in order.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision
  2026-07-28 via `server/discover` and the legacy `initialize` handshake.
  Six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) act on the same store as
  REST, so an object created over MCP reads back over REST unchanged.

## Layout

```
main.ts            the trial lifecycle: bind an ephemeral port, POST /register,
                   poll /done, exit 0 (kept as the kit starter wrote it)
app.ts             the HTTP server: routing, auth, JSON-always envelope
lib/store.ts       the in-memory store: repos, objects, refs, issues, pulls,
                   three-way merge, squash merge, global ids
lib/gitobj.ts      the git object model, pkt-line codec, pack read/write
lib/git-http.ts    info/refs advertisements, upload-pack, receive-pack
lib/rest.ts        REST v3
lib/graphql.ts     a hand-rolled GraphQL parser and executor
lib/mcp.ts         the MCP server
lib/http-util.ts   shared HTTP helpers
```

## Local conformance

The kit ships a local runner that grades a running server with the sealed
checks:

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
# in another shell, from the kit directory:
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token <token> [--perf]
```

Measured locally: **120/120 conformance checks** (git 30/30, repos 15/15,
issues 15/15, pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15),
feature 600, agent 200, performance ≈ 100 (around the house reference).

## Notes

- The token owner is the contest's fixed viewer (`adaiversen`); the bearer
  token comes from `MAKEFUN_SHOP_TOKEN`, the same token the suite presents.
- `main.ts` needs `MAKEFUN_ENV_URL` in a trial; without it the program
  exits 1 at once, by design. For a standalone smoke test, import
  `createApp()` from `app.ts` and listen on any port.
- Node 22+, standard library only. No dependencies, no build step:
  `node --experimental-strip-types main.ts`.

## License

MIT — see [LICENSE](LICENSE).
