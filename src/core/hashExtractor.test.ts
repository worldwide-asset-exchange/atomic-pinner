import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractHashesFromAsset,
  extractHashesFromToken,
  fetchAndExtractTokenHashes,
} from './hashExtractor.js';

// Mock fetch for token metadata tests
global.fetch = vi.fn();

describe('Hash Extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('extractHashesFromAsset', () => {
    it('should extract IPFS hashes from asset data', () => {
      const asset = {
        data: {
          img: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
          video:
            'https://ipfs.io/ipfs/QmZBWGPQsFVwkGtHriJNqkBrQUPBYTKpLdNgwp9BpkXNnM',
        },
        template: {
          immutable_data: {
            image: 'QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB',
            animation:
              'https://gateway.pinata.cloud/ipfs/QmXoypizjW3WknFj6GvyLBcBJeCdY5DKZo5N3fvmJYq3yK',
          },
        },
      };

      const hashes = extractHashesFromAsset(asset);

      expect(hashes).toContain(
        'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
      );
      expect(hashes).toContain(
        'QmZBWGPQsFVwkGtHriJNqkBrQUPBYTKpLdNgwp9BpkXNnM'
      );
      expect(hashes).toContain(
        'QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB'
      );
      expect(hashes).toContain(
        'QmXoypizjW3WknFj6GvyLBcBJeCdY5DKZo5N3fvmJYq3yK'
      );
      expect(hashes).toHaveLength(4);
    });

    it('should handle nested objects', () => {
      const asset = {
        data: {
          properties: {
            files: [
              { uri: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' },
              { uri: 'ipfs://QmZBWGPQsFVwkGtHriJNqkBrQUPBYTKpLdNgwp9BpkXNnM' },
            ],
          },
        },
      };

      const hashes = extractHashesFromAsset(asset);

      expect(hashes).toContain(
        'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
      );
      expect(hashes).toContain(
        'QmZBWGPQsFVwkGtHriJNqkBrQUPBYTKpLdNgwp9BpkXNnM'
      );
    });

    it('should handle arrays of strings', () => {
      const asset = {
        data: {
          images: [
            'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
            'https://ipfs.io/ipfs/QmZBWGPQsFVwkGtHriJNqkBrQUPBYTKpLdNgwp9BpkXNnM',
            'not-an-ipfs-hash',
          ],
        },
      };

      const hashes = extractHashesFromAsset(asset);

      expect(hashes).toContain(
        'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
      );
      expect(hashes).toContain(
        'QmZBWGPQsFVwkGtHriJNqkBrQUPBYTKpLdNgwp9BpkXNnM'
      );
      expect(hashes).toHaveLength(2);
    });

    it('should deduplicate hashes', () => {
      const asset = {
        data: {
          img1: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
          img2: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
          img3: 'https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        },
      };

      const hashes = extractHashesFromAsset(asset);

      expect(hashes).toContain(
        'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
      );
      expect(hashes).toHaveLength(1);
    });

    it('should extract from mutable_data and backed_tokens', () => {
      const asset = {
        mutable_data: {
          img: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        },
        backed_tokens: {
          token_uri: 'ipfs://QmZBWGPQsFVwkGtHriJNqkBrQUPBYTKpLdNgwp9BpkXNnM',
        },
      };

      const hashes = extractHashesFromAsset(asset);

      expect(hashes).toContain(
        'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
      );
      expect(hashes).toContain(
        'QmZBWGPQsFVwkGtHriJNqkBrQUPBYTKpLdNgwp9BpkXNnM'
      );
    });

    it('should handle empty or invalid assets', () => {
      expect(extractHashesFromAsset(null)).toEqual([]);
      expect(extractHashesFromAsset(undefined)).toEqual([]);
      expect(extractHashesFromAsset({})).toEqual([]);
      expect(extractHashesFromAsset({ data: null })).toEqual([]);
    });

    it('should handle CIDv1 hashes', () => {
      const asset = {
        data: {
          // Base32 CIDv1
          img1: 'ipfs://bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq',
          // Base58btc CIDv1
          img2: 'ipfs://zdj7WWeQ43G6JJvLWQWZpyHuAMq6uYWRjkBXFad11vE2LHhQ7',
        },
      };

      const hashes = extractHashesFromAsset(asset);

      expect(hashes).toContain(
        'bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq'
      );
      expect(hashes).toContain(
        'zdj7WWeQ43G6JJvLWQWZpyHuAMq6uYWRjkBXFad11vE2LHhQ7'
      );
    });

    it('should extract hashes from paths with subdirectories', () => {
      const asset = {
        data: {
          img: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/image.png',
          folder:
            'https://ipfs.io/ipfs/QmZBWGPQsFVwkGtHriJNqkBrQUPBYTKpLdNgwp9BpkXNnM/metadata.json',
        },
      };

      const hashes = extractHashesFromAsset(asset);

      expect(hashes).toContain(
        'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
      );
      expect(hashes).toContain(
        'QmZBWGPQsFVwkGtHriJNqkBrQUPBYTKpLdNgwp9BpkXNnM'
      );
    });

    it('should handle various IPFS gateway formats', () => {
      const asset = {
        data: {
          gateway1:
            'https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
          gateway2:
            'https://gateway.pinata.cloud/ipfs/QmZBWGPQsFVwkGtHriJNqkBrQUPBYTKpLdNgwp9BpkXNnM',
          gateway3:
            'https://cloudflare-ipfs.com/ipfs/QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB',
          gateway4:
            'https://QmXoypizjW3WknFj6GvyLBcBJeCdY5DKZo5N3fvmJYq3yK.ipfs.dweb.link',
          gateway5:
            'https://QmSgvgwxZGaBLqkGyWemEDqikCqU52XxsYLKtdy3vGZ8uq.ipfs.nftstorage.link',
        },
      };

      const hashes = extractHashesFromAsset(asset);

      expect(hashes).toContain(
        'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
      );
      expect(hashes).toContain(
        'QmZBWGPQsFVwkGtHriJNqkBrQUPBYTKpLdNgwp9BpkXNnM'
      );
      expect(hashes).toContain(
        'QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB'
      );
      expect(hashes).toContain(
        'QmXoypizjW3WknFj6GvyLBcBJeCdY5DKZo5N3fvmJYq3yK'
      );
      expect(hashes).toContain(
        'QmSgvgwxZGaBLqkGyWemEDqikCqU52XxsYLKtdy3vGZ8uq'
      );
    });
  });

  describe('extractHashesFromToken', () => {
    it('should extract hashes from token metadata', () => {
      const tokenMetadata = {
        image: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        animation_url:
          'https://ipfs.io/ipfs/QmZBWGPQsFVwkGtHriJNqkBrQUPBYTKpLdNgwp9BpkXNnM',
        properties: {
          files: [
            { uri: 'ipfs://QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB' },
          ],
        },
      };

      const hashes = extractHashesFromToken(tokenMetadata);

      expect(hashes).toContain(
        'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
      );
      expect(hashes).toContain(
        'QmZBWGPQsFVwkGtHriJNqkBrQUPBYTKpLdNgwp9BpkXNnM'
      );
      expect(hashes).toContain(
        'QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB'
      );
    });
  });

  describe('fetchAndExtractTokenHashes', () => {
    it('should fetch and extract hashes from remote token metadata', async () => {
      const tokenMetadataUrl =
        'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/metadata.json';
      const mockMetadata = {
        image: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        external_url: 'https://example.com',
        properties: {
          thumbnail: 'ipfs://QmZBWGPQsFVwkGtHriJNqkBrQUPBYTKpLdNgwp9BpkXNnM',
        },
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockMetadata,
      });

      const result = await fetchAndExtractTokenHashes(tokenMetadataUrl);

      expect(result.metadataHash).toBe(
        'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
      );
      expect(result.nestedHashes).toContain(
        'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
      );
      expect(result.nestedHashes).toContain(
        'QmZBWGPQsFVwkGtHriJNqkBrQUPBYTKpLdNgwp9BpkXNnM'
      );
    });

    it('should handle fetch errors gracefully', async () => {
      const tokenMetadataUrl = 'https://example.com/metadata.json';

      (global.fetch as any).mockRejectedValue(new Error('Network error'));

      const result = await fetchAndExtractTokenHashes(tokenMetadataUrl);

      expect(result.metadataHash).toBe(null);
      expect(result.nestedHashes).toEqual([]);
    });

    it('should handle non-JSON responses', async () => {
      const tokenMetadataUrl = 'https://example.com/metadata.json';

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      const result = await fetchAndExtractTokenHashes(tokenMetadataUrl);

      expect(result.metadataHash).toBe(null);
      expect(result.nestedHashes).toEqual([]);
    });

    it('should handle non-200 responses', async () => {
      const tokenMetadataUrl = 'https://example.com/metadata.json';

      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const result = await fetchAndExtractTokenHashes(tokenMetadataUrl);

      expect(result.metadataHash).toBe(null);
      expect(result.nestedHashes).toEqual([]);
    });
  });

  describe('IPFS hash validation', () => {
    it('should only accept valid IPFS hashes', () => {
      const asset = {
        data: {
          valid1: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', // Valid CIDv0
          valid2: 'bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq', // Valid CIDv1
          invalid1: 'not-a-hash',
          invalid2: 'Qm123', // Too short
          invalid3: 'https://example.com/image.png', // Not IPFS
          invalid4: '', // Empty
          invalid5: null, // Null
        },
      };

      const hashes = extractHashesFromAsset(asset);

      expect(hashes).toContain(
        'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
      );
      expect(hashes).toContain(
        'bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq'
      );
      expect(hashes).toHaveLength(2);
    });
  });
});
