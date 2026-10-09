/**
 * Renders documentation from the config spec so the README table and `.env.example`
 * can never drift from the code. `scripts/update-docs.ts` writes them.
 */
import { configSpec, listOptions, type OptionSpec } from './schema.js';

const GROUP_TITLES: Record<keyof typeof configSpec, string> = {
  atomic: 'AtomicAssets API',
  targets: 'Targets',
  chunks: 'Chunk mode',
  processing: 'Processing',
  provider: 'IPFS provider',
  rateLimit: 'Rate limiting',
  tracking: 'Tracking and reports',
  state: 'State files',
  notifications: 'Notifications',
  logging: 'Logging',
};

export function formatDefault(spec: OptionSpec<unknown, unknown>): string {
  const value = spec.default;
  if (value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** Markdown table of every option, grouped. */
export function renderConfigReference(): string {
  const lines: string[] = [];
  let currentGroup: string | undefined;
  for (const { group, spec } of listOptions()) {
    if (group !== currentGroup) {
      if (currentGroup !== undefined) lines.push('');
      lines.push(
        `#### ${GROUP_TITLES[group]}`,
        '',
        '| Variable | Default | Description |',
        '|---|---|---|'
      );
      currentGroup = group;
    }
    const def = formatDefault(spec);
    lines.push(
      `| \`${spec.env}\` | ${def ? `\`${escapeCell(def)}\`` : ''} | ${escapeCell(spec.description)} |`
    );
  }
  return lines.join('\n') + '\n';
}

/** Contents of `.env.example`: every variable, commented out when it has a usable default. */
export function renderEnvExample(): string {
  const lines: string[] = [
    '# atomic-pinner configuration. Copy to .env and edit.',
    '# Every variable is optional unless noted; an empty value means "use the default".',
    '# Generated from src/config/schema.ts by `yarn docs` — do not edit by hand.',
  ];
  let currentGroup: string | undefined;
  for (const { group, spec } of listOptions()) {
    if (group !== currentGroup) {
      lines.push('', `# ----- ${GROUP_TITLES[group]} -----`);
      currentGroup = group;
    }
    lines.push('');
    for (const sentence of wrap(spec.description, 96))
      lines.push(`# ${sentence}`);
    const def = formatDefault(spec);
    if (spec.secret || spec.example) {
      lines.push(`${spec.env}=${spec.example ?? ''}`);
    } else if (def) {
      lines.push(`# ${spec.env}=${def}`);
    } else {
      lines.push(`# ${spec.env}=`);
    }
  }
  return lines.join('\n') + '\n';
}

function wrap(text: string, width: number): string[] {
  const words = text.split(' ');
  const out: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}
