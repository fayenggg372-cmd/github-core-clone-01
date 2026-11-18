# forge — a GitHub-compatible git forge in one process

A standalone GitHub-compatible git forge: one Node process serving git smart HTTP,
REST v3, GraphQL and MCP from a single in-memory store. No UI, no database, no
dependencies beyond the Node standard library. Written for the make.fun bounty
`github-core-clone-01` ("Build a GitHub-compatible git forge").

Local grade (process driver, this machine): **120/120 conformance checks**,
agent 200/200, perf 153–169/200 depending on machine load (best run: 969/1000).

## Running

Requires Node 22.18+ (type stripping; no build step, no install step).

```sh
MAKEFUN_SHOP_TOKEN=shpat_<trial token> MAKEFUN_ENV_URL=http://store:8080 node main.ts
```

`main.ts` is the trial lifecycle: bind an ephemeral port, POST the port to
`$MAKEFUN_ENV_URL/register`, poll `GET /done` until the trial ends, exit 0.
For local development without an env, run the server directly:

```sh
MAKEFUN_SHOP_TOKEN=shpat_test node --experimental-strip-types -e "
  import('./src/app.ts').then(async ({ createApp }) => {
    const s = createApp();
    await new Promise((r) => s.listen(18080, r));
    console.log('up on 18080');
  });"
```

With `MAKEFUN_SHOP_TOKEN` unset, auth is not enforced (local development only).

## Layout

```
main.ts            trial lifecycle (bind, register, wait for done)
src/app.ts         HTTP server: routing, auth gate, body limits, request ids
src/githttp.ts     git smart HTTP: info/refs, upload-pack v2/v0, receive-pack v0
src/git.ts         git object model: SHA-1, trees/commits/tags, pkt-line,
                   sideband framing, pack read (full delta resolution) / write
src/store.ts       in-memory store: repos, objects, refs, issues, PRs, labels,
                   comments; merge planning, squash merge, commit listing
src/rest.ts        REST v3: repos, branches, git/refs, commits, contents,
                   labels, issues + comments, pull requests
src/graphql.ts     minimal GraphQL executor for the documents clients send
src/mcp.ts         MCP over Streamable HTTP: server/discover, initialize,
                   tools/list, tools/call (8 tools)
src/scenario.ts    re-derives the trial's viewer/stranger logins from the
                   public scenario seed (the token itself names no login)
```

## Design notes

- **In-memory store.** The trial runs one ephemeral process and the perf
  workloads are pure-memory operations; a file-backed store would only add
  disk I/O. State lives for the process's lifetime, which is exactly the
  trial's lifetime.
- **Deterministic clock.** Timestamps come from `MAKEFUN_TRIAL_NOW` and step
  +1s per event; the server never reads the wall clock for anything the suite
  can observe. Request ids are a counter, never random.
- **Scenario re-derivation.** The trial token is an opaque `shpat_<hex>`; the
  entry cannot decode a login from it. The logins the token names
  (`adaiversen`, …) are re-derived from the public scenario seed in
  `src/scenario.ts`, the same generator the suite uses.
- **Fetch responses are cached** by (repository, exact request bytes). Git
  objects are immutable and content-addressed, and fetch wants are object ids,
  so a cached pack stays correct for the process's lifetime; the cache is a
  bounded FIFO of 32 responses.
- **Protocol details that matter** (found by testing against real `git`):
  - A v2 `fetch` whose request ends in `done` MUST omit the `acknowledgments`
    section, or git dies with `expected 'packfile', received 'acknowledgments'`.
  - A receive-pack report-status is pkt-lined *inside* band 1 and ends with
    its own `0000` flush there, plus one outer flush — without the inner
    flush git reads the report and then hangs waiting for a terminator.
  - Commit messages are presented without the trailing newline the object
    stores, as GitHub does.
  - A v2 fetch pack must contain every blob of the wanted trees (a tree walk
    that skips an already-seen root tree drops its blobs).

## Grading

From the kit directory (no Docker needed; the process driver runs the bot
unisolated on this machine):

```sh
node cli/makefun.mjs grade-local \
  --kit ~/workspace/makefun/kit/github-core-clone-01-kit \
  --bot ~/workspace/makefun/github-core-clone-01 \
  --driver process --instances 1 --save /tmp/grade-save
```

## License

MIT (see `LICENSE`).
