import * as fs from 'fs';
import * as fsp from 'fs/promises';

const NEWLINE = 0x0a;

export interface TailResult {
  lines: string[];
  /** True when the file shrank, meaning any state built from it is stale. */
  reset: boolean;
}

/**
 * Reads only what has been appended since the last call.
 *
 * The leftover fragment is kept as a Buffer rather than a string: transcripts
 * are appended to while we read them, so a read can land mid-line *and*
 * mid-UTF-8-sequence. Decoding before the line boundary is known would corrupt
 * any multi-byte character straddling the split.
 */
export class FileTailer {
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);

  constructor(readonly filePath: string) {}

  /** Forget everything read so far; the next call re-reads from byte zero. */
  rewind(): void {
    this.offset = 0;
    this.pending = Buffer.alloc(0);
  }

  async readNew(): Promise<TailResult> {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(this.filePath);
    } catch {
      return { lines: [], reset: false };
    }

    let reset = false;
    if (stat.size < this.offset) {
      // Truncated or rotated. Anything derived from the old contents is void.
      this.rewind();
      reset = true;
    }
    if (stat.size === this.offset) {
      return { lines: [], reset };
    }

    const chunks: Buffer[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(this.filePath, {
          start: this.offset,
          end: stat.size - 1, // inclusive
        });
        stream.on('data', (chunk) => chunks.push(chunk as Buffer));
        stream.on('end', () => resolve());
        stream.on('error', reject);
      });
    } catch {
      return { lines: [], reset };
    }

    const read = Buffer.concat(chunks);
    this.offset += read.length;

    const buffer = Buffer.concat([this.pending, read]);
    const lastNewline = buffer.lastIndexOf(NEWLINE);
    if (lastNewline === -1) {
      this.pending = buffer;
      return { lines: [], reset };
    }

    const complete = buffer.subarray(0, lastNewline).toString('utf8');
    // Copy, so the trailing fragment does not retain the whole read buffer.
    this.pending = Buffer.from(buffer.subarray(lastNewline + 1));

    return {
      lines: complete.length > 0 ? complete.split('\n') : [],
      reset,
    };
  }
}

export interface WatcherOptions {
  debounceMs?: number;
  pollMs?: number;
}

/**
 * Watches a directory for transcript activity.
 *
 * Uses `fs.watch` rather than VS Code's FileSystemWatcher because the target
 * lives outside the workspace, where VS Code's watcher coverage is unreliable.
 * A slow interval poll backs it up, since `fs.watch` can miss events on network
 * or virtualised filesystems and silently stops if the directory is replaced.
 */
export class SourceWatcher {
  private watcher: fs.FSWatcher | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly dir: string,
    private readonly onChange: () => void,
    private readonly options: WatcherOptions = {},
  ) {}

  start(): void {
    const { debounceMs = 300, pollMs = 10_000 } = this.options;

    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, () => {
        this.schedule(debounceMs);
      });
      this.watcher.on('error', () => {
        // Directory went away or the handle broke; the poll keeps us alive.
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      this.watcher = undefined;
    }

    this.pollTimer = setInterval(() => this.schedule(0), pollMs);
    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
  }

  private schedule(delayMs: number): void {
    if (this.disposed) {
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (!this.disposed) {
        this.onChange();
      }
    }, delayMs);
    if (typeof this.debounceTimer.unref === 'function') {
      this.debounceTimer.unref();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;
  }
}
