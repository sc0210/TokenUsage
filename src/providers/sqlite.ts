import { execFile } from 'child_process';
import * as fsSync from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** One row, as strings, in the order the columns were selected. */
export type Row = readonly string[];

export type BackendKind = 'node:sqlite' | 'sqlite3-cli';

/**
 * Field separator for the CLI backend. The default is `|`, which occurs in
 * prompt text; a unit separator does not.
 */
const CLI_SEPARATOR = '\x1f';

const CLI_TIMEOUT_MS = 10_000;

const CLI_MAX_BUFFER = 8 * 1024 * 1024;

interface StatementLike {
  all(): unknown[];
}

interface DatabaseLike {
  prepare(sql: string): StatementLike;
  close(): void;
}

type DatabaseCtor = new (
  path: string,
  options?: { readOnly?: boolean },
) => DatabaseLike;

let nodeCtor: DatabaseCtor | null | undefined;

/**
 * Node's built-in SQLite, when the host exposes it.
 *
 * This is the reason the extension needs nothing installed: `sqlite3` is
 * present on macOS and most Linux images but is absent from a default Windows,
 * where the CLI backend therefore reads nothing at all. The module is resolved
 * through a guarded `require` because hosts older than Node 22 do not have it
 * and must keep working.
 */
function nodeSqlite(): DatabaseCtor | null {
  if (nodeCtor === undefined) {
    nodeCtor = null;
    try {
      const mod = require('node:sqlite') as { DatabaseSync?: DatabaseCtor };
      if (typeof mod?.DatabaseSync === 'function') {
        nodeCtor = mod.DatabaseSync;
      }
    } catch {
      // No built-in SQLite on this host; the CLI covers it.
    }
  }
  return nodeCtor;
}

/**
 * A GUI-launched editor inherits a minimal PATH, not a login shell's. The
 * absolute path is tried first so the lookup does not depend on how the app was
 * started; a bare name is the fallback for platforms that put it elsewhere.
 */
let cliPath: string | undefined;

function sqlite3Path(): string {
  if (cliPath === undefined) {
    cliPath = fsSync.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';
  }
  return cliPath;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  // Cursor declares both of its key-value tables as BLOB and stores JSON text
  // in them, so the built-in backend hands back bytes where the CLI prints
  // characters. Decoding here keeps the two backends interchangeable.
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8');
  }
  return String(value);
}

/**
 * Read-only matters: the database is open in another process while we read it.
 */
function queryNode(ctor: DatabaseCtor, dbPath: string, sql: string): Row[] {
  const db = new ctor(dbPath, { readOnly: true });
  try {
    return db
      .prepare(sql)
      .all()
      .map((row) => Object.values(row as Record<string, unknown>).map(cell));
  } finally {
    db.close();
  }
}

async function queryCli(dbPath: string, sql: string): Promise<Row[]> {
  const { stdout } = await execFileAsync(
    sqlite3Path(),
    ['-separator', CLI_SEPARATOR, `file:${dbPath}?mode=ro`, sql],
    { timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER },
  );
  // The CLI delimits rows with newlines, so a value containing one would split
  // into two rows. Callers strip newlines in SQL where a column can hold them.
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split(CLI_SEPARATOR));
}

/**
 * Run a read-only query, using whichever backend this host has.
 *
 * The built-in module is preferred: it needs no external program and spawns no
 * process. It is also synchronous, which is only acceptable because every query
 * here is index-bound — see `prefixUpperBound` for the one that was not.
 */
export async function queryRows(dbPath: string, sql: string): Promise<Row[]> {
  const ctor = nodeSqlite();
  if (!ctor) {
    return queryCli(dbPath, sql);
  }
  try {
    return queryNode(ctor, dbPath, sql);
  } catch (error) {
    // A database left with a stale write-ahead log needs recovery, which a
    // read-only open cannot perform; the CLI sometimes still manages it.
    try {
      return await queryCli(dbPath, sql);
    } catch {
      throw error;
    }
  }
}

/** Which backend will serve queries, or undefined when the host has neither. */
export async function resolveBackend(): Promise<BackendKind | undefined> {
  if (nodeSqlite()) {
    return 'node:sqlite';
  }
  try {
    await execFileAsync(sqlite3Path(), ['-version'], { timeout: 5_000 });
    return 'sqlite3-cli';
  } catch {
    return undefined;
  }
}

export function describeBackend(kind: BackendKind): string {
  return kind === 'node:sqlite'
    ? "Node's built-in SQLite"
    : `the \`${sqlite3Path()}\` command`;
}

/**
 * Exclusive upper bound for a prefix scan, so `key LIKE 'p%'` can be written as
 * `key >= 'p' AND key < upper`.
 *
 * This is not a micro-optimisation. `LIKE` is case-insensitive by default, so
 * SQLite cannot use the index behind it and falls back to scanning the table —
 * on a real 958 MB `state.vscdb` that is 767 ms per read, against 5 ms for the
 * range scan, which is the difference between the built-in backend being safe
 * to call synchronously and not.
 */
export function prefixUpperBound(prefix: string): string {
  if (prefix.length === 0) {
    return prefix;
  }
  const last = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

/** Exported for the tests. */
export const __testing = {
  nodeSqlite,
  queryNode,
  queryCli,
  sqlite3Path,
};
