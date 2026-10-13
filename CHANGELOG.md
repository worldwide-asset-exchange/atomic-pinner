# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

## 0.2.1 - 2026-10-13

### Changed

- The release workflow publishes to npm through trusted publishing (OIDC) instead of a stored
  token, and the npm job runs in the `npm` GitHub environment so it can require a reviewer.
- GitHub Actions in the workflows are pinned to commit SHAs.
- Docker image base is `node:22.22.3-alpine3.22`; the 0.2.0 image build failed on Node 20.18
  because vitest requires 20.19 or newer.
- `npm publish` no longer needs `yarn` on the PATH.

## 0.2.0 - 2026-10-09

First public release, ported from the service WAX runs internally.

### Added

- `atomic-pinner` CLI with `run`, `chunk` and `print-config` commands; every option is also an
  environment variable (`atomic-pinner --help`).
- Single configuration schema (`src/config/schema.ts`) from which the README reference and
  `.env.example` are generated.
- `kubo` provider for self-hosted IPFS nodes, alongside Pinata.
- Generic `WEBHOOK_URL` and `SLACK_WEBHOOK_URL` notifications for run start and finish.
- JSON hash report (`SAVE_HASH_REPORT=1`) listing every CID, its sources and the CIDs no gateway
  could retrieve.
- Leveled logging with `LOG_FORMAT=json` for log collectors; progress bars only on a TTY.
- Programmatic API (`createOrchestrator`, `loadConfig`, providers, verifier) for embedding.
- Docker image and a release workflow publishing to npm and GHCR.

### Changed

- Existence checks only treat a CID as missing after every configured gateway has failed, instead
  of trusting the first gateway's 404.
- AtomicAssets pages are fetched in ascending `asset_id` order so resuming a collection is stable
  while it is still minting.
- Default AtomicAssets endpoint is the public `https://wax.api.atomicassets.io`.
- Renamed variables, with the old names still accepted and a deprecation warning:
  `OBJECT_FILE` → `TARGETS_FILE`, `UPLOAD_COLLECTION_NFT` → `PIN_COLLECTIONS`,
  `UPLOAD_TOKEN` → `PIN_TOKENS`, `IPFS_VERIFICATION_GATEWAY` → `IPFS_VERIFICATION_GATEWAYS`.
  `IPFS_PROVIDER=local` is accepted for `kubo`.
- The targets file is `pin-targets.json` by default; chunk files are `targets-chunk-NN.json`.

### Removed

- Slack bot-token notifications (`SLACK_TOKEN` / `SLACK_CHANNEL`); use an incoming webhook.
- Unused settings `DEBUG_AUTH`, `ENABLE_GRACEFUL_RECOVERY`, `MAX_CONSECUTIVE_FAILURES`.
- The shell chunking script, replaced by `atomic-pinner chunk`.
