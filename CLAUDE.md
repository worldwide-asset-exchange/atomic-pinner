# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Open-source (MIT) port of WAX's internal `pin-wax-ipfs` service. A TypeScript CLI that walks
AtomicAssets collections, extracts IPFS CIDs from asset metadata, verifies they exist, and pins them
to Pinata or a local Kubo node. Each run processes one chunk (or one object file) and exits; state in
`progress.json` and `confirmed-pinned-hashes.json` makes runs resumable and idempotent.

Public repo: `github.com/worldwide-asset-exchange/atomic-pinner`, default branch `main`, npm name
`@wax-io/atomic-pinner` (not yet published; `private: true` until the CLI lands). The internal GitLab
repo `wax/pin-wax-ipfs` remains the deployment wrapper and is not a mirror.

## Commands

```bash
yarn install --frozen-lockfile
yarn start                                  # tsx src/main.ts
yarn typecheck                              # tsc --noEmit, must stay clean
yarn test:run                               # vitest single pass
yarn vitest run src/lib/fetchRetry.test.ts  # one file
yarn vitest run -t "retries a 503"          # one test
yarn test:coverage                          # v8 coverage → coverage/
yarn prettier:check                         # CI gate; `yarn prettier` to fix
DRY_RUN=1 DRY_RUN_LIMIT=10 yarn start       # end-to-end smoke test, pins nothing
```

CI (`.github/workflows/ci.yml`) runs typecheck, prettier check and coverage tests on Node 20 and 22.

## Architecture

`src/main.ts` → `loadEnvConfig()` (`envParser.ts`) → `new PinningOrchestrator(config).run()` →
`markChunkCompleted()` → exit.

- `lib/envParser.ts` owns env parsing (`safeEnv.*`, `EnvConfig`). Empty strings mean "use default".
  `atomicassets.ts`, `ipfsProvider.ts` and `slack.ts` still read a few `process.env` values directly;
  moving them behind `EnvConfig` is a roadmap item, don't add new direct reads.
- `lib/orchestrator.ts` is the pipeline (collections → pages → hashes → pin; tokens; reports; Slack).
- `lib/chunkManager.ts` + `Storage.autoChunkProgress` implement auto-chunk resume and cycling.
- `lib/Storage.ts` is a lowdb JSON store used for two files: progress and the pinned-hash cache.
- `lib/ipfsProvider.ts` has the `IPFSProvider` interface, Pinata and local implementations,
  `verifyHashExists()` (multi-gateway, 429 fallback, HEAD then ranged GET) and a lazy singleton.
- `lib/fetchRetry.ts` wraps global fetch with per-attempt timeout and backoff. It replaced the private
  `@waxio/fetch-retry` package; retry only on network errors, 408, 429 and 5xx.
- `lib/hashExtractor.ts` finds CIDv0/v1 in nested metadata and gateway URLs.
- `lib/rateLimitConfig.ts` maps `PINATA_PLAN` to delay/batch presets.

### Invariants

- The four-step pin decision chain (persistent cache → provider check → gateway verify → pin) and the
  per-page dedup exist to protect the provider's rate limits on a job that re-walks the same
  collections forever. Never bypass them for memory or speed; only the analytics sets are optional.
- `progress.json` is the cursor. A collection moves to `pinnedCollections` only when a page comes back
  empty; a chunk is complete only when every collection and token in it is complete.
- Defaults must keep a run with no env vars set behaving the same as before the change.

## Conventions

- ES modules (`nodenext`), `.js` suffix on relative imports, strict TS, no build step (`tsx`).
- Tests beside the code, vitest globals, mock `fetch` via injection (`fetchImpl`) rather than globals
  where the module allows it.
- Every user-facing env var gets a row in `.env.example` and, if commonly used, the README table.
- Keep the repo free of WAX-internal references (infra, tickets, hostnames other than public APIs).
