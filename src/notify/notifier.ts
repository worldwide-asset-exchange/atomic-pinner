import type { PhaseStats } from '../core/stats.js';
import type { ApiFailures } from '../core/storage.js';

export interface ChunkSummary {
  chunkFileName: string;
  currentChunkNumber: number;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
}

export interface RunStartEvent {
  event: 'start';
  startedAt: string;
  dryRun: boolean;
  provider: string;
  targetsFile?: string;
  chunk?: ChunkSummary;
  collections: number;
  tokens: number;
}

export interface RunFinishEvent {
  event: 'finish';
  startedAt: string;
  finishedAt: string;
  runtimeMs: number;
  success: boolean;
  error?: string;
  dryRun: boolean;
  provider: string;
  chunk?: ChunkSummary;
  chunkCompleted?: boolean;
  totals: PhaseStats;
  collections: PhaseStats;
  tokens: PhaseStats;
  uniqueHashes: number;
  notFoundHashes: number;
  apiFailures: ApiFailures;
  reportFile?: string;
}

export type RunEvent = RunStartEvent | RunFinishEvent;

/** Receives run lifecycle events. Implementations must not throw; failures are logged and ignored. */
export interface Notifier {
  readonly name: string;
  notify(event: RunEvent): Promise<void>;
}
