import { Totals, UsageRecord, emptyTotals } from './types';

export interface ModelRate {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

/**
 * Cache multipliers are applied to the model's *input* rate.
 * A 5-minute cache write costs 1.25x input, a 1-hour write 2x, a read 0.1x.
 */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;
export const CACHE_READ_MULTIPLIER = 0.1;

export const DEFAULT_RATES: Readonly<Record<string, ModelRate>> = {
  'claude-fable-5': { input: 10.0, output: 50.0 },
  'claude-mythos-5': { input: 10.0, output: 50.0 },
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-opus-4-7': { input: 5.0, output: 25.0 },
  'claude-opus-4-6': { input: 5.0, output: 25.0 },
  'claude-opus-4-5': { input: 5.0, output: 25.0 },
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
};

/**
 * Unknown models bill at the Opus rate rather than zero. A model released after
 * this table was written should read as expensive-but-approximate, never free —
 * a silent $0.00 is the one failure mode that makes the whole readout a lie.
 */
export const FALLBACK_RATE: ModelRate = { input: 5.0, output: 25.0 };

export class Pricer {
  private readonly rates: Record<string, ModelRate>;

  constructor(overrides: Record<string, Partial<ModelRate>> = {}) {
    this.rates = { ...DEFAULT_RATES };
    for (const [model, rate] of Object.entries(overrides ?? {})) {
      const base = this.rates[model] ?? FALLBACK_RATE;
      this.rates[model] = {
        input: typeof rate?.input === 'number' ? rate.input : base.input,
        output: typeof rate?.output === 'number' ? rate.output : base.output,
      };
    }
  }

  isKnown(model: string): boolean {
    return model in this.rates;
  }

  rateFor(model: string): ModelRate {
    return this.rates[model] ?? FALLBACK_RATE;
  }

  costOf(record: UsageRecord): number {
    // A source that knows what it was charged always wins over the rate table.
    if (typeof record.costUSD === 'number' && Number.isFinite(record.costUSD)) {
      return record.costUSD;
    }
    const { input: inRate, output: outRate } = this.rateFor(record.model);
    const inputUnits =
      record.input +
      record.cacheWrite5m * CACHE_WRITE_5M_MULTIPLIER +
      record.cacheWrite1h * CACHE_WRITE_1H_MULTIPLIER +
      record.cacheRead * CACHE_READ_MULTIPLIER;
    return (inputUnits * inRate + record.output * outRate) / 1_000_000;
  }

  totalsOf(records: readonly UsageRecord[]): Totals {
    const totals = emptyTotals();
    for (const record of records) {
      totals.input += record.input;
      totals.output += record.output;
      totals.cacheWrite5m += record.cacheWrite5m;
      totals.cacheWrite1h += record.cacheWrite1h;
      totals.cacheRead += record.cacheRead;
      totals.requests += 1;
      totals.costUSD += this.costOf(record);
      totals.weightedInput +=
        record.input +
        record.cacheWrite5m * CACHE_WRITE_5M_MULTIPLIER +
        record.cacheWrite1h * CACHE_WRITE_1H_MULTIPLIER +
        record.cacheRead * CACHE_READ_MULTIPLIER;
    }
    return totals;
  }

  /**
   * Models present in these records that the rate table does not cover, so the
   * UI can say the cost is an estimate rather than quietly implying precision.
   */
  unknownModelsIn(records: readonly UsageRecord[]): string[] {
    const unknown = new Set<string>();
    for (const record of records) {
      // A record priced by its source is exact whether or not the rate table has
      // heard of the model, so flagging it would report precision as doubt.
      if (typeof record.costUSD === 'number') {
        continue;
      }
      if (!this.isKnown(record.model)) {
        unknown.add(record.model);
      }
    }
    return [...unknown];
  }

  /** Totals split by model, for sessions that span more than one. */
  totalsByModel(records: readonly UsageRecord[]): Map<string, Totals> {
    const byModel = new Map<string, UsageRecord[]>();
    for (const record of records) {
      const bucket = byModel.get(record.model);
      if (bucket) {
        bucket.push(record);
      } else {
        byModel.set(record.model, [record]);
      }
    }
    const out = new Map<string, Totals>();
    for (const [model, group] of byModel) {
      out.set(model, this.totalsOf(group));
    }
    return out;
  }
}

/**
 * Share of input-side tokens served from cache. Cache writes count against the
 * rate: a turn that rewrote the whole prefix did not "hit" anything.
 */
export function cacheHitRate(totals: Totals): number {
  const denominator =
    totals.cacheRead + totals.cacheWrite5m + totals.cacheWrite1h + totals.input;
  return denominator === 0 ? 0 : totals.cacheRead / denominator;
}
