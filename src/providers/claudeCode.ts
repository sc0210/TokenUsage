import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  appendPrompt,
  appendRecord,
  appendUnattributedRecord,
} from '../aggregate';
import { SessionState, UsageRecord } from '../types';
import { ResolvedSession, UsageProvider } from './types';

/** Models the transcript writes for locally-generated, non-billable messages. */
const SYNTHETIC_MODEL = '<synthetic>';

/** Bytes read from the head of a transcript when sniffing its `cwd`. */
const CWD_SNIFF_BYTES = 64 * 1024;

export function expandHome(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Claude Code names a project directory after its cwd with `/` replaced by `-`.
 * That mapping is not reliably invertible (a path containing `-` collides), so
 * this is only ever used as a fast-path guess that is then confirmed against the
 * `cwd` recorded inside the transcript.
 */
export function encodeProjectDirName(workspaceFolderPath: string): string {
  return workspaceFolderPath.replace(/\//g, '-');
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Transcript files in a project directory, newest first. */
async function transcriptsByRecency(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const stats: Array<{ file: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) {
      continue;
    }
    const full = path.join(dir, entry);
    try {
      const st = await fsp.stat(full);
      if (st.isFile()) {
        stats.push({ file: full, mtimeMs: st.mtimeMs });
      }
    } catch {
      // Raced with a delete; skip it.
    }
  }
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stats.map((s) => s.file);
}

/**
 * Read the `cwd` a transcript records, without loading the whole file — these
 * reach several megabytes and we only need the first line that carries one.
 */
async function readRecordedCwd(filePath: string): Promise<string | null> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(filePath, 'r');
    const buffer = Buffer.alloc(CWD_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, CWD_SNIFF_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    // Drop a trailing fragment so JSON.parse only sees complete lines.
    const lines = text.split('\n');
    if (bytesRead === CWD_SNIFF_BYTES) {
      lines.pop();
    }
    for (const line of lines) {
      if (!line.includes('"cwd"')) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { cwd?: unknown };
        if (typeof parsed.cwd === 'string' && parsed.cwd.length > 0) {
          return parsed.cwd;
        }
      } catch {
        // Not valid JSON; keep looking.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/\/+$/, '');
  return norm(a) === norm(b);
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * True for lines that represent something the user actually typed.
 *
 * Most `user` lines are tool results being fed back to the model, not prompts —
 * across the transcripts on this machine they outnumber real prompts roughly
 * 16 to 1. Sidechain lines belong to sub-agents, and `isMeta` lines are
 * system-injected context, so neither opens a new prompt bucket.
 */
function extractPromptText(entry: Record<string, unknown>): string | null {
  if (entry.isSidechain === true || entry.isMeta === true) {
    return null;
  }
  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === 'string') {
    return content.trim().length > 0 ? content : null;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = block as { type?: unknown; text?: unknown };
      if (b?.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      }
    }
    const joined = parts.join('\n').trim();
    return joined.length > 0 ? joined : null;
  }
  return null;
}

function buildRecord(entry: Record<string, unknown>): UsageRecord | null {
  const message = entry.message as
    | { model?: unknown; usage?: Record<string, unknown> }
    | undefined;
  const model = typeof message?.model === 'string' ? message.model : '';
  if (!model || model === SYNTHETIC_MODEL) {
    return null;
  }
  const usage = message?.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  // `requestId` is the true unit of billing. A handful of lines lack one; the
  // per-line uuid keeps them distinct rather than collapsing them together.
  const requestId =
    (typeof entry.requestId === 'string' && entry.requestId) ||
    (typeof entry.uuid === 'string' && entry.uuid) ||
    '';
  if (!requestId) {
    return null;
  }

  const cacheCreationTotal = toNumber(usage.cache_creation_input_tokens);
  const breakdown = usage.cache_creation as Record<string, unknown> | undefined;
  let cacheWrite5m = toNumber(breakdown?.ephemeral_5m_input_tokens);
  let cacheWrite1h = toNumber(breakdown?.ephemeral_1h_input_tokens);
  if (cacheWrite5m + cacheWrite1h === 0 && cacheCreationTotal > 0) {
    // Older transcripts predate the 1-hour tier and carry no breakdown; the
    // 5-minute rate is the correct assumption for them.
    cacheWrite5m = cacheCreationTotal;
  }

  const timestamp =
    typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;

  return {
    requestId,
    timestampMs: Number.isNaN(timestamp) ? Date.now() : timestamp,
    model,
    input: toNumber(usage.input_tokens),
    output: toNumber(usage.output_tokens),
    cacheWrite5m,
    cacheWrite1h,
    cacheRead: toNumber(usage.cache_read_input_tokens),
  };
}

export class ClaudeCodeProvider implements UsageProvider {
  readonly id = 'claude-code';

  constructor(private readonly projectsRoot: string) {}

  static fromConfiguredPath(configured: string): ClaudeCodeProvider {
    const root = expandHome(configured?.trim() || '~/.claude/projects');
    return new ClaudeCodeProvider(root);
  }

  async resolveSession(
    workspaceFolderPath: string,
  ): Promise<ResolvedSession | null> {
    const projectDir = await this.resolveProjectDir(workspaceFolderPath);
    if (!projectDir) {
      return null;
    }
    const [primary] = await transcriptsByRecency(projectDir);
    if (!primary) {
      return null;
    }

    // Sub-agent turns are written to `<sessionId>/subagents/agent-*.jsonl`.
    // They are part of this session's spend but live outside the main file.
    const sessionId = path.basename(primary, '.jsonl');
    const subagentsDir = path.join(projectDir, sessionId, 'subagents');
    const auxiliary = await transcriptsByRecency(subagentsDir);

    const watchDirs = [projectDir];
    if (await isDirectory(subagentsDir)) {
      watchDirs.push(subagentsDir);
    }

    return { id: primary, primary, auxiliary, watchDirs };
  }

  /**
   * Find the project directory for a workspace folder.
   *
   * The encoded name is only a guess — the mapping is lossy, since a path
   * containing `-` encodes the same as one containing `/`. So the guess is
   * always confirmed against the `cwd` the transcript itself recorded, and an
   * unconfirmed guess falls through to a scan of every project directory.
   *
   * If nothing matches the folder exactly, ancestors are tried nearest-first:
   * opening `repo/frontend` in the editor while Claude Code ran at `repo`
   * should still surface that session rather than showing nothing.
   */
  async resolveProjectDir(workspaceFolderPath: string): Promise<string | null> {
    if (!(await isDirectory(this.projectsRoot))) {
      return null;
    }

    const guess = path.join(
      this.projectsRoot,
      encodeProjectDirName(workspaceFolderPath),
    );
    if (await isDirectory(guess)) {
      const [newest] = await transcriptsByRecency(guess);
      if (!newest) {
        return guess;
      }
      const cwd = await readRecordedCwd(newest);
      if (!cwd || samePath(cwd, workspaceFolderPath)) {
        return guess;
      }
    }

    const byCwd = await this.indexRecordedCwds();
    let current = path.resolve(workspaceFolderPath);
    for (;;) {
      const hit = byCwd.get(current.replace(/\/+$/, ''));
      if (hit) {
        return hit;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }

  /** Map of recorded cwd -> project directory, built from each dir's newest file. */
  private async indexRecordedCwds(): Promise<Map<string, string>> {
    const index = new Map<string, string>();
    let entries: string[];
    try {
      entries = await fsp.readdir(this.projectsRoot);
    } catch {
      return index;
    }
    for (const entry of entries) {
      const candidate = path.join(this.projectsRoot, entry);
      if (!(await isDirectory(candidate))) {
        continue;
      }
      const [newest] = await transcriptsByRecency(candidate);
      if (!newest) {
        continue;
      }
      const cwd = await readRecordedCwd(newest);
      if (cwd) {
        const key = path.resolve(cwd).replace(/\/+$/, '');
        // First writer wins; directories are traversed in readdir order and
        // duplicates would mean two projects claiming the same cwd.
        if (!index.has(key)) {
          index.set(key, candidate);
        }
      }
    }
    return index;
  }

  ingest(
    lines: readonly string[],
    state: SessionState,
    isPrimary: boolean,
  ): void {
    for (const raw of lines) {
      const line = raw.trim();
      if (line.length === 0 || line[0] !== '{') {
        continue;
      }
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (entry.type === 'user') {
        // Only the main transcript defines prompt boundaries. Every user line
        // in a sub-agent file is a sidechain, so none of them opens a prompt.
        if (!isPrimary) {
          continue;
        }
        const text = extractPromptText(entry);
        if (text !== null) {
          const ts =
            typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
          appendPrompt(state, text, Number.isNaN(ts) ? Date.now() : ts);
        }
        continue;
      }

      if (entry.type === 'assistant') {
        const record = buildRecord(entry);
        if (!record) {
          continue;
        }
        if (isPrimary) {
          appendRecord(state, record);
        } else {
          // Sub-agent spend belongs to the session; the prompt it belongs to is
          // resolved by timestamp, since these files are tailed independently.
          appendUnattributedRecord(state, record);
        }
      }
    }
  }
}

/** Exported for the fixture tests. */
export const __testing = {
  buildRecord,
  extractPromptText,
  transcriptsByRecency,
  readRecordedCwd,
  fsExists: (p: string) => fs.existsSync(p),
};
