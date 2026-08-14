import { PromptBucket, SessionState, UsageRecord } from './types';

/** Longest prompt excerpt we retain; the UI truncates further. */
const MAX_PROMPT_CHARS = 400;

export function appendPrompt(
  state: SessionState,
  text: string,
  timestampMs: number,
): void {
  state.prompts.push({
    promptText: text.slice(0, MAX_PROMPT_CHARS),
    startedAtMs: timestampMs,
    records: [],
  });
}

/**
 * Record one API request.
 *
 * Returns false when the request was already seen. One API response is written
 * to the transcript as several lines — one per content block (thinking, text,
 * each tool_use) — and every one repeats the same `message.usage`. The request
 * id is the unit of truth, not the line; counting lines inflates cost severalfold.
 *
 * A request that arrives with no prompt open is kept as unattributed rather
 * than discarded — see `SessionState.unattributedRecords`.
 */
export function appendRecord(state: SessionState, record: UsageRecord): boolean {
  if (state.seenRequestIds.has(record.requestId)) {
    return false;
  }
  state.seenRequestIds.add(record.requestId);

  const current = state.prompts[state.prompts.length - 1];
  if (current) {
    current.records.push(record);
  } else {
    state.unattributedRecords.push(record);
  }
  return true;
}

/** Record a request that belongs to the session but to no prompt of its own. */
export function appendUnattributedRecord(
  state: SessionState,
  record: UsageRecord,
): boolean {
  if (state.seenRequestIds.has(record.requestId)) {
    return false;
  }
  state.seenRequestIds.add(record.requestId);
  state.unattributedRecords.push(record);
  return true;
}

/** Everything billed in this session, attributed or not. */
export function allRecords(state: SessionState): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const prompt of state.prompts) {
    out.push(...prompt.records);
  }
  out.push(...state.unattributedRecords);
  return out;
}

/**
 * Prompts with unattributed records folded in by timestamp.
 *
 * Sub-agent files are tailed independently of the main transcript, so their
 * records can be parsed before or after the prompt that spawned them. Resolving
 * ownership here — at read time, over the whole state — makes the result
 * independent of the order the files happened to be read in.
 */
export function effectivePrompts(state: SessionState): PromptBucket[] {
  if (state.unattributedRecords.length === 0) {
    return state.prompts;
  }

  const merged: PromptBucket[] = state.prompts.map((prompt) => ({
    promptText: prompt.promptText,
    startedAtMs: prompt.startedAtMs,
    records: [...prompt.records],
  }));
  if (merged.length === 0) {
    return merged;
  }

  for (const record of state.unattributedRecords) {
    // Last prompt that had already started when this request was made.
    let index = -1;
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      if (merged[i].startedAtMs <= record.timestampMs) {
        index = i;
        break;
      }
    }
    // Predates every prompt: attribute to the first rather than lose it.
    merged[index === -1 ? 0 : index].records.push(record);
  }

  for (const prompt of merged) {
    prompt.records.sort((a, b) => a.timestampMs - b.timestampMs);
  }
  return merged;
}

/** The most recent prompt that actually produced requests. */
export function lastActivePrompt(state: SessionState): PromptBucket | undefined {
  const prompts = effectivePrompts(state);
  for (let i = prompts.length - 1; i >= 0; i -= 1) {
    if (prompts[i].records.length > 0) {
      return prompts[i];
    }
  }
  return undefined;
}

export function promptCount(state: SessionState): number {
  return state.prompts.length;
}

/** Wall-clock span from the first prompt to the newest request. */
export function elapsedMs(state: SessionState): number {
  const first = state.prompts[0];
  if (!first) {
    return 0;
  }
  let latest = first.startedAtMs;
  for (const record of allRecords(state)) {
    if (record.timestampMs > latest) {
      latest = record.timestampMs;
    }
  }
  return Math.max(0, latest - first.startedAtMs);
}
