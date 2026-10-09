# atomic-pinner

Pin the IPFS content behind your NFTs before it disappears.

`atomic-pinner` walks [AtomicAssets](https://github.com/pinknetworkx/atomicassets-contract)
collections on WAX (or any Antelope chain with an AtomicAssets API), extracts every IPFS CID
referenced in the asset metadata, checks that the content still exists on the network, and pins it
to **Pinata** or to **your own IPFS node**. It only pins what already exists. It never uploads.

It is built to run forever on a schedule: progress is stored on disk, every run resumes where the
last one stopped, and a persistent cache guarantees a CID is never pinned twice.

> **Status:** early public release, ported from the service WAX runs in production. Not yet on
> npm; see [Roadmap](#roadmap).

## Quick start

Requirements: Node.js 20 or newer, and either a Pinata account or a reachable Kubo (IPFS) node.

```bash
git clone https://github.com/worldwide-asset-exchange/atomic-pinner.git
cd atomic-pinner
yarn install
cp .env.example .env          # set PINATA_JWT, or IPFS_PROVIDER=kubo and IPFS_API_URL
```

List the collections you care about in `pin-targets.json`:

```json
{
  "collection": ["shatner", "nimoy"],
  "token": []
}
```

Preview what would happen, then run for real:

```bash
yarn start --dry-run --dry-run-limit 25   # inspect 25 assets per collection, pin nothing
yarn start                                # pin
```

Run it again whenever you like. Finished collections are skipped, unfinished ones resume at the
last page, and CIDs already confirmed pinned are never sent to the provider again.

`yarn start` runs the CLI from source. The published package installs an `atomic-pinner`
binary with the same commands; `atomic-pinner --help` lists every flag.

## How it decides what to pin

For every CID found on a page of assets:

1. Already in `confirmed-pinned-hashes.json`? Skip without any network call.
2. Provider says it is already pinned? Skip, and remember that in the cache.
3. Not retrievable from any gateway? Skip, and list it in the report as missing.
4. Otherwise pin it, then remember it in the cache.

Duplicate CIDs within a page are collapsed first, so a template image shared by ten thousand
assets costs one pin.

## Configuration

Everything is configured with environment variables, read from the shell or from `.env`
(`--env-file` picks another file). Most options also have a CLI flag; run
`atomic-pinner --help` to see them. Empty variables mean "use the default", so CI systems
that export every variable with a blank value get sane behaviour. Invalid values stop the
run with a message that names the variable.

<!-- config:start -->

#### AtomicAssets API

| Variable                     | Default                           | Description                                                                                                                                  |
| ---------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ATOMIC_API_URL`             | `https://wax.api.atomicassets.io` | AtomicAssets API base URL. The default is the public WAX endpoint run by pink.gg; point it at another chain's API to use the tool elsewhere. |
| `ATOMIC_PAGE_SIZE`           | `1000`                            | Assets requested per API page.                                                                                                               |
| `ATOMIC_API_TIMEOUT_MS`      | `60000`                           | Timeout for one AtomicAssets HTTP request.                                                                                                   |
| `ATOMIC_API_RETRIES`         | `5`                               | HTTP attempts per AtomicAssets request. Network errors, 408, 429 and 5xx are retried.                                                        |
| `ATOMIC_RETRY_MAX_ATTEMPTS`  | `3`                               | Application-level attempts per page fetch, on top of the HTTP retries.                                                                       |
| `ATOMIC_RETRY_BASE_DELAY_MS` | `1000`                            | Base delay for the exponential backoff between application-level attempts.                                                                   |

#### Targets

| Variable       | Default              | Description                                                                         |
| -------------- | -------------------- | ----------------------------------------------------------------------------------- |
| `TARGETS_FILE` | `./pin-targets.json` | JSON file listing the collections and tokens to pin. Ignored when chunk mode is on. |

#### Chunk mode

| Variable            | Default         | Description                                                                                  |
| ------------------- | --------------- | -------------------------------------------------------------------------------------------- |
| `AUTO_CHUNK_MODE`   | `0`             | Process the next unfinished chunk file from the chunk directory instead of the targets file. |
| `AUTO_CHUNK_CYCLE`  | `0`             | When every chunk is done, clear chunk progress and start over from the first.                |
| `CHUNK_DIRECTORY`   | `./chunks`      | Directory holding chunk files.                                                               |
| `CHUNK_FILE_PREFIX` | `targets-chunk` | Chunk files are named `<prefix>-NN.json`.                                                    |

#### Processing

| Variable                   | Default | Description                                                                                |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `PIN_COLLECTIONS`          | `1`     | Process the `collection` list.                                                             |
| `PIN_TOKENS`               | `1`     | Process the `token` list.                                                                  |
| `MAX_PAGES_PER_COLLECTION` | `-1`    | Pages fetched per collection per run before pausing it until the next run. -1 = unlimited. |
| `DRY_RUN`                  | `0`     | Analyse and verify, but never pin. Progress is not saved.                                  |
| `DRY_RUN_LIMIT`            | `25`    | Assets inspected per collection in a dry run. -1 = whole first page.                       |
| `FRESH_START`              | `0`     | Delete the progress file before starting. The confirmed-pinned cache is kept.              |

#### IPFS provider

| Variable                     | Default                                                          | Description                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IPFS_PROVIDER`              | `pinata`                                                         | Where to pin: `pinata` (cloud) or `kubo` (your own IPFS node; `local` is accepted as an alias).                                                    |
| `PINATA_JWT`                 |                                                                  | Pinata API JWT with pinning permission. Required for the pinata provider.                                                                          |
| `PINATA_PLAN`                | `free`                                                           | Pinata plan. Picks a request delay and batch size that stay under the plan limits.                                                                 |
| `IPFS_API_URL`               | `http://127.0.0.1:5001`                                          | Kubo RPC API. Used by the kubo provider.                                                                                                           |
| `IPFS_GATEWAY_URL`           | `http://127.0.0.1:8080`                                          | Gateway of your Kubo node. Tried first for existence checks when the kubo provider is selected.                                                    |
| `IPFS_VERIFICATION_GATEWAYS` | `https://gateway.pinata.cloud,https://ipfs.io,https://dweb.link` | Comma-separated gateways tried in order to confirm a CID is retrievable before pinning. A CID is only treated as missing when every gateway fails. |
| `PIN_RETRIES`                | `3`                                                              | Attempts per pin request before the CID is recorded as failed.                                                                                     |

#### Rate limiting

| Variable              | Default | Description                                                                      |
| --------------------- | ------- | -------------------------------------------------------------------------------- |
| `RATE_LIMIT_DELAY_MS` |         | Pause after each provider or gateway call. Overrides the plan preset.            |
| `BATCH_SIZE`          |         | CIDs processed between the longer inter-batch pauses. Overrides the plan preset. |

#### Tracking and reports

| Variable                 | Default     | Description                                                                   |
| ------------------------ | ----------- | ----------------------------------------------------------------------------- |
| `TRACK_UNIQUE_HASHES`    | `1`         | Keep the set of unique CIDs seen, for the summary and report.                 |
| `TRACK_NOT_FOUND_HASHES` | `1`         | Keep the list of CIDs no gateway could retrieve.                              |
| `SAVE_HASH_REPORT`       | `0`         | Write a JSON report of CIDs, sources and missing content at the end of a run. |
| `HASH_REPORT_DIR`        | `./reports` | Directory for JSON reports.                                                   |

#### State files

| Variable                | Default                          | Description                                                                                 |
| ----------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| `PROGRESS_FILE`         | `./progress.json`                | Resume cursor: collection pages, chunk status, token completion. Must persist between runs. |
| `PERSISTENT_CACHE_FILE` | `./confirmed-pinned-hashes.json` | CIDs confirmed pinned. Prevents re-pinning across runs. Must persist between runs.          |

#### Notifications

| Variable            | Default | Description                                               |
| ------------------- | ------- | --------------------------------------------------------- |
| `WEBHOOK_URL`       |         | POST a JSON summary here when a run starts and finishes.  |
| `SLACK_WEBHOOK_URL` |         | Slack incoming-webhook URL for start and finish messages. |

#### Logging

| Variable        | Default | Description                                                         |
| --------------- | ------- | ------------------------------------------------------------------- |
| `LOG_LEVEL`     | `info`  | silent, error, warn, info or debug.                                 |
| `LOG_FORMAT`    | `text`  | `text` for humans, `json` (one object per line) for log collectors. |
| `PROGRESS_BARS` | `auto`  | Progress bars on stderr: `auto` shows them only on a TTY.           |

<!-- config:end -->

### Large collections: chunking

Split the job so each run has a bounded working set:

```bash
atomic-pinner chunk --per-chunk 10        # writes chunks/targets-chunk-NN.json
atomic-pinner run --chunks                # processes the next unfinished chunk, then exits
```

With `--chunks` (or `AUTO_CHUNK_MODE=1`) each run picks up the first chunk that is not finished,
so an hourly schedule walks through all of them. A chunk only counts as finished when every
collection in it has been walked to its last page and every token is done; a run that stops
early because of `MAX_PAGES_PER_COLLECTION` leaves the chunk current and resumes it next time.
`--cycle` (`AUTO_CHUNK_CYCLE=1`) starts over from the first chunk when all are done, which turns
the tool into a continuous re-pinning sweep for new mints.

## Running on a schedule

The process handles one chunk (or one object file) and exits, so any scheduler works. The
only rule is that `progress.json` and `confirmed-pinned-hashes.json` must survive between runs.

**cron**

```
0 * * * * cd /srv/atomic-pinner && atomic-pinner run --chunks --progress off >> pinner.log 2>&1
```

**Docker**

```bash
docker build -t atomic-pinner .
docker run --rm --env-file .env -v pinner-state:/app/state atomic-pinner
```

The image stores all state under `/app/state` and reads `pin-targets.json` from there too.
Mount a volume at `/app/state`, or every run starts from the beginning. Pass CLI arguments after
the image name, for example `atomic-pinner run --chunks`.

Logs go to stdout; `LOG_FORMAT=json` gives one JSON object per line for log collectors.
`WEBHOOK_URL` receives a JSON summary at the start and end of each run, and `SLACK_WEBHOOK_URL`
posts the same summary to a Slack incoming webhook.

## Providers

**Pinata.** Create an API key with pinning permission and set `PINATA_JWT`. Set `PINATA_PLAN` so
the tool stays under your plan's rate limits. Pins are created with `pinByHash`, so Pinata fetches
the content from the network itself.

**Kubo (your own node).** Set `IPFS_PROVIDER=kubo`, `IPFS_API_URL` to the node's RPC API and
`IPFS_GATEWAY_URL` to its gateway. The tool uses `pin/ls` and `pin/add` with `recursive=true`,
and tries your gateway first when checking that content exists.

**Something else.** A provider is two methods, `isPinned(cid)` and `pin(cid, metadata)`, on the
`IPFSProvider` interface in `src/ipfs/provider.ts`. The decision logic (caches, existence checks,
rate limiting) lives outside the provider, so an implementation is a thin HTTP client. Pull
requests for other services are welcome.

## Programmatic use

The CLI is a thin wrapper over an exported API:

```ts
import { loadConfig, createOrchestrator } from '@wax-io/atomic-pinner';

const config = loadConfig({ overrides: { processing: { dryRun: true } } });
const result = await createOrchestrator(config).run();
console.log(result.stats.totals());
```

`createOrchestrator` accepts replacement dependencies (provider, verifier, notifiers, logger),
which is also how the test suite exercises the pipeline without a network.

## Development

```bash
yarn install
yarn test              # vitest in watch mode
yarn test:run          # single pass
yarn test:coverage     # with v8 coverage
yarn typecheck         # tsc --noEmit
yarn prettier          # format
yarn docs              # regenerate the config table above and .env.example from src/config/schema.ts
yarn build             # compile to dist/ (what the npm package and Docker image run)
```

Tests live next to the code as `*.test.ts`. CI runs typecheck, format check, generated-docs
check, tests and a build on Node 20 and 22 for every pull request.

Layout: `src/config` (schema, env loading, docs generation), `src/core` (pipeline: targets,
collections, tokens, pin decision chain, storage, chunking, stats), `src/ipfs` (providers and
gateway verification), `src/atomic` (API client), `src/notify` (webhooks), `src/logging`,
`src/net` (fetch with retries), `src/cli.ts` and `src/index.ts`.

## Roadmap

- Publish to npm (`@wax-io/atomic-pinner`) and GHCR.
- Integration tests against a real Kubo node in CI.
- Pinning-service API (IPFS Pinning Service spec) provider.

## License

[MIT](LICENSE). Copyright Worldwide Asset eXchange (WAX).
