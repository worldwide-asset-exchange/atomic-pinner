import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

export const tokenTargetSchema = z.object({
  chain: z.string().min(1),
  address: z.string().min(1),
  /** URL (ideally an IPFS gateway URL) of the token's metadata JSON. Nested CIDs are pinned too. */
  metadataUrl: z.string().url().optional(),
  /** Inline metadata; any CIDs found in it are pinned. */
  metadata: z.record(z.unknown()).optional(),
});

export const pinTargetsSchema = z.object({
  collection: z.array(z.string().min(1)).default([]),
  token: z.array(tokenTargetSchema).default([]),
});

export type TokenTarget = z.infer<typeof tokenTargetSchema>;
export type PinTargets = z.infer<typeof pinTargetsSchema>;

export const tokenId = (token: TokenTarget): string =>
  `${token.chain}:${token.address}`;

export class TargetsError extends Error {
  constructor(
    public readonly file: string,
    message: string
  ) {
    super(`${file}: ${message}`);
    this.name = 'TargetsError';
  }
}

export async function loadTargets(file: string): Promise<PinTargets> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    throw new TargetsError(
      file,
      `cannot read file (${(error as Error).message})`
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new TargetsError(file, `invalid JSON (${(error as Error).message})`);
  }
  const parsed = pinTargetsSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join('.') || '<root>'}: ${i.message}`
    );
    throw new TargetsError(file, `invalid targets: ${issues.join('; ')}`);
  }
  return parsed.data;
}

/** Split targets into chunks of `perChunk` collections. Tokens travel with the first chunk. */
export function splitTargets(
  targets: PinTargets,
  perChunk: number
): PinTargets[] {
  if (perChunk < 1) throw new Error('perChunk must be >= 1');
  const chunks: PinTargets[] = [];
  for (let i = 0; i < targets.collection.length; i += perChunk) {
    chunks.push({
      collection: targets.collection.slice(i, i + perChunk),
      token: [],
    });
  }
  if (chunks.length === 0) chunks.push({ collection: [], token: [] });
  chunks[0].token = targets.token;
  return chunks;
}

export interface WriteChunksOptions {
  targets: PinTargets;
  directory: string;
  prefix: string;
  perChunk: number;
}

/** Write `<prefix>-01.json`, `<prefix>-02.json`, … and return their paths. */
export async function writeChunks(
  options: WriteChunksOptions
): Promise<string[]> {
  const chunks = splitTargets(options.targets, options.perChunk);
  await fs.mkdir(options.directory, { recursive: true });
  const width = Math.max(2, String(chunks.length).length);
  const files: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const file = path.join(
      options.directory,
      `${options.prefix}-${String(index + 1).padStart(width, '0')}.json`
    );
    await fs.writeFile(file, JSON.stringify(chunk, null, 2) + '\n');
    files.push(file);
  }
  return files;
}
