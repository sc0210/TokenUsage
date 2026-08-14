/**
 * Budget arithmetic. Free of any `vscode` import, so period boundaries — the
 * part with all the calendar edge cases — can be checked directly.
 */

export interface Period {
  startMs: number;
  /** Exclusive. */
  endMs: number;
  /** Stable identity, so a warning fires once per cycle rather than per poll. */
  key: string;
}

export const DEFAULT_THRESHOLDS: readonly number[] = [75, 90, 100];

/** Clamped rather than rejected: a nonsense setting should still bill monthly. */
function normaliseCycleDay(day: number): number {
  if (!Number.isFinite(day)) {
    return 1;
  }
  return Math.min(31, Math.max(1, Math.round(day)));
}

/**
 * Local midnight on the cycle day of a given month.
 *
 * Day 0 of the following month is the last day of this one, which is what keeps
 * a cycle starting on the 31st landing somewhere real in February. Local time
 * rather than UTC: a billing day is the date the user sees on a calendar.
 */
function cycleStart(year: number, monthIndex: number, day: number): Date {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  return new Date(year, monthIndex, Math.min(day, lastDay), 0, 0, 0, 0);
}

function isoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The billing period `nowMs` falls in, for a cycle starting on `cycleStartDay`. */
export function currentPeriod(nowMs: number, cycleStartDay: number): Period {
  const day = normaliseCycleDay(cycleStartDay);
  const now = new Date(nowMs);

  let start = cycleStart(now.getFullYear(), now.getMonth(), day);
  if (now.getTime() < start.getTime()) {
    // Before this month's cycle day, so the period began last month. A negative
    // month index rolls the year back on its own.
    start = cycleStart(now.getFullYear(), now.getMonth() - 1, day);
  }
  const end = cycleStart(start.getFullYear(), start.getMonth() + 1, day);

  return { startMs: start.getTime(), endMs: end.getTime(), key: isoDate(start) };
}

export interface BudgetReading {
  spentUSD: number;
  /** 0 means no budget is configured, which disables every derived figure. */
  budgetUSD: number;
  period: Period;
  /** Spend as a share of budget, or 0 when no budget is set. */
  fraction: number;
  remainingUSD: number;
  overUSD: number;
  /**
   * Highest configured threshold the spend has reached, as a percentage, or 0.
   *
   * A level rather than an event: comparing it against the highest level already
   * announced this period makes the warning fire once per threshold without
   * needing to have observed the crossing, which a reloaded window never did.
   */
  reached: number;
}

export function readBudget(
  spentUSD: number,
  budgetUSD: number,
  period: Period,
  thresholds: readonly number[] = DEFAULT_THRESHOLDS,
): BudgetReading {
  const spent = Number.isFinite(spentUSD) && spentUSD > 0 ? spentUSD : 0;
  const budget = Number.isFinite(budgetUSD) && budgetUSD > 0 ? budgetUSD : 0;
  const fraction = budget > 0 ? spent / budget : 0;

  let reached = 0;
  if (budget > 0) {
    for (const threshold of thresholds) {
      if (
        Number.isFinite(threshold) &&
        threshold > reached &&
        fraction * 100 >= threshold
      ) {
        reached = threshold;
      }
    }
  }

  return {
    spentUSD: spent,
    budgetUSD: budget,
    period,
    fraction,
    remainingUSD: Math.max(0, budget - spent),
    overUSD: Math.max(0, spent - budget),
    reached,
  };
}

/** Whole days remaining in the period, rounded up; never negative. */
export function daysLeft(period: Period, nowMs: number): number {
  return Math.max(0, Math.ceil((period.endMs - nowMs) / 86_400_000));
}

/** Percentages, sorted and de-duplicated; falls back to the defaults if empty. */
export function normaliseThresholds(values: unknown): readonly number[] {
  if (!Array.isArray(values)) {
    return DEFAULT_THRESHOLDS;
  }
  const cleaned = [
    ...new Set(
      values
        .map((v) => (typeof v === 'number' ? v : Number(v)))
        .filter((v) => Number.isFinite(v) && v > 0),
    ),
  ].sort((a, b) => a - b);
  return cleaned.length > 0 ? cleaned : DEFAULT_THRESHOLDS;
}
