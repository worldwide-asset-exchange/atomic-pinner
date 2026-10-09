// Extract IPFS CIDs from AtomicAssets asset data and token metadata.
import { silentLogger, type Logger } from '../logging/logger.js';

const ipfsRe = new RegExp(
  '^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|b[A-Za-z2-7]{58,}|B[A-Z2-7]{58,}|z[1-9A-HJ-NP-Za-km-z]{48,}|F[0-9A-F]{50,}).*'
);

// Extract IPFS hash from URL (supports ipfs://, https://ipfs.io/ipfs/, https://gateway.pinata.cloud/ipfs/, etc.)
function extractIPFSHash(url: string): string | null {
  if (!url || typeof url !== 'string') return null;

  // Handle ipfs:// protocol
  if (url.startsWith('ipfs://')) {
    const hash = url.replace('ipfs://', '');
    return ipfsRe.test(hash) ? hash.split('/')[0] : null;
  }

  // Handle HTTP IPFS gateway URLs
  const gatewayPatterns = [
    /https?:\/\/(?:[^\/]+\/)?ipfs\/([^\/\?#]+)/i,
    /https?:\/\/([^\/\?#]+)\.ipfs\./i,
  ];

  for (const pattern of gatewayPatterns) {
    const match = url.match(pattern);
    if (match && ipfsRe.test(match[1])) {
      return match[1];
    }
  }

  // Direct hash check
  if (ipfsRe.test(url)) {
    return url.split('/')[0];
  }

  return null;
}

// Helper function to recursively extract IPFS hashes from any object
function extractHashesFromObject(
  obj: unknown,
  hashes: Set<string>,
  maxDepth: number = 5,
  currentDepth: number = 0
): void {
  // Prevent infinite recursion and limit depth for performance
  if (!obj || currentDepth > maxDepth) return;

  // Handle different data types
  if (typeof obj === 'string') {
    const hash = extractIPFSHash(obj);
    if (hash) {
      hashes.add(hash);
    }
  } else if (Array.isArray(obj)) {
    // Process arrays
    for (const item of obj) {
      extractHashesFromObject(item, hashes, maxDepth, currentDepth + 1);
    }
  } else if (typeof obj === 'object' && obj !== null) {
    // Process all object properties dynamically
    for (const value of Object.values(obj)) {
      extractHashesFromObject(value, hashes, maxDepth, currentDepth + 1);
    }
  }
}

// Extract all IPFS hashes from AtomicAssets NFT data
export function extractHashesFromAsset(asset: unknown): string[] {
  if (!asset) {
    return [];
  }

  const a = asset as Record<string, unknown> & {
    template?: { immutable_data?: unknown } | null;
  };
  const hashSet = new Set<string>();

  // data = merged immutable + mutable data; template immutable_data covers template-level media.
  if (a.data) extractHashesFromObject(a.data, hashSet);
  if (a.template?.immutable_data)
    extractHashesFromObject(a.template.immutable_data, hashSet);
  if (a.mutable_data) extractHashesFromObject(a.mutable_data, hashSet);
  if (a.backed_tokens) extractHashesFromObject(a.backed_tokens, hashSet);

  // Convert Set back to array for compatibility
  return Array.from(hashSet);
}

// Extract IPFS hashes from token metadata
export function extractHashesFromToken(tokenMetadata: unknown): string[] {
  const hashSet = new Set<string>();

  // Use the same dynamic extraction for token metadata
  extractHashesFromObject(tokenMetadata, hashSet);

  return Array.from(hashSet);
}

// Fetch token metadata from IPFS and extract all nested hashes
export interface FetchTokenHashesDeps {
  fetch?: typeof globalThis.fetch;
  logger?: Logger;
}

export async function fetchAndExtractTokenHashes(
  metadataUrl: string,
  deps: FetchTokenHashesDeps = {}
): Promise<{ metadataHash: string | null; nestedHashes: string[] }> {
  const logger = deps.logger ?? silentLogger;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const metadataHash = extractIPFSHash(metadataUrl);
  const nestedHashes: string[] = [];

  if (!metadataHash) {
    logger.warn('No IPFS CID in token metadata URL', { metadataUrl });
    return { metadataHash: null, nestedHashes: [] };
  }

  try {
    // Fetch the metadata JSON from IPFS
    const response = await fetchImpl(metadataUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const metadata = await response.json();

    // Extract hashes from the fetched metadata content
    const extractedHashes = extractHashesFromToken(metadata);
    nestedHashes.push(...extractedHashes);

    logger.debug('Token metadata fetched', {
      metadataHash,
      nested: nestedHashes.length,
    });
  } catch (error) {
    logger.warn('Failed to fetch token metadata', { metadataUrl, error });
  }

  return { metadataHash, nestedHashes };
}
