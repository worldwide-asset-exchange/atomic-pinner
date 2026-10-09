import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { ChunkManager } from './chunkManager.js';
import * as fs from 'fs/promises';

// Mock fs module
vi.mock('fs/promises');

describe('ChunkManager - 11 chunks scenario', () => {
  let chunkManager: ChunkManager;
  let mockStorage: any;
  let config: any;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create mock storage
    mockStorage = {
      getAutoChunkProgress: vi.fn(),
      setCurrentChunk: vi.fn(),
      markChunkCompleted: vi.fn(),
      markChunkFailed: vi.fn(),
      clearAutoChunkProgress: vi.fn(),
    };

    // Create config with cycling disabled
    config = {
      chunkDirectory: './chunks',
      chunkPrefix: 'object-chunk',
      enableCycling: false, // Cycling should be disabled
    };

    // Create ChunkManager instance
    chunkManager = new ChunkManager(config, mockStorage);
  });

  it('should progress from chunk 2 to chunk 3 after chunk 2 completes (not back to chunk 1)', async () => {
    // Create 11 chunk files like in production
    const mockFiles = [
      'object-chunk-01.json',
      'object-chunk-02.json',
      'object-chunk-03.json',
      'object-chunk-04.json',
      'object-chunk-05.json',
      'object-chunk-06.json',
      'object-chunk-07.json',
      'object-chunk-08.json',
      'object-chunk-09.json',
      'object-chunk-10.json',
      'object-chunk-11.json',
    ];

    (fs.readdir as Mock).mockResolvedValue(mockFiles);
    (fs.access as Mock).mockResolvedValue(undefined); // All files exist
    (mockStorage.setCurrentChunk as Mock).mockResolvedValue(undefined);

    // Scenario: Chunk 1 is complete, Chunk 2 just completed
    // The next run should pick chunk 3, NOT go back to chunk 1
    (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue({
      completedChunks: ['object-chunk-01.json', 'object-chunk-02.json'],
      failedChunks: [],
      currentChunk: 'object-chunk-02.json', // Just finished chunk 2
      lastUpdated: new Date().toISOString(),
    });

    const result = await chunkManager.findNextChunkFile();

    // Should move to chunk 3, not back to chunk 1
    expect(result.chunkFileName).toBe('object-chunk-03.json');
    expect(result.currentChunkNumber).toBe(3);
    expect(result.completedChunks).toBe(2);
    expect(result.totalChunks).toBe(11);
    // Calculate remaining chunks
    const remainingChunks = result.totalChunks - result.completedChunks;
    expect(remainingChunks).toBe(9);

    // Should set chunk 3 as current
    expect(mockStorage.setCurrentChunk).toHaveBeenCalledWith(
      'object-chunk-03.json'
    );

    // Should NOT clear progress (we're not done with all chunks)
    expect(mockStorage.clearAutoChunkProgress).not.toHaveBeenCalled();
  });

  it('should handle the full progression through all 11 chunks', async () => {
    const mockFiles = [
      'object-chunk-01.json',
      'object-chunk-02.json',
      'object-chunk-03.json',
      'object-chunk-04.json',
      'object-chunk-05.json',
      'object-chunk-06.json',
      'object-chunk-07.json',
      'object-chunk-08.json',
      'object-chunk-09.json',
      'object-chunk-10.json',
      'object-chunk-11.json',
    ];

    (fs.readdir as Mock).mockResolvedValue(mockFiles);
    (fs.access as Mock).mockResolvedValue(undefined);
    (mockStorage.setCurrentChunk as Mock).mockResolvedValue(undefined);

    // Test progression through each chunk
    for (let i = 1; i <= 11; i++) {
      const completedChunks = [];
      for (let j = 1; j < i; j++) {
        completedChunks.push(
          `object-chunk-${j.toString().padStart(2, '0')}.json`
        );
      }

      const currentChunk =
        i > 1
          ? `object-chunk-${(i - 1).toString().padStart(2, '0')}.json`
          : null;

      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue({
        completedChunks,
        failedChunks: [],
        currentChunk,
        lastUpdated: new Date().toISOString(),
      });

      const result = await chunkManager.findNextChunkFile();

      if (i <= 11) {
        // Should pick the next chunk in sequence
        const expectedChunk = `object-chunk-${i.toString().padStart(2, '0')}.json`;
        expect(result.chunkFileName).toBe(expectedChunk);
        expect(result.currentChunkNumber).toBe(i);
        expect(result.completedChunks).toBe(i - 1);
        expect(result.totalChunks).toBe(11);
      }
    }

    // Now test when all 11 chunks are complete
    const allCompleted = mockFiles.slice(); // All 11 chunks
    (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue({
      completedChunks: allCompleted,
      failedChunks: [],
      currentChunk: 'object-chunk-11.json',
      lastUpdated: new Date().toISOString(),
    });

    const finalResult = await chunkManager.findNextChunkFile();

    // Should return null (all done) since cycling is disabled
    expect(finalResult.chunkFile).toBe(null);
    expect(finalResult.completedChunks).toBe(11);
    expect(finalResult.totalChunks).toBe(11);
    const finalRemainingChunks =
      finalResult.totalChunks - finalResult.completedChunks;
    expect(finalRemainingChunks).toBe(0);

    // Should NOT clear progress since cycling is disabled
    expect(mockStorage.clearAutoChunkProgress).not.toHaveBeenCalled();
  });

  it('should not cycle when only 2 out of 11 chunks are complete', async () => {
    const mockFiles = [
      'object-chunk-01.json',
      'object-chunk-02.json',
      'object-chunk-03.json',
      'object-chunk-04.json',
      'object-chunk-05.json',
      'object-chunk-06.json',
      'object-chunk-07.json',
      'object-chunk-08.json',
      'object-chunk-09.json',
      'object-chunk-10.json',
      'object-chunk-11.json',
    ];

    (fs.readdir as Mock).mockResolvedValue(mockFiles);
    (fs.access as Mock).mockResolvedValue(undefined);

    // Only chunks 1 and 2 are complete - should NOT trigger cycling
    (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue({
      completedChunks: ['object-chunk-01.json', 'object-chunk-02.json'],
      failedChunks: [],
      currentChunk: null,
      lastUpdated: new Date().toISOString(),
    });

    const result = await chunkManager.findNextChunkFile();

    // Should pick chunk 3, not cycle back to chunk 1
    expect(result.chunkFileName).toBe('object-chunk-03.json');
    expect(result.completedChunks).toBe(2);
    const remainingChunks = result.totalChunks - result.completedChunks;
    expect(remainingChunks).toBe(9);

    // Should definitely NOT clear progress
    expect(mockStorage.clearAutoChunkProgress).not.toHaveBeenCalled();
  });
});
