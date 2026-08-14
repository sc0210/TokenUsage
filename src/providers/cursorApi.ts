import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { appendPrompt, appendRecord } from '../aggregate';
import { SessionState, UsageRecord, createSessionState } from '../types';
import {
  describeBackend,
  prefixUpperBound,
  queryRows,
  resolveBackend,
} from './sqlite';
import { SnapshotProvider } from './types';

/**
 * Cursor's own dashboard endpoint. It reports what was actually charged, which
 * is the one number a local rate table can never derive: it depends on the
 * caller's plan, their tier, and whether a request was later refunded.
 */
const USAGE_EVENTS_URL =
  'https://cursor.com/api/dashboard/get-filtered-usage-events';

/** The endpoint rejects state-changing requests that arrive without an origin. */
const ORIGIN = 'https://cursor.com';

/** How far back a session is allowed to reach. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const PAGE_SIZE = 200;

/** Spend moves only when a turn completes, so a slow poll is plenty. */
const DEFAULT_POLL_MS = 60_000;

const REQUEST_TIMEOUT_MS = 20_000;

function globalStorageDir(): string {
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Cursor',
      'User',
    );
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      'Cursor',
      'User',
    );
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'User');
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface CursorAuth {
  token: string;
  userId: string;
}

/** Read the signed-in user's session token out of Cursor's global state. */
export async function readAuth(userDir: string): Promise<CursorAuth | null> {
  const db = path.join(userDir, 'globalStorage', 'state.vscdb');
  try {
    await fsp.access(db);
  } catch {
    return null;
  }
  let token: string;
  try {
    const rows = await queryRows(
      db,
      "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken';",
    );
    token = (rows[0]?.[0] ?? '').trim();
  } catch {
    return null;
  }
  if (!token) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }
  try {
    const claims = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as { sub?: unknown; exp?: unknown };
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
      return null;
    }
    // An expired token yields 401s; treating it as "not signed in" produces a
    // hidden item rather than an error badge on every poll.
    if (
      typeof claims.exp === 'number' &&
      Date.now() / 1000 > claims.exp
    ) {
      return null;
    }
    return { token, userId: claims.sub };
  } catch {
    return null;
  }
}

/**
 * Conversation ids belonging to a workspace folder.
 *
 * Cursor hashes each workspace into `workspaceStorage/<hash>/`, whose
 * `workspace.json` records the folder it stands for. `composerHeaders` then maps
 * conversations to that hash, which is what lets spend be reported per project
 * instead of per account.
 */
export async function workspaceIdFor(
  userDir: string,
  workspaceFolderPath: string,
): Promise<string | null> {
  const storageRoot = path.join(userDir, 'workspaceStorage');
  const target = path.resolve(workspaceFolderPath).replace(/\/+$/, '');

  let entries: string[];
  try {
    entries = await fsp.readdir(storageRoot);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const file = path.join(storageRoot, entry, 'workspace.json');
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as { folder?: unknown };
      if (typeof parsed.folder !== 'string') {
        continue;
      }
      const folder = path
        .resolve(decodeURIComponent(parsed.folder.replace(/^file:\/\//, '')))
        .replace(/\/+$/, '');
      if (folder === target) {
        return entry;
      }
    } catch {
      // Malformed workspace.json; keep looking.
    }
  }
  return null;
}

/**
 * When Cursor last did anything in this workspace, or 0 if never.
 *
 * Deliberately local-only: choosing between sources should not require a
 * network round trip, or an offline editor would silently stop offering Cursor.
 */
export async function lastActivityMs(
  userDir: string,
  workspaceFolderPath: string,
): Promise<number> {
  const workspaceId = await workspaceIdFor(userDir, workspaceFolderPath);
  if (!workspaceId) {
    return 0;
  }
  const db = path.join(userDir, 'globalStorage', 'state.vscdb');
  try {
    const rows = await queryRows(
      db,
      `SELECT MAX(COALESCE(lastUpdatedAt, createdAt)) FROM composerHeaders ` +
        `WHERE json_extract(value,'$.workspaceIdentifier.id')=${sqlQuote(
          workspaceId,
        )};`,
    );
    // No matching conversation yields either no row or a NULL one, depending on
    // the backend; both read as 0, meaning "never".
    const parsed = Number((rows[0]?.[0] ?? '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

export async function conversationIdsFor(
  userDir: string,
  workspaceFolderPath: string,
): Promise<string[]> {
  const workspaceId = await workspaceIdFor(userDir, workspaceFolderPath);
  if (!workspaceId) {
    return [];
  }

  const db = path.join(userDir, 'globalStorage', 'state.vscdb');
  try {
    const rows = await queryRows(
      db,
      `SELECT composerId FROM composerHeaders ` +
        `WHERE json_extract(value,'$.workspaceIdentifier.id')=${sqlQuote(
          workspaceId,
        )} ORDER BY COALESCE(lastUpdatedAt, createdAt) DESC;`,
    );
    return rows
      .map((row) => (row[0] ?? '').trim())
      .filter((id) => id.length > 0);
  } catch {
    return [];
  }
}

/** Prompt text for a conversation, oldest first, read from the local bubbles. */
export async function promptsFor(
  userDir: string,
  conversationId: string,
): Promise<string[]> {
  const db = path.join(userDir, 'globalStorage', 'state.vscdb');
  // A prefix range rather than a LIKE, so this seeks the key index instead of
  // scanning every bubble Cursor has ever stored. Newlines are flattened in SQL
  // because the CLI backend delimits rows with them.
  const prefix = `bubbleId:${conversationId}:`;
  try {
    const rows = await queryRows(
      db,
      `SELECT replace(replace(COALESCE(json_extract(value,'$.text'),''),char(10),' '),char(13),' ') ` +
        `FROM cursorDiskKV WHERE key >= ${sqlQuote(prefix)} AND key < ${sqlQuote(
          prefixUpperBound(prefix),
        )} AND json_extract(value,'$.type')=1 ORDER BY rowid;`,
    );
    return rows
      .map((row) => (row[0] ?? '').trim())
      .filter((text) => text.length > 0);
  } catch {
    return [];
  }
}

export interface UsageEvent {
  timestampMs: number;
  model: string;
  conversationId: string;
  input: number;
  output: number;
  cacheRead: number;
  costUSD: number;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  // The API returns 64-bit counters as strings so they survive JSON.
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Normalise one raw event, or null when it carries no usage. */
export function parseEvent(raw: unknown): UsageEvent | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const e = raw as Record<string, unknown>;
  const usage = e.tokenUsage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const timestampMs = toNumber(e.timestamp);
  if (timestampMs <= 0) {
    return null;
  }
  const input = toNumber(usage.inputTokens);
  const output = toNumber(usage.outputTokens);
  const cacheRead = toNumber(usage.cacheReadTokens);
  if (input + output + cacheRead === 0) {
    return null;
  }
  // `chargedCents` is what was actually billed; `totalCents` is the pre-discount
  // figure. Prefer the former so a discounted or refunded turn reads correctly.
  const cents =
    typeof e.chargedCents === 'number'
      ? toNumber(e.chargedCents)
      : toNumber(usage.totalCents);
  return {
    timestampMs,
    model: typeof e.model === 'string' ? e.model : 'unknown',
    conversationId:
      typeof e.conversationId === 'string' ? e.conversationId : '',
    input,
    output,
    cacheRead,
    costUSD: cents / 100,
  };
}

/** POST helper that keeps the session token out of any thrown message. */
async function postJson(
  url: string,
  body: unknown,
  auth: CursorAuth,
): Promise<unknown> {
  const cookie = `WorkosCursorSessionToken=${encodeURIComponent(
    `${auth.userId}::${auth.token}`,
  )}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Authorization: `Bearer ${auth.token}`,
        Origin: ORIGIN,
        Referer: `${ORIGIN}/dashboard`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Cursor usage API returned ${response.status}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchUsageEvents(
  auth: CursorAuth,
  sinceMs: number,
  nowMs: number,
): Promise<UsageEvent[]> {
  const payload = await postJson(
    USAGE_EVENTS_URL,
    {
      startDate: String(sinceMs),
      endDate: String(nowMs),
      page: 1,
      pageSize: PAGE_SIZE,
    },
    auth,
  );
  const list = (payload as { usageEventsDisplay?: unknown })
    ?.usageEventsDisplay;
  if (!Array.isArray(list)) {
    return [];
  }
  const events: UsageEvent[] = [];
  for (const raw of list) {
    const event = parseEvent(raw);
    if (event) {
      events.push(event);
    }
  }
  events.sort((a, b) => a.timestampMs - b.timestampMs);
  return events;
}

/**
 * Build a session from usage events and locally-stored prompt text.
 *
 * The API knows what each turn cost but not what was asked; the local database
 * knows the prompts but no longer records any token counts. Neither half is
 * sufficient alone, so they are zipped in order: both lists are chronological
 * and each prompt produces one billed turn. Any surplus event is kept
 * unattributed rather than dropped, so the total is never understated.
 */
export function buildState(
  sourceName: string,
  events: readonly UsageEvent[],
  prompts: readonly string[],
): SessionState {
  const state = createSessionState(sourceName);
  events.forEach((event, index) => {
    const record: UsageRecord = {
      // One billed event is one request; the timestamp keys it uniquely.
      requestId: `${event.conversationId}:${event.timestampMs}:${index}`,
      timestampMs: event.timestampMs,
      model: event.model,
      input: event.input,
      output: event.output,
      // The API reports no cache-write figure. Leaving these zero keeps the
      // token breakdown honest; cost does not depend on them here, because the
      // charged amount comes from the API rather than from a rate table.
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: event.cacheRead,
      costUSD: event.costUSD,
    };
    const promptText = prompts[index];
    if (promptText !== undefined) {
      appendPrompt(state, promptText, event.timestampMs);
    }
    appendRecord(state, record);
  });
  return state;
}

/**
 * Reads real Cursor spend from Cursor's own billing endpoint.
 *
 * This exists because the local database is a dead end: `tokenCount` is still in
 * the schema but Cursor stopped populating it around September 2025, so every
 * current turn stores zeros. Reading it would report $0.00 for live usage, which
 * is worse than reporting nothing.
 */
export class CursorApiProvider implements SnapshotProvider {
  readonly id = 'cursor';
  readonly pollIntervalMs = DEFAULT_POLL_MS;

  constructor(
    private readonly userDir: string = globalStorageDir(),
    private readonly lookbackMs: number = LOOKBACK_MS,
  ) {}

  async snapshot(workspaceFolderPath: string): Promise<SessionState | null> {
    const auth = await readAuth(this.userDir);
    if (!auth) {
      return null;
    }

    const conversationIds = await conversationIdsFor(
      this.userDir,
      workspaceFolderPath,
    );
    if (conversationIds.length === 0) {
      return null;
    }

    const now = Date.now();
    const events = await fetchUsageEvents(auth, now - this.lookbackMs, now);
    if (events.length === 0) {
      return null;
    }

    // Newest conversation first, so this is the one being worked in.
    const [active] = conversationIds;
    const mine = events.filter((e) => e.conversationId === active);
    if (mine.length === 0) {
      return null;
    }

    const prompts = await promptsFor(this.userDir, active);
    return buildState(active, mine, prompts);
  }

  /**
   * Explain, in one sentence, why this workspace shows nothing.
   *
   * Every failure here is silent by design — a hidden status bar item — so
   * without this there is no way to tell "not signed in" from "no spend yet".
   */
  async diagnose(workspaceFolderPath: string): Promise<string> {
    const backend = await resolveBackend();
    if (!backend) {
      return (
        'no SQLite is available — this host has neither a built-in `node:sqlite` ' +
        'nor a `sqlite3` on PATH, so Cursor\'s local state cannot be read.'
      );
    }

    const auth = await readAuth(this.userDir);
    if (!auth) {
      return (
        'not signed in to Cursor, or the stored session token has expired — ' +
        'sign in to Cursor and reload. (No login happens here; the existing ' +
        'Cursor session is reused.)'
      );
    }

    const workspaceId = await workspaceIdFor(this.userDir, workspaceFolderPath);
    if (!workspaceId) {
      return 'Cursor has never opened this folder, so no conversation maps to it.';
    }

    const conversationIds = await conversationIdsFor(
      this.userDir,
      workspaceFolderPath,
    );
    if (conversationIds.length === 0) {
      return 'Cursor has opened this folder but recorded no conversations in it.';
    }

    const now = Date.now();
    let events;
    try {
      events = await fetchUsageEvents(auth, now - this.lookbackMs, now);
    } catch (error) {
      return `the usage API call failed — ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    if (events.length === 0) {
      return `signed in, but Cursor reports no billed usage in the last ${Math.round(
        this.lookbackMs / 86_400_000,
      )} days.`;
    }
    const mine = events.filter((e) => e.conversationId === conversationIds[0]);
    if (mine.length === 0) {
      return (
        `${events.length} billed event(s) exist on this account, but none belong ` +
        `to this folder's newest conversation (${conversationIds[0]}).`
      );
    }
    return (
      `${mine.length} billed event(s) found for this folder ` +
      `(local state read through ${describeBackend(backend)}).`
    );
  }
}

export { globalStorageDir };

/** Exported for the tests. */
export const __testing = {
  parseEvent,
  buildState,
  globalStorageDir,
};
