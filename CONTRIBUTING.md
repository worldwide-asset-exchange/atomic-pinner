# Contributing

Thanks for helping keep NFT media alive. Issues and pull requests are welcome.

## Setup

```bash
git clone https://github.com/worldwide-asset-exchange/atomic-pinner.git
cd atomic-pinner
yarn install
yarn test:run
```

Node.js 20.19 or newer for development (vitest requires it; the published CLI runs on any Node 20).
The repo uses Yarn 1 with a committed lockfile.

## Before you open a pull request

Run the same gate CI runs:

```bash
yarn typecheck && yarn prettier:check && yarn docs:check && yarn test:coverage && yarn build
```

- `yarn prettier` fixes formatting.
- `yarn docs` regenerates the README configuration table and `.env.example` whenever you touch
  `src/config/schema.ts`. Commit the result.
- Coverage thresholds are enforced (85% lines, branches, functions). New code comes with tests;
  the suite uses injected fakes and real `Storage` instances on temp directories rather than
  module mocks.
- Add a line under **Unreleased** in `CHANGELOG.md` for anything a user would notice.

## Where things live

| Directory     | What                                                                        |
| ------------- | --------------------------------------------------------------------------- |
| `src/config`  | The option schema, env loading, docs generation                             |
| `src/core`    | Pipeline: targets, collections, tokens, pin decision chain, storage, chunks |
| `src/ipfs`    | `IPFSProvider` implementations and gateway verification                     |
| `src/atomic`  | AtomicAssets API client                                                     |
| `src/notify`  | Webhook and Slack notifiers                                                 |
| `src/logging` | Logger and progress bars                                                    |
| `src/net`     | `fetch` with retries                                                        |
| `tests`       | Shared test helpers and the Kubo integration test                           |

## Adding a provider

Implement `IPFSProvider` (`isPinned(cid)` and `pin(cid, metadata)`) in `src/ipfs/`, register it in
`createProvider` and add any options to the config schema. Providers are plain HTTP clients; the
caches, existence checks and rate limiting live in `PinService`, so keep decisions out of the
provider. Unit-test it with the `fakeFetch` helper in `tests/helpers/http.ts`.

## Adding a configuration option

Add one entry to `src/config/schema.ts` with its env var, type, default, validation and a one or
two sentence description. Run `yarn docs`. If it deserves a CLI flag, map it in
`overridesFromFlags` in `src/cli.ts`. Defaults must keep a run with no variables set behaving as
before.

## Releasing

Maintainers bump `package.json`, add the version heading in `CHANGELOG.md`, and push a `vX.Y.Z`
tag. The release workflow verifies the tag matches `package.json`, runs the full gate, publishes
to npm and GHCR, and creates a GitHub release from the changelog section.

## Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
