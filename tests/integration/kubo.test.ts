import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../../src/config/load.js';
import { createOrchestrator } from '../../src/core/orchestrator.js';

const KUBO_API = process.env.KUBO_API_URL;
const KUBO_GATEWAY = process.env.KUBO_GATEWAY_URL ?? 'http://127.0.0.1:8080';

/** Adds a small file to the node and returns its CID. */
async function addToKubo(content: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), 'asset.txt');
  const response = await fetch(
    `${KUBO_API}/api/v0/add?pin=false&cid-version=0`,
    { method: 'POST', body: form }
  );
  if (!response.ok)
    throw new Error(
      `kubo add failed: ${response.status} ${await response.text()}`
    );
  return ((await response.json()) as { Hash: string }).Hash;
}

async function isPinnedOnKubo(cid: string): Promise<boolean> {
  const response = await fetch(
    `${KUBO_API}/api/v0/pin/ls?arg=${cid}&type=recursive`,
    { method: 'POST' }
  );
  if (!response.ok) return false;
  const body = (await response.json()) as { Keys?: Record<string, unknown> };
  return Boolean(body.Keys && cid in body.Keys);
}

/** Minimal AtomicAssets API: one collection, one page, one asset referencing the CID. */
function stubAtomicApi(
  cid: string
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const page = Number(url.searchParams.get('page') ?? '1');
      const data =
        url.pathname === '/atomicassets/v1/assets' && page === 1
          ? ['1099511627776', '1099511627777'].map((asset_id) => ({
              asset_id,
              owner: 'someone',
              name: `Integration asset ${asset_id}`,
              collection: {
                collection_name: url.searchParams.get('collection_name'),
              },
              schema: { schema_name: 'art' },
              template: { template_id: '1' },
              // Two assets from one template share the same media CID.
              data: { img: `ipfs://${cid}` },
            }))
          : [];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: true, data }));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe.skipIf(!KUBO_API)('end to end against Kubo', () => {
  let dir: string;
  let api: Awaited<ReturnType<typeof stubAtomicApi>>;
  let cid: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-pinner-kubo-'));
    cid = await addToKubo(`atomic-pinner integration ${Date.now()}`);
    api = await stubAtomicApi(cid);
    await fs.writeFile(
      path.join(dir, 'pin-targets.json'),
      JSON.stringify({ collection: ['integ'], token: [] })
    );
  });

  afterAll(async () => {
    await api?.close();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  function config() {
    return loadConfig({
      env: {
        IPFS_PROVIDER: 'kubo',
        IPFS_API_URL: KUBO_API,
        IPFS_GATEWAY_URL: KUBO_GATEWAY,
        IPFS_VERIFICATION_GATEWAYS: KUBO_GATEWAY,
        ATOMIC_API_URL: api.url,
        TARGETS_FILE: path.join(dir, 'pin-targets.json'),
        PROGRESS_FILE: path.join(dir, 'progress.json'),
        PERSISTENT_CACHE_FILE: path.join(dir, 'cache.json'),
        RATE_LIMIT_DELAY_MS: '0',
        IPFS_VERIFY_TIMEOUT_MS: '2000',
        PROGRESS_BARS: 'off',
        LOG_LEVEL: 'silent',
      },
    });
  }

  it('discovers the CID through the API, verifies it on the gateway and pins it', async () => {
    expect(await isPinnedOnKubo(cid)).toBe(false);

    const result = await createOrchestrator(config()).run();

    expect(result.success).toBe(true);
    expect(result.completed).toBe(true);
    expect(result.stats.collections).toMatchObject({
      hashesFound: 2,
      uniqueHashes: 1,
      duplicatesAvoided: 1,
      pinned: 1,
      missing: 0,
      failed: 0,
    });
    expect(await isPinnedOnKubo(cid)).toBe(true);
  });

  it('skips everything on the next run thanks to progress and the pinned cache', async () => {
    const result = await createOrchestrator(config()).run();
    expect(result.collections[0].reason).toBe('already-completed');
    expect(result.stats.totals().pinned).toBe(0);
  });

  it('reports a CID nobody has as missing instead of pinning it', async () => {
    const ghost = 'QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR';
    const ghostApi = await stubAtomicApi(ghost);
    try {
      const cfg = loadConfig({
        env: {
          IPFS_PROVIDER: 'kubo',
          IPFS_API_URL: KUBO_API,
          IPFS_GATEWAY_URL: KUBO_GATEWAY,
          IPFS_VERIFICATION_GATEWAYS: KUBO_GATEWAY,
          ATOMIC_API_URL: ghostApi.url,
          TARGETS_FILE: path.join(dir, 'pin-targets.json'),
          PROGRESS_FILE: path.join(dir, 'progress-ghost.json'),
          PERSISTENT_CACHE_FILE: path.join(dir, 'cache-ghost.json'),
          RATE_LIMIT_DELAY_MS: '0',
          IPFS_VERIFY_TIMEOUT_MS: '2000',
          PROGRESS_BARS: 'off',
          LOG_LEVEL: 'silent',
        },
      });
      const result = await createOrchestrator(cfg).run();
      expect(result.stats.collections).toMatchObject({ pinned: 0, missing: 1 });
      expect(await isPinnedOnKubo(ghost)).toBe(false);
    } finally {
      await ghostApi.close();
    }
  });
});
