import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ChunkManager } from './chunkManager.js';
import { Storage } from './Storage.js';

vi.mock('fs/promises');
vi.mock('./Storage.js');

describe('ChunkManager', () => {
  let chunkManager: ChunkManager;
  let mockStorage: Storage;
  const config = {
    chunkDirectory: './chunks',
    chunkPrefix: 'object-chunk',
    enableCycling: false,
  };

  beforeEach(() => {
    mockStorage = new Storage('test.json');
    chunkManager = new ChunkManager(config, mockStorage);
    vi.clearAllMocks();
  });

  describe('findChunkFiles', () => {
    it('should find and sort chunk files correctly', async () => {
      const mockFiles = [
        'object-chunk-03.json',
        'object-chunk-01.json',
        'other-file.txt',
        'object-chunk-02.json',
        'object-chunk-10.json',
      ];

      (fs.readdir as Mock).mockResolvedValue(mockFiles);

      const result = await chunkManager.findChunkFiles();

      expect(result).toEqual([
        'object-chunk-01.json',
        'object-chunk-02.json',
        'object-chunk-03.json',
        'object-chunk-10.json',
      ]);
      expect(fs.readdir).toHaveBeenCalledWith('./chunks');
    });

    it('should return empty array when directory read fails', async () => {
      (fs.readdir as Mock).mockRejectedValue(new Error('Directory not found'));

      const result = await chunkManager.findChunkFiles();

      expect(result).toEqual([]);
    });

    it('should filter files by prefix and extension', async () => {
      const mockFiles = [
        'object-chunk-01.json',
        'wrong-prefix-01.json',
        'object-chunk-02.txt',
        'object-chunk.json', // Missing number
      ];

      (fs.readdir as Mock).mockResolvedValue(mockFiles);

      const result = await chunkManager.findChunkFiles();

      expect(result).toEqual(['object-chunk-01.json']);
    });
  });

  describe('chunkFileExists', () => {
    it('should return true when file exists', async () => {
      (fs.access as Mock).mockResolvedValue(undefined);

      const result = await chunkManager.chunkFileExists('object-chunk-01.json');

      expect(result).toBe(true);
      expect(fs.access).toHaveBeenCalledWith(
        path.join('./chunks', 'object-chunk-01.json')
      );
    });

    it('should return false when file does not exist', async () => {
      (fs.access as Mock).mockRejectedValue(new Error('File not found'));

      const result = await chunkManager.chunkFileExists('object-chunk-01.json');

      expect(result).toBe(false);
    });
  });

  describe('findNextChunkFile', () => {
    it('should resume current incomplete chunk before moving to next', async () => {
      const mockProgress = {
        completedChunks: ['object-chunk-01.json'],
        failedChunks: [],
        currentChunk: 'object-chunk-02.json', // Current chunk not yet complete
        lastUpdated: new Date().toISOString(),
      };

      const mockFiles = [
        'object-chunk-01.json',
        'object-chunk-02.json',
        'object-chunk-03.json',
      ];

      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue(
        mockProgress
      );
      (fs.readdir as Mock).mockResolvedValue(mockFiles);

      const result = await chunkManager.findNextChunkFile();

      // Should resume chunk 2, not move to chunk 3
      expect(result).toMatchObject({
        chunkFile: path.join('./chunks', 'object-chunk-02.json'),
        chunkFileName: 'object-chunk-02.json',
        currentChunkNumber: 2,
        totalChunks: 3,
        completedChunks: 1,
        failedChunks: 0,
      });
    });

    it('should return next unprocessed chunk when no current chunk', async () => {
      const mockProgress = {
        completedChunks: ['object-chunk-01.json'],
        failedChunks: [],
        currentChunk: null,
        lastUpdated: new Date().toISOString(),
      };

      const mockFiles = [
        'object-chunk-01.json',
        'object-chunk-02.json',
        'object-chunk-03.json',
      ];

      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue(
        mockProgress
      );
      (fs.readdir as Mock).mockResolvedValue(mockFiles);

      const result = await chunkManager.findNextChunkFile();

      expect(result).toMatchObject({
        chunkFile: path.join('./chunks', 'object-chunk-02.json'),
        chunkFileName: 'object-chunk-02.json',
        currentChunkNumber: 2,
        totalChunks: 3,
        completedChunks: 1,
        failedChunks: 0,
      });
    });

    it('should move to next chunk when current chunk is completed', async () => {
      const mockProgress = {
        completedChunks: ['object-chunk-01.json', 'object-chunk-02.json'],
        failedChunks: [],
        currentChunk: 'object-chunk-02.json', // Current chunk IS complete
        lastUpdated: new Date().toISOString(),
      };

      const mockFiles = [
        'object-chunk-01.json',
        'object-chunk-02.json',
        'object-chunk-03.json',
      ];

      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue(
        mockProgress
      );
      (mockStorage.setCurrentChunk as Mock).mockResolvedValue(undefined);
      (fs.readdir as Mock).mockResolvedValue(mockFiles);

      const result = await chunkManager.findNextChunkFile();

      // Should clear the completed current chunk
      expect(mockStorage.setCurrentChunk).toHaveBeenCalledWith(null);
      // Should set the new chunk as current
      expect(mockStorage.setCurrentChunk).toHaveBeenCalledWith(
        'object-chunk-03.json'
      );

      // Should move to chunk 3 since chunk 2 is completed
      expect(result).toMatchObject({
        chunkFile: path.join('./chunks', 'object-chunk-03.json'),
        chunkFileName: 'object-chunk-03.json',
        currentChunkNumber: 3,
        totalChunks: 3,
        completedChunks: 2,
        failedChunks: 0,
      });
    });

    it('should automatically proceed to next chunk on subsequent run after completion', async () => {
      // Simulates: Run 1 completed chunk 1, Run 2 should start chunk 2
      const mockProgress = {
        completedChunks: ['object-chunk-01.json'],
        failedChunks: [],
        currentChunk: 'object-chunk-01.json', // Still set from last run
        lastUpdated: new Date().toISOString(),
      };

      const mockFiles = [
        'object-chunk-01.json',
        'object-chunk-02.json',
        'object-chunk-03.json',
      ];

      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue(
        mockProgress
      );
      (mockStorage.setCurrentChunk as Mock).mockResolvedValue(undefined);
      (fs.readdir as Mock).mockResolvedValue(mockFiles);

      const result = await chunkManager.findNextChunkFile();

      // Should recognize chunk 1 is complete and move to chunk 2
      expect(mockStorage.setCurrentChunk).toHaveBeenCalledWith(null);
      expect(mockStorage.setCurrentChunk).toHaveBeenCalledWith(
        'object-chunk-02.json'
      );

      expect(result).toMatchObject({
        chunkFile: path.join('./chunks', 'object-chunk-02.json'),
        chunkFileName: 'object-chunk-02.json',
        currentChunkNumber: 2,
        totalChunks: 3,
        completedChunks: 1,
        failedChunks: 0,
      });
    });

    it('should handle when current chunk no longer exists', async () => {
      const mockProgress = {
        completedChunks: ['object-chunk-01.json'],
        failedChunks: [],
        currentChunk: 'object-chunk-02.json', // Current chunk but file deleted
        lastUpdated: new Date().toISOString(),
      };

      const mockFiles = [
        'object-chunk-01.json',
        // object-chunk-02.json missing
        'object-chunk-03.json',
      ];

      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue(
        mockProgress
      );
      (mockStorage.setCurrentChunk as Mock).mockResolvedValue(undefined);
      (fs.readdir as Mock).mockResolvedValue(mockFiles);

      const result = await chunkManager.findNextChunkFile();

      // Should clear the missing chunk and set the new one
      expect(mockStorage.setCurrentChunk).toHaveBeenCalledWith(null);
      expect(mockStorage.setCurrentChunk).toHaveBeenCalledWith(
        'object-chunk-03.json'
      );

      // Should move to chunk 3 since chunk 2 doesn't exist
      expect(result).toMatchObject({
        chunkFile: path.join('./chunks', 'object-chunk-03.json'),
        chunkFileName: 'object-chunk-03.json',
        currentChunkNumber: 3,
        totalChunks: 2,
        completedChunks: 1,
        failedChunks: 0,
      });
    });

    it('should skip failed chunks initially', async () => {
      const mockProgress = {
        completedChunks: ['object-chunk-01.json'],
        failedChunks: ['object-chunk-02.json'],
        currentChunk: null,
        lastUpdated: new Date().toISOString(),
      };

      const mockFiles = [
        'object-chunk-01.json',
        'object-chunk-02.json',
        'object-chunk-03.json',
      ];

      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue(
        mockProgress
      );
      (fs.readdir as Mock).mockResolvedValue(mockFiles);

      const result = await chunkManager.findNextChunkFile();

      expect(result.chunkFileName).toBe('object-chunk-03.json');
    });

    it('should retry failed chunks when all new chunks are done', async () => {
      const mockProgress = {
        completedChunks: ['object-chunk-01.json', 'object-chunk-03.json'],
        failedChunks: ['object-chunk-02.json'],
        currentChunk: null,
        lastUpdated: new Date().toISOString(),
      };

      const mockFiles = [
        'object-chunk-01.json',
        'object-chunk-02.json',
        'object-chunk-03.json',
      ];

      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue(
        mockProgress
      );
      (fs.readdir as Mock).mockResolvedValue(mockFiles);
      (fs.access as Mock).mockResolvedValue(undefined); // File exists

      const result = await chunkManager.findNextChunkFile();

      expect(result.chunkFileName).toBe('object-chunk-02.json');
    });

    it('should return null when all chunks are completed', async () => {
      const mockProgress = {
        completedChunks: ['object-chunk-01.json', 'object-chunk-02.json'],
        failedChunks: [],
        currentChunk: null,
        lastUpdated: new Date().toISOString(),
      };

      const mockFiles = ['object-chunk-01.json', 'object-chunk-02.json'];

      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue(
        mockProgress
      );
      (fs.readdir as Mock).mockResolvedValue(mockFiles);

      const result = await chunkManager.findNextChunkFile();

      expect(result.chunkFile).toBe(null);
      expect(result.totalChunks).toBe(2);
      expect(result.completedChunks).toBe(2);
    });

    it('should cycle when enableCycling is true and all chunks are done', async () => {
      const chunkManagerWithCycling = new ChunkManager(
        { ...config, enableCycling: true },
        mockStorage
      );

      const mockProgress = {
        completedChunks: ['object-chunk-01.json', 'object-chunk-02.json'],
        failedChunks: [],
        currentChunk: null,
        lastUpdated: new Date().toISOString(),
      };

      const mockFiles = ['object-chunk-01.json', 'object-chunk-02.json'];

      (mockStorage.getAutoChunkProgress as Mock)
        .mockResolvedValueOnce(mockProgress)
        .mockResolvedValueOnce({
          // After clearing
          completedChunks: [],
          failedChunks: [],
          currentChunk: null,
          lastUpdated: new Date().toISOString(),
        });
      (fs.readdir as Mock).mockResolvedValue(mockFiles);

      const result = await chunkManagerWithCycling.findNextChunkFile();

      expect(mockStorage.clearAutoChunkProgress).toHaveBeenCalled();
      expect(result.chunkFileName).toBe('object-chunk-01.json');
      expect(result.completedChunks).toBe(0);
      expect(result.failedChunks).toBe(0);
    });

    it('should handle no chunk files found', async () => {
      const mockProgress = {
        completedChunks: [],
        failedChunks: [],
        currentChunk: null,
        lastUpdated: new Date().toISOString(),
      };

      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue(
        mockProgress
      );
      (fs.readdir as Mock).mockResolvedValue([]);

      const result = await chunkManager.findNextChunkFile();

      expect(result.chunkFile).toBe(null);
      expect(result.totalChunks).toBe(0);
    });
  });

  describe('chunk number extraction', () => {
    it('should extract chunk numbers correctly', async () => {
      const testCases = [
        { filename: 'object-chunk-01.json', expected: 1 },
        { filename: 'object-chunk-02.json', expected: 2 },
        { filename: 'object-chunk-10.json', expected: 10 },
        { filename: 'object-chunk-99.json', expected: 99 },
        { filename: 'object-chunk-100.json', expected: 100 },
      ];

      for (const { filename, expected } of testCases) {
        const mockProgress = {
          completedChunks: [],
          failedChunks: [],
          currentChunk: null,
          lastUpdated: new Date().toISOString(),
        };

        (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue(
          mockProgress
        );
        (fs.readdir as Mock).mockResolvedValue([filename]);

        const result = await chunkManager.findNextChunkFile();

        expect(result.currentChunkNumber).toBe(expected);
      }
    });
  });

  describe('chunk progression with completed chunks', () => {
    it('should complete ALL chunks before cycling (when cycling disabled)', async () => {
      // Ensure cycling is DISABLED
      const nonCyclingConfig = {
        ...config,
        enableCycling: false, // Should NOT cycle back to chunk 1
      };
      const nonCyclingManager = new ChunkManager(nonCyclingConfig, mockStorage);

      const mockFiles = [
        'object-chunk-01.json',
        'object-chunk-02.json',
        'object-chunk-03.json',
      ];

      (fs.readdir as Mock).mockResolvedValue(mockFiles);
      (mockStorage.setCurrentChunk as Mock).mockResolvedValue(undefined);

      // Scenario: Chunk 1 just completed, should move to chunk 2 (not restart at 1)
      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue({
        completedChunks: ['object-chunk-01.json'],
        failedChunks: [],
        currentChunk: 'object-chunk-01.json', // Just completed
        lastUpdated: new Date().toISOString(),
      });

      let result = await nonCyclingManager.findNextChunkFile();

      // Should move to chunk 2, NOT back to chunk 1
      expect(result.chunkFileName).toBe('object-chunk-02.json');
      expect(mockStorage.setCurrentChunk).toHaveBeenCalledWith(
        'object-chunk-02.json'
      );

      // Scenario: Chunk 2 just completed, should move to chunk 3
      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue({
        completedChunks: ['object-chunk-01.json', 'object-chunk-02.json'],
        failedChunks: [],
        currentChunk: 'object-chunk-02.json',
        lastUpdated: new Date().toISOString(),
      });

      result = await nonCyclingManager.findNextChunkFile();

      // Should move to chunk 3, NOT back to chunk 1
      expect(result.chunkFileName).toBe('object-chunk-03.json');

      // Scenario: All chunks completed, cycling disabled
      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue({
        completedChunks: [
          'object-chunk-01.json',
          'object-chunk-02.json',
          'object-chunk-03.json',
        ],
        failedChunks: [],
        currentChunk: 'object-chunk-03.json',
        lastUpdated: new Date().toISOString(),
      });

      result = await nonCyclingManager.findNextChunkFile();

      // Should return null (all done), NOT cycle back to chunk 1
      expect(result.chunkFile).toBe(null);
      expect(result.completedChunks).toBe(3);
      expect(result.totalChunks).toBe(3);

      // Verify clearAutoChunkProgress was NOT called (no cycling)
      expect(mockStorage.clearAutoChunkProgress).not.toHaveBeenCalled();
    });

    it('should progress through multiple chunks correctly', async () => {
      // Simulate progression: chunk1 complete -> move to chunk2 -> chunk2 complete -> move to chunk3
      const mockFiles = [
        'object-chunk-01.json',
        'object-chunk-02.json',
        'object-chunk-03.json',
      ];

      (fs.readdir as Mock).mockResolvedValue(mockFiles);
      (mockStorage.setCurrentChunk as Mock).mockResolvedValue(undefined);

      // Run 1: Starting fresh, should pick chunk 1
      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue({
        completedChunks: [],
        failedChunks: [],
        currentChunk: null,
        lastUpdated: new Date().toISOString(),
      });

      let result = await chunkManager.findNextChunkFile();
      expect(result.chunkFileName).toBe('object-chunk-01.json');
      expect(mockStorage.setCurrentChunk).toHaveBeenCalledWith(
        'object-chunk-01.json'
      );

      // Run 2: Chunk 1 complete, should move to chunk 2
      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue({
        completedChunks: ['object-chunk-01.json'],
        failedChunks: [],
        currentChunk: 'object-chunk-01.json', // Still set from last run
        lastUpdated: new Date().toISOString(),
      });

      result = await chunkManager.findNextChunkFile();
      expect(result.chunkFileName).toBe('object-chunk-02.json');
      expect(mockStorage.setCurrentChunk).toHaveBeenCalledWith(
        'object-chunk-02.json'
      );

      // Run 3: Chunk 2 complete, should move to chunk 3
      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue({
        completedChunks: ['object-chunk-01.json', 'object-chunk-02.json'],
        failedChunks: [],
        currentChunk: 'object-chunk-02.json',
        lastUpdated: new Date().toISOString(),
      });

      result = await chunkManager.findNextChunkFile();
      expect(result.chunkFileName).toBe('object-chunk-03.json');
      expect(mockStorage.setCurrentChunk).toHaveBeenCalledWith(
        'object-chunk-03.json'
      );

      // Run 4: All chunks complete
      (mockStorage.getAutoChunkProgress as Mock).mockResolvedValue({
        completedChunks: [
          'object-chunk-01.json',
          'object-chunk-02.json',
          'object-chunk-03.json',
        ],
        failedChunks: [],
        currentChunk: 'object-chunk-03.json',
        lastUpdated: new Date().toISOString(),
      });

      result = await chunkManager.findNextChunkFile();
      expect(result.chunkFile).toBe(null); // No more chunks
      expect(result.completedChunks).toBe(3);
    });
  });

  describe('displayChunkProgress', () => {
    it('should display progress information', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const chunkInfo = {
        chunkFile: './chunks/object-chunk-02.json',
        currentChunkNumber: 2,
        totalChunks: 5,
        completedChunks: 1,
        failedChunks: 0,
        chunkFileName: 'object-chunk-02.json',
      };

      chunkManager.displayChunkProgress(chunkInfo);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('AUTO-CHUNK PROGRESS')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Current Chunk: object-chunk-02.json (2/5)')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Completed Chunks: 1/5')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('20% complete')
      );

      consoleSpy.mockRestore();
    });

    it('should not display anything when chunkFile is null', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const chunkInfo = {
        chunkFile: null,
        currentChunkNumber: 0,
        totalChunks: 0,
        completedChunks: 0,
        failedChunks: 0,
        chunkFileName: '',
      };

      chunkManager.displayChunkProgress(chunkInfo);

      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});
