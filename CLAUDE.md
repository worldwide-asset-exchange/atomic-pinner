# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Open-source (MIT) port of WAX's internal `pin-wax-ipfs` service. A TypeScript CLI and library that
walks AtomicAssets collections, extracts IPFS CIDs from asset metadata, verifies they exist, and pins
them to Pinata or a Kubo node. Each run processes one chunk (or one targets file) and exits; state in
`progress.json` and `confirmed-pinned-hashes.json` makes runs resumable and idempotent.

Public repo `github.com/worldwide-asset-exchange/atomic-pinner`, default branch `main`. npm name
`@wax-io/atomic-pinner` (still `private: true` until the first release). The internal GitLab repo
`wax/pin-wax-ipfs` is the deployment wrapper, not a mirror.

## Commands

```bash
yarn install --frozen-lockfile
yarn start -- --dry-run --dry-run-limit 5   # CLI from source (tsx src/cli.ts)
yarn typecheck                               # tsc --noEmit, must stay clean
yarn test:run                                # vitest single pass
yarn vitest run src/core/collections.test.ts # one file
yarn vitest run -t "page limit"              # one test
yarn test:coverage                           # v8 coverage → coverage/
yarn prettier:check                          # CI gate; `yarn prettier` to fix
yarn docs                                    # regenerate README config table + .env.example
yarn docs:check                              # CI gate: generated docs match the schema
yarn build                                   # tsc -p tsconfig.build.json → dist/
node dist/cli.js run --chunks                # the published binary
```

CI (`.github/workflows/ci.yml`) runs all of the above on Node 20 and 22.

## Architecture

`src/cli.ts` parses flags → `loadConfig()` → `createOrchestrator(config).run()`. `src/index.ts`
exports the same pieces as a library.

- **Config is one table.** `src/config/schema.ts` declares every option once: env var, kind,
  default, zod validation, description, secret flag, deprecated aliases. `load.ts` reads the
  environment through it (empty string = unset, invalid value = `ConfigError` naming the variable),
  `docs.ts` renders the README table and `.env.example`, and the CLI maps flags to the same paths.
  Never read `process.env` anywhere else.
- **Dependencies are injected.** `PinningOrchestrator` takes an `OrchestratorDeps` object (storage ×2,
  atomic client, provider, verifier, notifiers, rate limit, logger, progress reporter).
  `createOrchestrator` builds the real ones; tests pass fakes and real `Storage` on temp files.
- `src/core/pinService.ts` is the decision chain: persistent cache → provider lookup (session
  cached) → gateway existence → pin. `collections.ts` and `tokens.ts` feed it; `stats.ts` counts and
  writes the optional JSON report; `targets.ts` validates `pin-targets.json` and splits chunks;
  `chunkManager.ts` picks the chunk; `storage.ts` is the lowdb store (file format unchanged from the
  internal service, so WAX's existing state files load).
- `src/ipfs/` has the `IPFSProvider` interface, `PinataProvider`, `KuboProvider` and the multi-gateway
  verifier. Providers are plain HTTP clients; they must not cache or decide.
- `src/atomic/client.ts` calls `/atomicassets/v1/assets` directly with `sort=asset_id&order=asc` so
  paging is stable while a collection mints.
- `src/notify/` posts start/finish events to a generic webhook and/or a Slack incoming webhook.
- `src/logging/` is a small leveled logger (text or JSON) plus progress bars that are no-ops off a TTY.
- `src/net/fetchRetry.ts` wraps global fetch: per-attempt timeout, backoff, retry on network errors,
  408, 429, 5xx.

### Invariants

- The four-layer pin decision chain and per-page dedup protect the provider's rate limits on a job
  that re-walks the same collections forever. Only the analytics (`HashTracker`) is optional.
- `progress.json` is the cursor. A collection moves to `pinnedCollections` only when a page comes back
  empty; a chunk completes only when every collection in it is complete (or paused with no page after
  it) and every token is done. Dry runs never write progress or complete anything.
- A run with no env vars set must behave the same before and after a change. New options get a
  default that preserves current behaviour, a row in the schema, and `yarn docs`.
- Keep the repo free of WAX-internal references (infra, tickets, hostnames other than public APIs).

## Conventions

- ES modules (`nodenext`), `.js` suffix on relative imports, strict TS, `unknown` over `any`.
- Tests beside the code as `*.test.ts`, vitest globals on. Prefer injected fakes over `vi.mock`;
  use real `Storage` on a temp dir rather than mocking it.
- Logs go through the injected `Logger` with structured fields; no `console.*` in `src/`.
