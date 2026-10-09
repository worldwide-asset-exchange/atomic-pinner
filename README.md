# atomic-pinner

Pin the IPFS content behind your NFTs before it disappears.

`atomic-pinner` walks [AtomicAssets](https://github.com/pinknetworkx/atomicassets-contract)
collections on WAX (or any Antelope chain with an AtomicAssets API), extracts every IPFS CID
referenced in the asset metadata, checks that the content still exists on the network, and pins it
to **Pinata** or to **your own IPFS node**. It only pins what already exists. It never uploads.

It is built to run forever on a schedule: progress is stored on disk, every run resumes where the
last one stopped, and a persistent cache guarantees a CID is never pinned twice.

> **Status:** early public release, ported from the service WAX runs in production. The CLI and
> configuration surface will change before 1.0. See [Roadmap](#roadmap).

## Quick start

Requirements: Node.js 20 or newer, and either a Pinata account or a reachable IPFS (Kubo) node.

```bash
git clone https://github.com/worldwide-asset-exchange/atomic-pinner.git
cd atomic-pinner
yarn install
cp .env.example .env          # set PINATA_JWT (or IPFS_API_URL / IPFS_GATEWAY_URL)
```

Put the collections you care about in `object.json`:

```json
{
  "collection": ["shatner", "nimoy"],
  "token": []
}
```

Preview what would happen, then run for real:

```bash
DRY_RUN=1 DRY_RUN_LIMIT=25 yarn start   # analyse 25 assets per collection, pin nothing
yarn start                              # pin
```

Run it again whenever you like. Finished collections are skipped, unfinished ones resume at the
last page, and CIDs already confirmed pinned are never sent to the provider again.

## How it decides what to pin

For every CID found on a page of assets:

1. Already in `confirmed-pinned-hashes.json`? Skip without any network call.
2. Provider says it is already pinned? Skip, and remember that in the cache.
3. Not retrievable from any gateway? Skip, and list it in the report as missing.
4. Otherwise pin it, then remember it in the cache.

Duplicate CIDs within a page are collapsed first, so a template image shared by ten thousand
assets costs one pin.

## Configuration

Everything is configured with environment variables, read from the shell or from `.env`.
Empty strings fall back to the default, which makes the tool safe to run from CI systems that
set every variable whether or not it has a value.

| Variable                                                                               | Default                                              | What it does                                                                                        |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ATOMIC_API_URL`                                                                       | `https://atomic.waxnet.io`                           | AtomicAssets API. Point it at another chain's API to use the tool elsewhere.                        |
| `OBJECT_FILE`                                                                          | `./object.json`                                      | Collections and tokens to process.                                                                  |
| `IPFS_PROVIDER`                                                                        | `pinata`                                             | `pinata` or `local`.                                                                                |
| `PINATA_JWT`                                                                           |                                                      | Required for `pinata`.                                                                              |
| `PINATA_PLAN`                                                                          | `free`                                               | `free`, `picnic`, `fiesta` or `custom`. Picks sensible rate limits for your plan.                   |
| `IPFS_API_URL` / `IPFS_GATEWAY_URL`                                                    | `http://localhost:5001` / `:8080`                    | Required for `local`.                                                                               |
| `IPFS_VERIFICATION_GATEWAY`                                                            | `https://gateway.pinata.cloud`                       | First gateway tried when checking a CID exists. Public gateways are used as fallbacks.              |
| `DRY_RUN` / `DRY_RUN_LIMIT`                                                            | `0` / `25`                                           | Analyse without pinning. `-1` removes the asset limit.                                              |
| `MAX_PAGES_PER_COLLECTION`                                                             | `-1`                                                 | Stop after N pages (1000 assets each) per run and resume next time. Use for very large collections. |
| `FRESH_START`                                                                          | `0`                                                  | Wipe `progress.json` and start from the first collection. The pinned-hash cache is kept.            |
| `UPLOAD_COLLECTION_NFT` / `UPLOAD_TOKEN`                                               | `1` / `1`                                            | Toggle the two processing phases.                                                                   |
| `PROGRESS_FILE` / `PERSISTENT_CACHE_FILE`                                              | `./progress.json` / `./confirmed-pinned-hashes.json` | Where state lives. Put them on persistent storage.                                                  |
| `TRACK_UNIQUE_HASHES`, `TRACK_NOT_FOUND_HASHES`, `SAVE_HASH_REPORT`, `HASH_REPORT_DIR` | `1`, `1`, `1`, `./reports`                           | Reporting. Turn tracking off to save memory on huge collections.                                    |
| `SLACK_TOKEN` / `SLACK_CHANNEL`                                                        |                                                      | Optional start and completion notifications.                                                        |

`.env.example` documents every variable, including the AtomicAssets retry and timeout knobs.

### Large collections: chunking

Split the job so each run has a bounded working set:

```bash
COLLECTIONS_PER_CHUNK=10 ./scripts/chunk-object-file.sh   # writes chunks/object-chunk-NN.json
AUTO_CHUNK_MODE=1 yarn start                               # processes the next unfinished chunk, then exits
```

With `AUTO_CHUNK_MODE=1` each run picks up the first chunk that is not finished, so an hourly
schedule walks through all of them. `AUTO_CHUNK_CYCLE=1` starts over from the first chunk when
all are done, which turns the tool into a continuous re-pinning sweep for new mints.

## Running on a schedule

The process handles one chunk (or one object file) and exits, so any scheduler works. The
only rule is that `progress.json` and `confirmed-pinned-hashes.json` must survive between runs.

**cron**

```
0 * * * * cd /srv/atomic-pinner && AUTO_CHUNK_MODE=1 yarn start >> pinner.log 2>&1
```

**Docker**

```bash
docker build -t atomic-pinner .
docker run --rm --env-file .env -v pinner-state:/app/state atomic-pinner
```

The image stores all state under `/app/state`. Mount a volume there, or every run starts from
the beginning.

## Providers

**Pinata.** Create an API key with pinning permissions and set `PINATA_JWT`. Set `PINATA_PLAN` so
the tool stays under your plan's rate limits. Pins are created with `pinByHash`, so Pinata fetches
the content from the network itself.

**Local IPFS node (Kubo).** Set `IPFS_PROVIDER=local`, `IPFS_API_URL` to the node's RPC API and
`IPFS_GATEWAY_URL` to its gateway. The tool uses `pin/ls` and `pin/add` with `recursive=true`.

Adding another provider means implementing the `IPFSProvider` interface in
`src/lib/ipfsProvider.ts`. Contributions welcome.

## Development

```bash
yarn install
yarn test              # vitest in watch mode
yarn test:run          # single pass
yarn test:coverage     # with v8 coverage
yarn typecheck         # tsc --noEmit
yarn prettier          # format
```

Tests live next to the code as `src/lib/*.test.ts`. CI runs typecheck, format check and tests on
Node 20 and 22 for every pull request.

## Roadmap

- Proper CLI (`atomic-pinner --dry-run --config …`) and an npm package you can `npx`.
- Single configuration schema with generated docs.
- Injectable providers and a documented plugin interface.
- Structured logging with levels.
- Integration tests against a real Kubo node in CI.

## License

[MIT](LICENSE). Copyright Worldwide Asset eXchange (WAX).
