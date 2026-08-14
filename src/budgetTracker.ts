import { BudgetReading, currentPeriod, daysLeft, readBudget } from './budget';
import { formatCost } from './format';
import { Pricer } from './pricing';
import { PeriodSpendSource } from './providers/types';

/**
 * How often period spend is recomputed.
 *
 * Much slower than the session poll on purpose. A month-to-date figure does not
 * meaningfully change in a minute, and for Cursor every refresh is a paginated
 * round trip to their dashboard endpoint.
 */
export const BUDGET_POLL_MS = 5 * 60_000;

export interface BudgetOptions {
  /** 0 disables the whole feature. */
  budgetUSD: number;
  cycleStartDay: number;
  thresholds: readonly number[];
}

/**
 * Where "already warned about this" is remembered. Narrowed to what is used so
 * the tracker can be exercised without a running editor; `vscode.Memento` fits.
 */
export interface NotifiedStore {
  get(key: string): number | undefined;
  update(key: string, value: number): unknown;
}

export interface BudgetTrackerDeps {
  source: PeriodSpendSource;
  /** Names the source in warnings, and scopes what has already been warned. */
  sourceId: string;
  sourceLabel: string;
  pricer: Pricer;
  options: BudgetOptions;
  onChange: (reading: BudgetReading | undefined) => void;
  store: NotifiedStore;
  warn: (message: string) => void;
  pollMs?: number;
  now?: () => number;
}

/**
 * Follows spend against a budget for one source, and warns as thresholds pass.
 *
 * Kept apart from `SessionTracker` because the two answer different questions:
 * that one follows the session in this workspace, this one follows the whole
 * account across every project, on a much slower timer.
 */
export class BudgetTracker {
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  private inFlight = false;
  private reading: BudgetReading | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: BudgetTrackerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  get current(): BudgetReading | undefined {
    return this.reading;
  }

  async start(): Promise<void> {
    await this.refresh();
    if (this.disposed || this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.deps.pollMs ?? BUDGET_POLL_MS);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.inFlight) {
      return;
    }
    const { options } = this.deps;
    if (!(options.budgetUSD > 0)) {
      this.publish(undefined);
      return;
    }

    this.inFlight = true;
    try {
      const period = currentPeriod(this.now(), options.cycleStartDay);
      const records = await this.deps.source.periodRecords(
        period.startMs,
        period.endMs,
      );
      if (this.disposed) {
        return;
      }
      const spent = this.deps.pricer.totalsOf(records).costUSD;
      const reading = readBudget(
        spent,
        options.budgetUSD,
        period,
        options.thresholds,
      );
      this.publish(reading);
      this.announce(reading);
    } catch {
      // A dropped connection or an unreadable transcript should leave the last
      // good figure on screen; the next tick tries again.
    } finally {
      this.inFlight = false;
    }
  }

  private publish(reading: BudgetReading | undefined): void {
    const changed =
      reading?.spentUSD !== this.reading?.spentUSD ||
      reading?.budgetUSD !== this.reading?.budgetUSD;
    this.reading = reading;
    if (changed) {
      this.deps.onChange(reading);
    }
  }

  /**
   * Warn once per threshold per period.
   *
   * Keyed on the period so a new cycle starts quiet again, and stored rather
   * than held in memory so reloading the window does not re-announce a
   * threshold that was passed days ago.
   */
  private announce(reading: BudgetReading): void {
    if (reading.reached <= 0) {
      return;
    }
    const key = `budget:${this.deps.sourceId}:${reading.period.key}`;
    const announced = this.deps.store.get(key) ?? 0;
    if (reading.reached <= announced) {
      return;
    }
    void this.deps.store.update(key, reading.reached);
    this.deps.warn(
      budgetWarning(reading, this.deps.sourceLabel, this.now()),
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/** The warning text. Pure, so the wording can be asserted directly. */
export function budgetWarning(
  reading: BudgetReading,
  sourceLabel: string,
  nowMs: number,
): string {
  const days = daysLeft(reading.period, nowMs);
  const left = `${days} day${days === 1 ? '' : 's'} left in this cycle`;
  if (reading.reached >= 100) {
    return (
      `Token Usage: ${sourceLabel} has used its whole ` +
      `${formatCost(reading.budgetUSD)} budget — ` +
      `${formatCost(reading.spentUSD)} spent, ${left}.`
    );
  }
  return (
    `Token Usage: ${sourceLabel} is at ${reading.reached}% of its ` +
    `${formatCost(reading.budgetUSD)} budget — ` +
    `${formatCost(reading.spentUSD)} spent, ${left}.`
  );
}
