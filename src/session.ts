import * as path from 'path';

import {
  ResolvedSession,
  SnapshotProvider,
  UsageProvider,
  isSnapshotProvider,
} from './providers/types';
import { FileTailer, SourceWatcher } from './providers/tail';
import { SessionState, createSessionState } from './types';

/** How often to retry locating a session when none has been found yet. */
const DISCOVERY_RETRY_MS = 15_000;

export type SessionListener = (state: SessionState | undefined) => void;

/**
 * Cheap fingerprint of a state, to decide whether a poll actually changed
 * anything. Repainting on every tick would rebuild the tooltip on a timer even
 * when the numbers are identical.
 */
function summarise(state: SessionState | null | undefined): string {
  if (!state) {
    return '';
  }
  return `${state.sourcePath}|${state.prompts.length}|${state.seenRequestIds.size}|${state.unattributedRecords.length}`;
}

/**
 * Owns "the session currently being written for this workspace": finding it,
 * following every file that contributes to it, and switching when a new one
 * starts.
 */
export class SessionTracker {
  private state: SessionState | undefined;
  private session: ResolvedSession | undefined;
  private readonly tailers = new Map<string, FileTailer>();
  private readonly watchers = new Map<string, SourceWatcher>();
  private discoveryTimer: NodeJS.Timeout | undefined;

  private refreshing = false;
  private refreshQueued = false;
  private disposed = false;
  /** Ensures the first resolution always renders, even with nothing to report. */
  private hasNotified = false;

  private pollTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly provider: UsageProvider | SnapshotProvider,
    private readonly workspaceFolderPath: string,
    private readonly listener: SessionListener,
  ) {}

  async start(): Promise<void> {
    await this.refresh();
  }

  /**
   * Re-resolve the session and consume anything appended since last time.
   * Safe to call concurrently: overlapping calls collapse into one trailing run.
   */
  async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshQueued = false;
        await this.refreshOnce();
      } while (this.refreshQueued && !this.disposed);
    } finally {
      this.refreshing = false;
    }
  }

  /** Discard parsed state and re-read every file from the beginning. */
  async rebuild(): Promise<void> {
    for (const tailer of this.tailers.values()) {
      tailer.rewind();
    }
    if (this.session) {
      this.state = createSessionState(this.session.primary);
    }
    // An explicit refresh command should always repaint, even if the re-read
    // happens to produce nothing.
    this.hasNotified = false;
    await this.refresh();
  }

  private async refreshOnce(): Promise<void> {
    if (isSnapshotProvider(this.provider)) {
      await this.refreshSnapshot(this.provider);
      return;
    }
    const session = await this.provider.resolveSession(this.workspaceFolderPath);

    if (!session) {
      const hadSession = this.session !== undefined;
      this.teardownSources();
      this.session = undefined;
      this.state = undefined;
      this.ensureDiscoveryTimer();
      // Likewise: the 15s discovery retry should not re-render on every tick
      // while a workspace simply has no Claude Code history.
      if (hadSession || !this.hasNotified) {
        this.hasNotified = true;
        this.listener(undefined);
      }
      return;
    }

    this.clearDiscoveryTimer();

    const sessionChanged = session.id !== this.session?.id;
    if (sessionChanged) {
      this.tailers.clear();
      this.state = createSessionState(session.primary);
    }
    this.session = session;

    this.syncWatchers(session.watchDirs);

    // Primary first: it defines the prompt buckets that auxiliary records are
    // attributed against. (Attribution is by timestamp, so this is for
    // tidiness rather than correctness.)
    const files = [session.primary, ...session.auxiliary];
    const live = new Set(files);
    for (const known of [...this.tailers.keys()]) {
      if (!live.has(known)) {
        this.tailers.delete(known);
      }
    }

    let sawReset = false;
    const batches: Array<{ lines: string[]; isPrimary: boolean }> = [];

    for (const file of files) {
      let tailer = this.tailers.get(file);
      if (!tailer) {
        tailer = new FileTailer(file);
        this.tailers.set(file, tailer);
      }
      const { lines, reset } = await tailer.readNew();
      if (reset) {
        sawReset = true;
      }
      if (lines.length > 0) {
        batches.push({ lines, isPrimary: file === session.primary });
      }
    }

    if (sawReset) {
      // A file shrank. Partial state built from it is unsound, so rebuild the
      // whole session rather than trying to reconcile which parts survived.
      for (const tailer of this.tailers.values()) {
        tailer.rewind();
      }
      this.state = createSessionState(session.primary);
      const rebuilt: Array<{ lines: string[]; isPrimary: boolean }> = [];
      for (const file of files) {
        const tailer = this.tailers.get(file);
        if (!tailer) {
          continue;
        }
        const { lines } = await tailer.readNew();
        if (lines.length > 0) {
          rebuilt.push({ lines, isPrimary: file === session.primary });
        }
      }
      batches.length = 0;
      batches.push(...rebuilt);
    }

    const state = this.state;
    if (state) {
      for (const batch of batches) {
        this.provider.ingest(batch.lines, state, batch.isPrimary);
      }
    }

    // The 10s safety-net poll fires whether or not anything was written. Only
    // notify when something actually changed, so an idle editor is not
    // rebuilding the tooltip six times a minute for the life of the window.
    const changed = sessionChanged || sawReset || batches.length > 0;
    if (changed || !this.hasNotified) {
      this.hasNotified = true;
      this.listener(this.state);
    }
  }

  /**
   * Re-read a polled source in full.
   *
   * There is nothing to tail and no offset to resume from, so the previous
   * state is replaced outright. The timer keeps running whether or not the last
   * call succeeded: a poll that failed on a dropped connection should be retried
   * rather than ending the session.
   */
  private async refreshSnapshot(provider: SnapshotProvider): Promise<void> {
    let next: SessionState | null = null;
    try {
      next = await provider.snapshot(this.workspaceFolderPath);
    } catch {
      // Leave the last good state on screen rather than blanking the item on a
      // transient network failure.
      this.ensurePollTimer(provider.pollIntervalMs);
      return;
    }

    this.ensurePollTimer(provider.pollIntervalMs);

    const had = this.state !== undefined;
    const changed =
      (next === null) !== !had ||
      summarise(next) !== summarise(this.state);
    this.state = next ?? undefined;

    if (changed || !this.hasNotified) {
      this.hasNotified = true;
      this.listener(this.state);
    }
  }

  private ensurePollTimer(intervalMs: number): void {
    if (this.pollTimer || this.disposed) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
  }

  private syncWatchers(dirs: readonly string[]): void {
    const wanted = new Set(dirs);
    for (const [dir, watcher] of [...this.watchers]) {
      if (!wanted.has(dir)) {
        watcher.dispose();
        this.watchers.delete(dir);
      }
    }
    for (const dir of wanted) {
      if (this.watchers.has(dir)) {
        continue;
      }
      const watcher = new SourceWatcher(dir, () => {
        void this.refresh();
      });
      watcher.start();
      this.watchers.set(dir, watcher);
    }
  }

  /**
   * With no session found there is no directory to watch, so poll for one.
   * Watching the projects root instead would fire on every project's activity.
   */
  private ensureDiscoveryTimer(): void {
    if (this.discoveryTimer) {
      return;
    }
    this.discoveryTimer = setInterval(() => {
      void this.refresh();
    }, DISCOVERY_RETRY_MS);
    if (typeof this.discoveryTimer.unref === 'function') {
      this.discoveryTimer.unref();
    }
  }

  private clearDiscoveryTimer(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = undefined;
    }
  }

  private teardownSources(): void {
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();
    this.tailers.clear();
  }

  get sessionName(): string | undefined {
    if (this.session) {
      return path.basename(this.session.primary, '.jsonl');
    }
    // A polled source has no file behind it; its state names itself.
    return this.state ? this.state.sourcePath : undefined;
  }

  /** Number of files currently being followed, for the details view. */
  get sourceCount(): number {
    if (this.session) {
      return 1 + this.session.auxiliary.length;
    }
    return this.state ? 1 : 0;
  }

  dispose(): void {
    this.disposed = true;
    this.clearDiscoveryTimer();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.teardownSources();
  }
}
