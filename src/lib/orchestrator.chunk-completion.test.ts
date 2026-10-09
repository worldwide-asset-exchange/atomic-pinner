import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { PinningOrchestrator } from './orchestrator.js';
import * as fs from 'fs/promises';

// Mock fs module
vi.mock('fs/promises');

// Mock atomicassets module
vi.mock('./atomicassets.js', () => ({
  default: vi.fn().mockImplementation(() => ({
    getAssetsPage: vi.fn(),
  })),
}));

// Mock Storage module
vi.mock('./Storage.js', () => {
  const MockStorage = class {
    read = vi.fn();
    clearAllProgress = vi.fn();
    getPinnedCollection = vi.fn();
    getPinningCollection = vi.fn();
    pinnedCollection = vi.fn();
    pinningCollection = vi.fn();
    updateCollectionProgress = vi.fn();
    isTokenPinned = vi.fn();
    markTokenPinned = vi.fn();
    getAutoChunkProgress = vi.fn();
    markChunkCompleted = vi.fn();
  };
  return {
    Storage: MockStorage,
  };
});

// Mock ChunkManager
vi.mock('./chunkManager.js', () => ({
  ChunkManager: vi.fn().mockImplementation((config, storage) => ({
    markChunkCompleted: vi.fn(),
    displayChunkProgress: vi.fn(),
    setCurrentChunk: vi.fn(),
    findNextChunkFile: vi.fn().mockResolvedValue({
      chunkFile: './test-object.json',
      chunkFileName: 'test-object.json',
      currentChunkNumber: 1,
      totalChunks: 1,
      completedChunks: 0,
      failedChunks: 0,
    }),
  })),
}));

// Mock other dependencies
vi.mock('./ipfsProvider.js');
vi.mock('./slack.js');
vi.mock('./persistentCache.js');

describe('PinningOrchestrator - Chunk Completion with Page Limits', () => {
  let orchestrator: any;
  let mockAtomic: any;
  let mockStorage: any;
  let mockChunkManager: any;
  let config: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create config
    config = {
      objectFile: './test-object.json',
      autoChunkMode: true,
      maxPagesPerCollection: 50,
      uploadCollectionNFT: true,
      uploadToken: true,
      isDryRun: false,
      shouldFreshStart: false,
    };

    // Create orchestrator
    orchestrator = new PinningOrchestrator(config);

    // Get mocked instances
    mockAtomic = orchestrator.atomic;
    mockStorage = orchestrator.progressStorage;
    mockChunkManager = orchestrator.chunkManager;
  });

  it('should mark chunk as complete when all collections have no more pages (even if still in pinningCollections)', async () => {
    // Setup: Two collections, both have processed all their pages but are still in pinningCollections
    // due to page limits from previous runs
    const mockObjectFile = {
      collection: ['collection1', 'collection2'],
      token: [],
    };

    (fs.readFile as Mock).mockResolvedValue(JSON.stringify(mockObjectFile));

    // Collection1 is at page 150 (no more assets)
    (mockStorage.getPinnedCollection as Mock).mockImplementation(
      (name: string) => {
        return null; // Neither collection is in pinnedCollections
      }
    );

    (mockStorage.getPinningCollection as Mock).mockImplementation(
      (name: string) => {
        if (name === 'collection1') {
          return { page: 150, assets: 150000 };
        }
        if (name === 'collection2') {
          return { page: 200, assets: 200000 };
        }
        return null;
      }
    );

    // Mock getAssetsPage to return no more assets (collections are done)
    (mockAtomic.getAssetsPage as Mock).mockImplementation((params: any) => {
      // Both collections have no more assets
      return Promise.resolve([]);
    });

    (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue({
      currentChunk: 'object-chunk-01.json',
      completedChunks: [],
      failedChunks: [],
    });

    // Run markChunkCompleted
    await orchestrator.markChunkCompleted();

    // Should mark chunk as completed since all collections have no more pages
    expect(mockChunkManager.markChunkCompleted).toHaveBeenCalledWith(
      'object-chunk-01.json'
    );
  });

  it('should NOT mark chunk as complete when collections still have more pages', async () => {
    const mockObjectFile = {
      collection: ['collection1', 'collection2'],
      token: [],
    };

    (fs.readFile as Mock).mockResolvedValue(JSON.stringify(mockObjectFile));

    (mockStorage.getPinnedCollection as Mock).mockResolvedValue(null);

    (mockStorage.getPinningCollection as Mock).mockImplementation(
      (name: string) => {
        if (name === 'collection1') {
          return { page: 50, assets: 50000 }; // Stopped at page limit
        }
        if (name === 'collection2') {
          return { page: 100, assets: 100000 };
        }
        return null;
      }
    );

    // Mock getAssetsPage to return more assets for collection1
    (mockAtomic.getAssetsPage as Mock).mockImplementation((params: any) => {
      if (params.collection_name === 'collection1' && params.page === 51) {
        return Promise.resolve([{ asset_id: '123' }]); // More assets available
      }
      return Promise.resolve([]); // collection2 is done
    });

    (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue({
      currentChunk: 'object-chunk-01.json',
      completedChunks: [],
      failedChunks: [],
    });

    // Run markChunkCompleted
    await orchestrator.markChunkCompleted();

    // Should NOT mark chunk as completed since collection1 has more pages
    expect(mockChunkManager.markChunkCompleted).not.toHaveBeenCalled();
  });

  it('should handle mixed completion states correctly', async () => {
    const mockObjectFile = {
      collection: [
        'completed-collection',
        'in-progress-collection',
        'done-but-pinning',
      ],
      token: [],
    };

    (fs.readFile as Mock).mockResolvedValue(JSON.stringify(mockObjectFile));

    (mockStorage.getPinnedCollection as Mock).mockImplementation(
      (name: string) => {
        // One collection is already in pinnedCollections
        if (name === 'completed-collection') {
          return { page: 75, assets: 75000, completed: 75000 };
        }
        return null;
      }
    );

    (mockStorage.getPinningCollection as Mock).mockImplementation(
      (name: string) => {
        if (name === 'in-progress-collection') {
          return { page: 50, assets: 50000 };
        }
        if (name === 'done-but-pinning') {
          return { page: 100, assets: 100000 };
        }
        return null;
      }
    );

    // Mock getAssetsPage
    (mockAtomic.getAssetsPage as Mock).mockImplementation((params: any) => {
      if (
        params.collection_name === 'in-progress-collection' &&
        params.page === 51
      ) {
        return Promise.resolve([{ asset_id: '456' }]); // More assets
      }
      if (
        params.collection_name === 'done-but-pinning' &&
        params.page === 101
      ) {
        return Promise.resolve([]); // No more assets
      }
      return Promise.resolve([]);
    });

    (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue({
      currentChunk: 'object-chunk-01.json',
      completedChunks: [],
      failedChunks: [],
    });

    // Run markChunkCompleted
    await orchestrator.markChunkCompleted();

    // Should NOT mark as complete because in-progress-collection still has pages
    expect(mockChunkManager.markChunkCompleted).not.toHaveBeenCalled();
  });

  it('should mark chunk complete when all collections and tokens are done', async () => {
    const mockObjectFile = {
      collection: ['collection1'],
      token: [{ chain: 'wax', address: 'token1' }],
    };

    (fs.readFile as Mock).mockResolvedValue(JSON.stringify(mockObjectFile));

    // Collection is done
    (mockStorage.getPinnedCollection as Mock).mockResolvedValue(null);
    (mockStorage.getPinningCollection as Mock).mockResolvedValue({
      page: 100,
      assets: 100000,
    });
    (mockAtomic.getAssetsPage as Mock).mockResolvedValue([]); // No more assets

    // Token is done
    (mockStorage.isTokenPinned as Mock).mockResolvedValue(true);

    (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue({
      currentChunk: 'object-chunk-01.json',
      completedChunks: [],
      failedChunks: [],
    });

    // Run markChunkCompleted
    await orchestrator.markChunkCompleted();

    // Should mark as complete
    expect(mockChunkManager.markChunkCompleted).toHaveBeenCalledWith(
      'object-chunk-01.json'
    );
  });
});
