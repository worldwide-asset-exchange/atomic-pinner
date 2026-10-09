import { Storage } from './Storage.js';
import { createRetryFetch } from './fetchRetry.js';

// Gateway and provider calls: 3 attempts, 20s per attempt, retry on 408/429/5xx and network errors.
const fetch = createRetryFetch({ retries: 3, timeoutMs: 20000 });

// Utility function to add delay for rate limiting
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Cache to store checked hashes to avoid redundant API calls
const checkedHashes = new Map<string, boolean>();

// Cache to store hash existence checks to avoid redundant gateway calls
const hashExistenceCache = new Map<string, boolean>();

// Verify if an IPFS hash exists and is retrievable from the network
export async function verifyHashExists(
  ipfsHash: string,
  gatewayUrl?: string
): Promise<boolean> {
  // Check cache first
  if (hashExistenceCache.has(ipfsHash)) {
    return hashExistenceCache.get(ipfsHash)!;
  }

  // Use alternative gateways to avoid rate limiting
  const gateways = [
    gatewayUrl || process.env.IPFS_VERIFICATION_GATEWAY,
    'https://ipfs.io',
    'https://dweb.link',
    'https://gateway.pinata.cloud',
  ].filter(Boolean);

  let lastError: any = null;

  // Try multiple gateways in case of rate limiting
  for (const gateway of gateways) {
    const url = `${gateway}/ipfs/${ipfsHash}`;

    try {
      // Prepare headers - include JWT for Pinata gateway
      const headers: Record<string, string> = {
        'User-Agent': 'IPFS-Verification-Tool/1.0',
      };

      // Add JWT authentication for Pinata gateway
      if (gateway?.includes('pinata.cloud') && process.env.PINATA_JWT) {
        headers['Authorization'] = `Bearer ${process.env.PINATA_JWT}`;
      }

      // First try HEAD request
      const response = await fetch(url, {
        method: 'HEAD',
        headers,
      });

      // Consider both 2xx and 3xx (redirects) as existing
      // 301/302 redirects often indicate directory listings
      let exists =
        response.ok || (response.status >= 300 && response.status < 400);

      // Handle rate limiting
      if (response.status === 429) {
        console.log(
          `      ⚠️ Rate limited on ${gateway}, trying next gateway...`
        );
        lastError = new Error(`Rate limited (429) on ${gateway}`);
        continue; // Try next gateway
      }

      // If HEAD request failed, try GET request for directories
      // Some IPFS gateways don't properly handle HEAD requests for directories
      if (
        !exists &&
        (response.status === 404 ||
          response.status === 405 ||
          response.status === 500 ||
          response.status === 504)
      ) {
        try {
          console.log(
            `      🔄 HEAD request failed (${response.status}) on ${gateway}, trying GET request...`
          );

          // Prepare headers for GET request (reuse same auth)
          const getHeaders = {
            ...headers,
            Range: 'bytes=0-1023',
          };

          const getResponse = await fetch(url, {
            method: 'GET',
            headers: getHeaders,
          });

          exists = getResponse.ok;

          if (exists) {
            console.log(
              `✅ Hash ${ipfsHash} exists on IPFS network (verified via GET on ${gateway} - likely a directory)`
            );
          } else if (getResponse.status === 429) {
            console.log(
              `      ⚠️ Rate limited on GET request, trying next gateway...`
            );
            continue; // Try next gateway
          }
        } catch (getError: any) {
          console.log(
            `      ❌ GET request error on ${gateway}: ${getError.message}`
          );
          // Continue to try next gateway
        }
      }

      // If we successfully verified (or failed definitively), cache and return
      if (exists || response.status !== 429) {
        hashExistenceCache.set(ipfsHash, exists);

        if (exists) {
          if (response.ok) {
            console.log(
              `✅ Hash ${ipfsHash} exists on IPFS network (via ${gateway})`
            );
          } else {
            console.log(
              `✅ Hash ${ipfsHash} exists on IPFS network (redirect ${response.status} on ${gateway} - likely directory)`
            );
          }
        } else {
          console.log(
            `❌ Hash ${ipfsHash} not found on IPFS network (HTTP ${response.status} on ${gateway})`
          );
        }

        return exists;
      }
    } catch (error: any) {
      console.log(
        `      ⚠️ Error verifying hash ${ipfsHash} on ${gateway}:`,
        error.message
      );
      lastError = error;
      continue; // Try next gateway
    }
  }

  // If all gateways failed
  console.log(`❌ Hash ${ipfsHash} verification failed on all gateways`);
  if (globalStorage) {
    await globalStorage.recordApiFailure('hashVerification');
  }
  // Cache as false when we can't verify
  hashExistenceCache.set(ipfsHash, false);
  return false;
}

// Interface for IPFS providers
export interface IPFSProvider {
  isHashAlreadyPinned(ipfsHash: string): Promise<boolean>;
  pinHash(
    ipfsHash: string,
    metadata?: { name?: string; keyvalues?: Record<string, any> },
    retries?: number
  ): Promise<any>;
  getProviderName(): string;
  setStorage(storage: Storage): void;
}

// Pinata IPFS Provider
export class PinataProvider implements IPFSProvider {
  private pinUrl = 'https://api.pinata.cloud/pinning/pinByHash';
  private listPinsUrl = 'https://api.pinata.cloud/data/pinList';
  private jwtToken: string;
  private storage: Storage | null = null;

  constructor() {
    this.jwtToken = process.env.PINATA_JWT || '';
    if (!this.jwtToken) {
      throw new Error(
        'PINATA_JWT environment variable is required for Pinata provider'
      );
    }
  }

  setStorage(storage: Storage): void {
    this.storage = storage;
  }

  getProviderName(): string {
    return 'Pinata';
  }

  async isHashAlreadyPinned(ipfsHash: string): Promise<boolean> {
    // Check cache first
    if (checkedHashes.has(ipfsHash)) {
      return checkedHashes.get(ipfsHash)!;
    }

    try {
      const response = await fetch(
        `${this.listPinsUrl}?hashContains=${ipfsHash}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.jwtToken}`,
          },
        }
      );

      if (!response.ok) {
        console.log(
          `Warning: Could not check if hash ${ipfsHash} is already pinned to Pinata (HTTP ${response.status})`
        );
        if (this.storage) {
          await this.storage.recordApiFailure('pinataList');
        }
        // If we can't check, assume it's not pinned to be safe
        checkedHashes.set(ipfsHash, false);
        return false;
      }

      const result = await response.json();
      const isAlreadyPinned =
        result.rows &&
        result.rows.some((row: any) => row.ipfs_pin_hash === ipfsHash);

      // Cache the result
      checkedHashes.set(ipfsHash, isAlreadyPinned);

      return isAlreadyPinned;
    } catch (error: any) {
      console.log(
        `Warning: Error checking if hash ${ipfsHash} is already pinned to Pinata:`,
        error.message
      );
      if (this.storage) {
        await this.storage.recordApiFailure('pinataList');
      }
      // If we can't check, assume it's not pinned to be safe
      checkedHashes.set(ipfsHash, false);
      return false;
    }
  }

  async pinHash(
    ipfsHash: string,
    metadata?: { name?: string; keyvalues?: Record<string, any> },
    retries = 3
  ): Promise<any> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const requestBody = {
          hashToPin: ipfsHash,
          pinataMetadata: metadata || { name: `WAX-IPFS-${ipfsHash}` },
        };

        const pinResult = await fetch(this.pinUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.jwtToken}`,
          },
          body: JSON.stringify(requestBody),
        });

        if (!pinResult.ok) {
          const errorText = await pinResult.text();
          throw new Error(`HTTP ${pinResult.status}: ${errorText}`);
        }

        const result = await pinResult.json();
        console.log(`📌 Pinned hash ${ipfsHash} to Pinata`);
        // Cache this hash as pinned
        checkedHashes.set(ipfsHash, true);
        return result;
      } catch (error: any) {
        console.log(
          `Pinata pin attempt ${attempt} failed for hash ${ipfsHash}:`,
          error.message
        );
        if (this.storage) {
          await this.storage.recordApiFailure('pinataPin');
        }

        if (attempt === retries) {
          throw new Error(
            `Failed to pin hash ${ipfsHash} to Pinata after ${retries} attempts: ${error.message}`
          );
        }

        // Exponential backoff for retries
        const backoffDelay = Math.pow(2, attempt) * 1000;
        await delay(backoffDelay);
      }
    }
  }
}

// Local IPFS Node Provider
export class LocalIPFSProvider implements IPFSProvider {
  private apiUrl: string;
  private gateway: string;
  private storage: Storage | null = null;

  constructor() {
    this.apiUrl = process.env.IPFS_API_URL || 'http://localhost:5001';
    this.gateway = process.env.IPFS_GATEWAY_URL || 'http://localhost:8080';

    // Validate required configuration
    if (!this.apiUrl) {
      throw new Error(
        'IPFS_API_URL environment variable is required for local IPFS provider'
      );
    }
  }

  setStorage(storage: Storage): void {
    this.storage = storage;
  }

  getProviderName(): string {
    return 'Local IPFS Node';
  }

  async isHashAlreadyPinned(ipfsHash: string): Promise<boolean> {
    // Check cache first
    if (checkedHashes.has(ipfsHash)) {
      return checkedHashes.get(ipfsHash)!;
    }

    try {
      const response = await fetch(
        `${this.apiUrl}/api/v0/pin/ls?arg=${ipfsHash}&type=recursive`,
        {
          method: 'POST',
        }
      );

      if (!response.ok) {
        console.log(
          `Warning: Could not check if hash ${ipfsHash} is already pinned to local IPFS (HTTP ${response.status})`
        );
        if (this.storage) {
          await this.storage.recordApiFailure('pinataList');
        }
        // If we can't check, assume it's not pinned to be safe
        checkedHashes.set(ipfsHash, false);
        return false;
      }

      const result = await response.json();
      // If the hash is in the pin list, it's already pinned
      const isAlreadyPinned =
        result.Keys && Object.keys(result.Keys).includes(ipfsHash);

      // Cache the result
      checkedHashes.set(ipfsHash, isAlreadyPinned);

      return isAlreadyPinned;
    } catch (error: any) {
      console.log(
        `Warning: Error checking if hash ${ipfsHash} is already pinned to local IPFS:`,
        error.message
      );
      if (this.storage) {
        await this.storage.recordApiFailure('pinataList');
      }
      // If we can't check, assume it's not pinned to be safe
      checkedHashes.set(ipfsHash, false);
      return false;
    }
  }

  async pinHash(
    ipfsHash: string,
    metadata?: { name?: string; keyvalues?: Record<string, any> },
    retries = 3
  ): Promise<any> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // First, try to fetch the content to ensure it's available
        const fetchResponse = await fetch(`${this.gateway}/ipfs/${ipfsHash}`, {
          method: 'HEAD',
        });

        if (!fetchResponse.ok) {
          throw new Error(
            `Content not available: HTTP ${fetchResponse.status}`
          );
        }

        // Pin the hash using IPFS API
        const pinResponse = await fetch(
          `${this.apiUrl}/api/v0/pin/add?arg=${ipfsHash}&recursive=true`,
          {
            method: 'POST',
          }
        );

        if (!pinResponse.ok) {
          const errorText = await pinResponse.text();
          throw new Error(`HTTP ${pinResponse.status}: ${errorText}`);
        }

        const result = await pinResponse.json();
        console.log(`📌 Pinned hash ${ipfsHash} to local IPFS node`);
        // Cache this hash as pinned
        checkedHashes.set(ipfsHash, true);
        return result;
      } catch (error: any) {
        console.log(
          `Local IPFS pin attempt ${attempt} failed for hash ${ipfsHash}:`,
          error.message
        );
        if (this.storage) {
          await this.storage.recordApiFailure('pinataPin');
        }

        if (attempt === retries) {
          throw new Error(
            `Failed to pin hash ${ipfsHash} to local IPFS after ${retries} attempts: ${error.message}`
          );
        }

        // Exponential backoff for retries
        const backoffDelay = Math.pow(2, attempt) * 1000;
        await delay(backoffDelay);
      }
    }
  }
}

// Factory function to create the appropriate provider
export function createIPFSProvider(storage?: Storage): IPFSProvider {
  const providerType = process.env.IPFS_PROVIDER || 'pinata';

  let provider: IPFSProvider;
  switch (providerType.toLowerCase()) {
    case 'pinata':
      provider = new PinataProvider();
      break;
    case 'local':
    case 'ipfs':
      provider = new LocalIPFSProvider();
      break;
    default:
      throw new Error(
        `Unsupported IPFS provider: ${providerType}. Supported providers: pinata, local`
      );
  }

  if (storage) {
    provider.setStorage(storage);
  }

  return provider;
}

// Convenience functions for backward compatibility
let provider: IPFSProvider;
let globalStorage: Storage | undefined;

function getProvider(): IPFSProvider {
  if (!provider) {
    provider = createIPFSProvider(globalStorage);
  }
  return provider;
}

export function setGlobalStorage(storage: Storage): void {
  globalStorage = storage;
  if (provider) {
    provider.setStorage(storage);
  }
}

export async function isHashAlreadyPinned(ipfsHash: string): Promise<boolean> {
  return getProvider().isHashAlreadyPinned(ipfsHash);
}

export async function pinHashToPinata(
  ipfsHash: string,
  metadata?: { name?: string; keyvalues?: Record<string, any> },
  retries = 3
): Promise<any> {
  // First check if hash is already pinned
  const alreadyPinned = await isHashAlreadyPinned(ipfsHash);
  if (alreadyPinned) {
    const providerName = getProvider().getProviderName();
    console.log(
      `✅ Hash ${ipfsHash} is already pinned to ${providerName}, skipping`
    );
    return { message: 'Already pinned', hash: ipfsHash, skipped: true };
  }

  // Verify the hash exists on IPFS network before attempting to pin
  const exists = await verifyHashExists(ipfsHash);
  if (!exists) {
    console.log(
      `⚠️  Skipping pin for ${ipfsHash} - hash does not exist on IPFS network`
    );
    return {
      message: 'Hash not found on IPFS network',
      hash: ipfsHash,
      skipped: true,
      error: 'not_found',
    };
  }

  return getProvider().pinHash(ipfsHash, metadata, retries);
}
