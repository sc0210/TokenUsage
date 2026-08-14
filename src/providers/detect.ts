import * as fsp from 'fs/promises';

import { ClaudeCodeProvider } from './claudeCode';
import {
  CursorApiProvider,
  globalStorageDir,
  lastActivityMs as cursorLastActivityMs,
} from './cursorApi';
import { SnapshotProvider, UsageProvider } from './types';

export type ProviderKind = 'claude-code' | 'cursor';

export interface SourceActivity {
  kind: ProviderKind;
  /** Epoch ms of the last thing this source did here; 0 means never. */
  lastActivityMs: number;
}

/**
 * When Claude Code last wrote a transcript for this workspace.
 *
 * The transcript's mtime is the signal rather than anything inside it: it is one
 * stat call against a file that may be many megabytes, and it moves on exactly
 * the events we care about.
 */
export async function claudeCodeActivity(
  provider: ClaudeCodeProvider,
  workspaceFolderPath: string,
): Promise<number> {
  const session = await provider.resolveSession(workspaceFolderPath);
  if (!session) {
    return 0;
  }
  try {
    return (await fsp.stat(session.primary)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Rank the sources that have any history for this workspace, newest first.
 *
 * Which editor the extension happens to be running in is deliberately *not* a
 * signal. Claude Code runs in a terminal, and that terminal is very often
 * Cursor's own — so being hosted in Cursor says nothing about which agent is
 * spending. Both sources are probed locally instead, and the one that actually
 * did something most recently wins. Probing is local for both: a transcript stat
 * and one SQLite read, so no network call is needed to make the choice.
 */
export async function detectSources(
  workspaceFolderPath: string,
  claudeProjectsPath: string,
  cursorUserDir: string = globalStorageDir(),
): Promise<SourceActivity[]> {
  const claude = ClaudeCodeProvider.fromConfiguredPath(claudeProjectsPath);
  const [claudeMs, cursorMs] = await Promise.all([
    claudeCodeActivity(claude, workspaceFolderPath).catch(() => 0),
    cursorLastActivityMs(cursorUserDir, workspaceFolderPath).catch(() => 0),
  ]);

  return (
    [
      { kind: 'claude-code' as const, lastActivityMs: claudeMs },
      { kind: 'cursor' as const, lastActivityMs: cursorMs },
    ]
      .filter((s) => s.lastActivityMs > 0)
      // Ties are impossible in practice; if one happens, order is stable.
      .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
  );
}

export function instantiate(
  kind: ProviderKind,
  claudeProjectsPath: string,
): UsageProvider | SnapshotProvider {
  return kind === 'cursor'
    ? new CursorApiProvider()
    : ClaudeCodeProvider.fromConfiguredPath(claudeProjectsPath);
}

export interface Selection {
  provider: UsageProvider | SnapshotProvider | undefined;
  /** The source being read, or undefined when nothing has history here. */
  active: ProviderKind | undefined;
  /** Sources with history that are not being read, newest first. */
  others: SourceActivity[];
}

/**
 * Choose the source to read for a workspace.
 *
 * An explicit `claude-code` or `cursor` is honoured as-is — someone who has
 * pinned a source should not have it switched out from under them. `auto` picks
 * the most recently active, and reports the runners-up so the UI can say that
 * the other source has spend too rather than appearing to lose it.
 */
export async function selectProvider(
  configured: string,
  workspaceFolderPath: string,
  claudeProjectsPath: string,
  cursorUserDir: string = globalStorageDir(),
): Promise<Selection> {
  if (configured === 'claude-code' || configured === 'cursor') {
    return {
      provider: instantiate(configured, claudeProjectsPath),
      active: configured,
      others: [],
    };
  }
  if (configured !== 'auto') {
    // 'custom' and anything unrecognised report nothing rather than guess.
    return { provider: undefined, active: undefined, others: [] };
  }

  const sources = await detectSources(
    workspaceFolderPath,
    claudeProjectsPath,
    cursorUserDir,
  );
  if (sources.length === 0) {
    return { provider: undefined, active: undefined, others: [] };
  }
  const [winner, ...rest] = sources;
  return {
    provider: instantiate(winner.kind, claudeProjectsPath),
    active: winner.kind,
    others: rest,
  };
}

export const SOURCE_LABELS: Readonly<Record<ProviderKind, string>> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
};
