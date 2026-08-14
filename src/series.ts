/**
 * Turning parsed usage into the sequences the dashboard plots.
 *
 * Separate from the charts themselves so the arithmetic — which day a record
 * belongs to, what "on pace" means a third of the way through a cycle — can be
 * checked without going anywhere near SVG.
 */

import { effectivePrompts } from './aggregate';
import { Period } from './budget';
import { Pricer } from './pricing';
import { SessionState, Totals, UsageRecord } from './types';

export interface PromptPoint {
  /** 1-based, matching the numbering in the per-prompt table. */
  index: number;
  startedAtMs: number;
  promptText: string;
  totals: Totals;
}

/**
 * One entry per prompt that actually billed something.
 *
 * Prompts with no requests are dropped rather than plotted as zero: they are
 * usually a message that was interrupted or answered from cache alone, and a
 * run of zero bars in the middle of a session reads as a bug.
 */
export function promptSeries(
  state: SessionState,
  pricer: Pricer,
): PromptPoint[] {
  return effectivePrompts(state)
    .filter((prompt) => prompt.records.length > 0)
    .map((prompt, index) => ({
      index: index + 1,
      startedAtMs: prompt.startedAtMs,
      promptText: prompt.promptText,
      totals: pricer.totalsOf(prompt.records),
    }));
}

export interface DayPoint {
  /** Local midnight beginning the day. */
  dayMs: number;
  costUSD: number;
  /** Spend from the start of the period through the end of this day. */
  cumulativeUSD: number;
  requests: number;
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function nextLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/**
 * Daily spend across a period, up to today.
 *
 * Days with no activity are kept as zeros. Dropping them would compress the
 * gaps and make a week off look like a week of steady spend, which is the
 * opposite of what the chart is for. Days are stepped through the calendar
 * rather than by adding 24 hours, so a daylight-saving change does not shift
 * every subsequent bucket by an hour.
 */
export function dailySpend(
  records: readonly UsageRecord[],
  period: Period,
  pricer: Pricer,
  nowMs: number = Date.now(),
): DayPoint[] {
  const byDay = new Map<number, { cost: number; requests: number }>();
  for (const record of records) {
    if (record.timestampMs < period.startMs || record.timestampMs >= period.endMs) {
      continue;
    }
    const day = startOfLocalDay(record.timestampMs);
    const bucket = byDay.get(day) ?? { cost: 0, requests: 0 };
    bucket.cost += pricer.costOf(record);
    bucket.requests += 1;
    byDay.set(day, bucket);
  }

  const last = startOfLocalDay(Math.min(nowMs, period.endMs - 1));
  const out: DayPoint[] = [];
  let cumulative = 0;
  for (
    let day = startOfLocalDay(period.startMs);
    day <= last;
    day = nextLocalDay(day)
  ) {
    const bucket = byDay.get(day);
    cumulative += bucket?.cost ?? 0;
    out.push({
      dayMs: day,
      costUSD: bucket?.cost ?? 0,
      cumulativeUSD: cumulative,
      requests: bucket?.requests ?? 0,
    });
  }
  return out;
}

/** How far through the period `nowMs` is, clamped to 0..1. */
export function periodElapsedFraction(period: Period, nowMs: number): number {
  const span = period.endMs - period.startMs;
  if (span <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, (nowMs - period.startMs) / span));
}

/**
 * What would have been spent by now at an even rate — the line to be under.
 *
 * Even pacing is a crude model of how anyone actually works, but it is the one
 * a monthly budget implies, and it answers the question being asked: am I ahead
 * of where this month can afford me to be.
 */
export function budgetPace(
  period: Period,
  budgetUSD: number,
  nowMs: number,
): number {
  return budgetUSD * periodElapsedFraction(period, nowMs);
}

/**
 * Spend projected to the end of the period at the rate observed so far.
 *
 * Undefined for the first few hours of a cycle, where dividing by a tiny
 * elapsed fraction turns one expensive session into an absurd forecast.
 */
export function projectedSpend(
  spentUSD: number,
  period: Period,
  nowMs: number,
): number | undefined {
  const elapsed = periodElapsedFraction(period, nowMs);
  return elapsed >= 0.05 ? spentUSD / elapsed : undefined;
}

/**
 * Least-squares slope over a series, in units per step.
 *
 * Used to say whether cost per prompt is drifting up across a session, which a
 * bar chart shows but does not quantify. Needs at least three points to mean
 * anything.
 */
export function trendPerStep(values: readonly number[]): number | undefined {
  const n = values.length;
  if (n < 3) {
    return undefined;
  }
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    numerator += (i - meanX) * (values[i] - meanY);
    denominator += (i - meanX) ** 2;
  }
  return denominator === 0 ? undefined : numerator / denominator;
}
