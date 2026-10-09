import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PinOutcome } from './pinService.js';

export interface PhaseStats {
  hashesFound: number;
  uniqueHashes: number;
  duplicatesAvoided: number;
  pinned: number;
  alreadyPinned: number;
  missing: number;
  failed: number;
}

export type Phase = 'collections' | 'tokens';

const emptyPhase = (): PhaseStats => ({
  hashesFound: 0,
  uniqueHashes: 0,
  duplicatesAvoided: 0,
  pinned: 0,
  alreadyPinned: 0,
  missing: 0,
  failed: 0,
});

export class RunStats {
  readonly startedAt = Date.now();
  readonly collections = emptyPhase();
  readonly tokens = emptyPhase();

  phase(name: Phase): PhaseStats {
    return name === 'collections' ? this.collections : this.tokens;
  }

  recordOutcome(name: Phase, outcome: PinOutcome): void {
    const p = this.phase(name);
    switch (outcome) {
      case 'pinned':
      case 'would-pin':
        p.pinned += 1;
        break;
      case 'cached':
      case 'already-pinned':
        p.alreadyPinned += 1;
        break;
      case 'missing':
        p.missing += 1;
        break;
    }
  }

  get runtimeMs(): number {
    return Date.now() - this.startedAt;
  }

  totals(): PhaseStats {
    const t = emptyPhase();
    for (const p of [this.collections, this.tokens]) {
      for (const key of Object.keys(t) as (keyof PhaseStats)[])
        t[key] += p[key];
    }
    return t;
  }
}

export interface HashSource {
  kind: 'collection' | 'token';
  /** Collection name or token id. */
  id: string;
  assetId?: string;
}

export interface NotFoundDetail {
  cid: string;
  source: HashSource;
  schemaName?: string;
  templateId?: string;
  assetName?: string;
}

export interface HashReport {
  generatedAt: string;
  summary: {
    uniqueHashes: number;
    inCollections: number;
    inTokens: number;
    notFound: number;
    notFoundPercent: number;
  };
  hashes: Record<
    string,
    { collections: string[]; tokens: string[]; assets: string[] }
  >;
  notFound: NotFoundDetail[];
}

/** Optional analytics. Safe to disable on huge collections; the pin decision chain never depends on it. */
export class HashTracker {
  private readonly sources = new Map<
    string,
    { collections: Set<string>; tokens: Set<string>; assets: Set<string> }
  >();
  private readonly notFound: NotFoundDetail[] = [];
  private readonly notFoundCids = new Set<string>();

  constructor(
    private readonly options: { trackUnique: boolean; trackNotFound: boolean }
  ) {}

  seen(cid: string, source: HashSource): void {
    if (!this.options.trackUnique) return;
    let entry = this.sources.get(cid);
    if (!entry) {
      entry = { collections: new Set(), tokens: new Set(), assets: new Set() };
      this.sources.set(cid, entry);
    }
    if (source.kind === 'collection') {
      entry.collections.add(source.id);
      if (source.assetId) entry.assets.add(source.assetId);
    } else {
      entry.tokens.add(source.id);
    }
  }

  markNotFound(detail: NotFoundDetail): void {
    if (!this.options.trackNotFound) return;
    this.notFoundCids.add(detail.cid);
    this.notFound.push(detail);
  }

  get uniqueCount(): number {
    return this.sources.size;
  }

  get notFoundCount(): number {
    return this.notFoundCids.size;
  }

  report(): HashReport {
    const hashes: HashReport['hashes'] = {};
    let inCollections = 0;
    let inTokens = 0;
    for (const [cid, entry] of this.sources) {
      if (entry.collections.size > 0) inCollections += 1;
      if (entry.tokens.size > 0) inTokens += 1;
      hashes[cid] = {
        collections: [...entry.collections],
        tokens: [...entry.tokens],
        assets: [...entry.assets],
      };
    }
    const unique = this.sources.size;
    return {
      generatedAt: new Date().toISOString(),
      summary: {
        uniqueHashes: unique,
        inCollections,
        inTokens,
        notFound: this.notFoundCids.size,
        notFoundPercent:
          unique > 0
            ? Math.round((this.notFoundCids.size / unique) * 1000) / 10
            : 0,
      },
      hashes,
      notFound: this.notFound,
    };
  }
}

export async function writeHashReport(
  dir: string,
  report: HashReport
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const file = path.join(dir, `hash-report-${stamp}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  return file;
}
