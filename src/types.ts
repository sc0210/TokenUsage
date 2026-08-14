/**
 * Core data shapes. Deliberately free of any `vscode` import so the parsing and
 * costing logic can be exercised by a plain node script against real transcripts.
 */

/** One deduplicated API request. */
export interface UsageRecord {
  /** `requestId`, or the line `uuid` when the transcript omits a request id. */
  requestId: string;
  timestampMs: number;
  model: string;
  input: number;
  output: number;
  /** Cache writes at the 5-minute TTL, billed at 1.25x input. */
  cacheWrite5m: number;
  /** Cache writes at the 1-hour TTL, billed at 2x input. */
  cacheWrite1h: number;
  /** Cache reads, billed at 0.1x input. */
  cacheRead: number;
  /**
   * Cost as reported by the source, when the source actually knows it.
   *
   * Claude Code transcripts carry no cost, so those records leave this unset and
   * are priced from the rate table. Cursor's billing API reports what it charged,
   * which beats any local estimate — a rate table cannot know about the caller's
   * plan, tier, or refunds.
   */
  costUSD?: number;
}

/** One user turn and every API request it triggered, sub-agents included. */
export interface PromptBucket {
  promptText: string;
  startedAtMs: number;
  records: UsageRecord[];
}

/**
 * Parse state for a single transcript. `seenRequestIds` is what prevents the
 * multi-content-block duplication from being counted more than once.
 */
export interface SessionState {
  sourcePath: string;
  prompts: PromptBucket[];
  seenRequestIds: Set<string>;
  /**
   * Requests with no prompt of their own: sub-agent turns (which live in
   * separate files and whose every user line is a sidechain), plus anything
   * preceding the first prompt in a transcript that begins mid-conversation.
   *
   * They are real spend, so they always count toward session totals; for
   * per-prompt display they are attributed by timestamp. Dropping them
   * under-reports cost — on this machine that was ~1M cache-write tokens.
   */
  unattributedRecords: UsageRecord[];
}

export function createSessionState(sourcePath: string): SessionState {
  return {
    sourcePath,
    prompts: [],
    seenRequestIds: new Set(),
    unattributedRecords: [],
  };
}

/** Token totals plus the cost they add up to. */
export interface Totals {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  requests: number;
  costUSD: number;
  /**
   * Input-side tokens expressed in full-price-input equivalents, so the figure
   * tracks spend instead of being swamped by cheap cache reads.
   */
  weightedInput: number;
}

export function emptyTotals(): Totals {
  return {
    input: 0,
    output: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    requests: 0,
    costUSD: 0,
    weightedInput: 0,
  };
}
