import { SessionState, UsageRecord } from '../types';

/**
 * One logical session, which may span several files. Claude Code writes the
 * main transcript as `<sessionId>.jsonl` and each sub-agent's turns to
 * `<sessionId>/subagents/agent-*.jsonl`; all of it is the same session's spend.
 */
export interface ResolvedSession {
  /** Stable identity. A change here means we switched sessions. */
  id: string;
  /** The transcript that defines prompt boundaries. */
  primary: string;
  /** Further files contributing requests but never prompts. */
  auxiliary: string[];
  /** Directories to watch for appends and for newly created files. */
  watchDirs: string[];
}

/**
 * A source that rebuilds its whole state each time rather than being tailed.
 *
 * Not every source is an append-only file. Cursor's spend lives behind an HTTP
 * endpoint that returns the current window on every call, with no notion of a
 * byte offset to resume from, so it is polled and re-read whole. The tracker
 * branches on which of the two interfaces a provider implements.
 */
export interface SnapshotProvider {
  readonly id: string;

  /** How often to re-poll, in milliseconds. */
  readonly pollIntervalMs: number;

  /** Build the complete state for this workspace, or null if there is none. */
  snapshot(workspaceFolderPath: string): Promise<SessionState | null>;
}

export function isSnapshotProvider(
  provider: UsageProvider | SnapshotProvider,
): provider is SnapshotProvider {
  return typeof (provider as SnapshotProvider).snapshot === 'function';
}

/**
 * A source that can report what an agent billed over a span of time.
 *
 * Deliberately account-wide rather than per-workspace: a budget is a property
 * of the plan being paid for, so spend from every project has to count against
 * it. That makes this a different question from the one the session providers
 * answer, which is why it is a separate capability rather than another field on
 * `SessionState`.
 *
 * Records are returned rather than a total because only the caller holds the
 * `Pricer`, and pricing has to stay in one place: it is what decides whether a
 * source's own cost figure or the rate table wins.
 */
export interface PeriodSpendSource {
  periodRecords(startMs: number, endMs: number): Promise<UsageRecord[]>;
}

export function isPeriodSpendSource(
  provider: unknown,
): provider is PeriodSpendSource {
  return (
    typeof (provider as PeriodSpendSource | undefined)?.periodRecords ===
    'function'
  );
}

/**
 * A source of token-usage records that is followed as it is appended to.
 *
 * The interface is here so a new file-shaped source can be added by
 * implementing these two methods without touching the tailer, the aggregator,
 * or any UI code.
 */
export interface UsageProvider {
  readonly id: string;

  /** The active session for this workspace folder, or null if there is none. */
  resolveSession(workspaceFolderPath: string): Promise<ResolvedSession | null>;

  /**
   * Parse newly appended lines, mutating `state`. Malformed lines are skipped.
   * `isPrimary` distinguishes the prompt-defining transcript from auxiliary
   * files, whose requests are attributed by timestamp instead.
   */
  ingest(
    lines: readonly string[],
    state: SessionState,
    isPrimary: boolean,
  ): void;
}
