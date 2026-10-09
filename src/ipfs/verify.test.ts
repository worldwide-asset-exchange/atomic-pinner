import { describe, it, expect, vi } from 'vitest';
import { createHashVerifier } from './verify.js';
import { silentLogger } from '../logging/logger.js';
import { fakeFetch, header, type Route } from '../../tests/helpers/http.js';

const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const G1 = 'https://g1.example';
const G2 = 'https://g2.example';

function verifier(routes: Route[], gateways = [G1, G2], pinataJwt?: string) {
  const fetch = fakeFetch(routes);
  const onFailure = vi.fn();
  const v = createHashVerifier({
    gateways,
    pinataJwt,
    fetch,
    logger: silentLogger,
    onFailure,
  });
  return { v, fetch, onFailure };
}

describe('createHashVerifier', () => {
  it('accepts a 200 HEAD and caches the answer', async () => {
    const { v, fetch } = verifier([{ method: 'HEAD', match: G1 }]);
    expect(await v.exists(CID)).toBe(true);
    expect(await v.exists(CID)).toBe(true);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].url).toBe(`${G1}/ipfs/${CID}`);
    expect(fetch.calls[0].init?.redirect).toBe('manual');
  });

  it('accepts a redirect as found', async () => {
    const { v } = verifier([{ method: 'HEAD', match: G1, status: 301 }]);
    expect(await v.exists(CID)).toBe(true);
  });

  it('moves to the next gateway on 429', async () => {
    const { v, fetch } = verifier([
      { method: 'HEAD', match: G1, status: 429 },
      { method: 'HEAD', match: G2 },
    ]);
    expect(await v.exists(CID)).toBe(true);
    expect(fetch.calls.map((c) => c.url)).toEqual([
      `${G1}/ipfs/${CID}`,
      `${G2}/ipfs/${CID}`,
    ]);
  });

  it('falls back to a ranged GET when HEAD is refused for a directory', async () => {
    const { v, fetch } = verifier([
      { method: 'HEAD', match: G1, status: 405 },
      { method: 'GET', match: G1, body: 'x' },
    ]);
    expect(await v.exists(CID)).toBe(true);
    expect(header(fetch.calls[1], 'Range')).toBe('bytes=0-1023');
  });

  it('only reports missing after every gateway says so', async () => {
    const { v, fetch, onFailure } = verifier([
      { method: 'HEAD', match: G1, status: 404 },
      { method: 'GET', match: G1, status: 404 },
      { method: 'HEAD', match: G2, status: 404 },
      { method: 'GET', match: G2, status: 404 },
    ]);
    expect(await v.exists(CID)).toBe(false);
    expect(fetch.calls).toHaveLength(4);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('finds content a later gateway has even if the first says 404', async () => {
    const { v } = verifier([
      { method: 'HEAD', match: G1, status: 404 },
      { method: 'GET', match: G1, status: 404 },
      { method: 'HEAD', match: G2 },
    ]);
    expect(await v.exists(CID)).toBe(true);
  });

  it('counts an API failure when no gateway could answer at all', async () => {
    const { v, onFailure } = verifier([
      { method: 'HEAD', match: G1, throws: new Error('timeout') },
      { method: 'HEAD', match: G2, status: 429 },
    ]);
    expect(await v.exists(CID)).toBe(false);
    expect(onFailure).toHaveBeenCalledWith('hashVerification');
  });

  it('does not retry a 403 with GET', async () => {
    const { v, fetch } = verifier(
      [{ method: 'HEAD', match: G1, status: 403 }],
      [G1]
    );
    expect(await v.exists(CID)).toBe(false);
    expect(fetch.calls).toHaveLength(1);
  });

  it('sends the Pinata JWT only to Pinata gateways', async () => {
    const { v, fetch } = verifier(
      [
        { method: 'HEAD', match: 'pinata.cloud', status: 404 },
        { method: 'GET', match: 'pinata.cloud', status: 404 },
        { method: 'HEAD', match: G2 },
      ],
      ['https://gateway.pinata.cloud/', G2],
      'jwt'
    );
    expect(await v.exists(CID)).toBe(true);
    expect(fetch.calls[0].url).toBe(`https://gateway.pinata.cloud/ipfs/${CID}`);
    expect(header(fetch.calls[0], 'Authorization')).toBe('Bearer jwt');
    expect(header(fetch.calls[2], 'Authorization')).toBeUndefined();
  });
});
