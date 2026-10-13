/**
 * Programmatic API. The CLI is a thin wrapper over these exports.
 *
 *   import { loadConfig, createOrchestrator } from '@waxio/atomic-pinner';
 *   const result = await createOrchestrator(loadConfig()).run();
 */
export { loadConfig, redactConfig, ConfigError } from './config/load.js';
export { configSpec, configSchema, listOptions } from './config/schema.js';
export type { Config, ConfigOverrides } from './config/schema.js';
export { renderConfigReference, renderEnvExample } from './config/docs.js';

export {
  PinningOrchestrator,
  createOrchestrator,
} from './core/orchestrator.js';
export type {
  OrchestratorDeps,
  RunResult,
  CreateOrchestratorOptions,
} from './core/orchestrator.js';
export { PinService } from './core/pinService.js';
export type { PinOutcome, PinnedHashCache } from './core/pinService.js';
export { CollectionProcessor } from './core/collections.js';
export { TokenProcessor } from './core/tokens.js';
export { Storage, emptyState } from './core/storage.js';
export type {
  StorageData,
  CollectionProgress,
  AutoChunkProgress,
} from './core/storage.js';
export { ChunkManager } from './core/chunkManager.js';
export type { ChunkProgressInfo } from './core/chunkManager.js';
export { RunStats, HashTracker, writeHashReport } from './core/stats.js';
export type { PhaseStats, HashReport } from './core/stats.js';
export {
  loadTargets,
  splitTargets,
  writeChunks,
  pinTargetsSchema,
  TargetsError,
} from './core/targets.js';
export type { PinTargets, TokenTarget } from './core/targets.js';
export { resolveRateLimit, PLAN_PRESETS } from './core/rateLimit.js';
export type { RateLimit } from './core/rateLimit.js';
export {
  extractHashesFromAsset,
  extractHashesFromToken,
  fetchAndExtractTokenHashes,
} from './core/hashExtractor.js';

export { AtomicClient, AtomicApiError } from './atomic/client.js';
export type { AtomicAsset } from './atomic/client.js';

export {
  createProvider,
  createVerifier,
  createHashVerifier,
  PinataProvider,
  KuboProvider,
  ProviderError,
} from './ipfs/index.js';
export type {
  IPFSProvider,
  PinMetadata,
  HashVerifier,
  ApiFailureKind,
} from './ipfs/index.js';

export {
  createNotifiers,
  WebhookNotifier,
  SlackNotifier,
  formatSlackMessage,
} from './notify/index.js';
export type {
  Notifier,
  RunEvent,
  RunStartEvent,
  RunFinishEvent,
} from './notify/index.js';

export { createLogger, silentLogger } from './logging/logger.js';
export type { Logger, LogLevel, LogFormat } from './logging/logger.js';
export { createProgressReporter, noopProgress } from './logging/progress.js';
export type { ProgressReporter, ProgressBar } from './logging/progress.js';

export { createRetryFetch, FetchTimeoutError } from './net/fetchRetry.js';
export type { RetryFetch, RetryFetchOptions } from './net/fetchRetry.js';
