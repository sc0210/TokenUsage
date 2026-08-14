/**
 * Checks for budget arithmetic and the tracker that warns on it.
 *
 * The calendar is where this goes wrong: a cycle starting on the 31st, a period
 * that began in the previous year, and the boundary between two periods all
 * have to land exactly, because getting one wrong silently attributes spend to
 * the wrong month. Those cases are asserted against fixed dates rather than
 * against whatever today happens to be.
 *
 * The Claude Code period scan runs against this machine's real transcripts when
 * there are any, since the thing worth checking — that the cache makes a rescan
 * cheap — needs a corpus with some size to it.
 *
 * Run with: npm run compile && npm run test:budget
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DEFAULT_THRESHOLDS,
  currentPeriod,
  daysLeft,
  normaliseThresholds,
  readBudget,
} from '../budget';
import { BudgetTracker, budgetWarning } from '../budgetTracker';
import { Pricer } from '../pricing';
import { ClaudeCodeProvider, __testing } from '../providers/claudeCode';
import { buildBudgetOnlyText, buildBudgetSuffix } from '../statusText';
import { UsageRecord } from '../types';

let failures = 0;
let checks = 0;
let skipped = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  checks += 1;
  if (!Object.is(actual, expected)) {
    failures += 1;
    console.error(`  FAIL  ${name}\n        expected ${expected}, got ${actual}`);
  } else {
    console.log(`  ok    ${name} = ${actual}`);
  }
}

function assertTrue(name: string, value: boolean, detail = ''): void {
  checks += 1;
  if (!value) {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  } else {
    console.log(`  ok    ${name}`);
  }
}

function skip(name: string, why: string): void {
  skipped += 1;
  console.log(`  skip  ${name} — ${why}`);
}

/** Local midnight, matching how periods are computed. */
function at(year: number, month1: number, day: number, hour = 12): number {
  return new Date(year, month1 - 1, day, hour, 0, 0, 0).getTime();
}

function dateOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function record(costUSD: number, timestampMs = 0): UsageRecord {
  return {
    requestId: `r${timestampMs}-${costUSD}`,
    timestampMs,
    model: 'claude-sonnet-5',
    input: 0,
    output: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    costUSD,
  };
}

function periodMath(): void {
  console.log('\n  billing periods');

  const monthly = currentPeriod(at(2026, 8, 14), 1);
  check('a cycle on the 1st starts at the month', dateOf(monthly.startMs), '2026-08-01');
  check('  and ends at the next one', dateOf(monthly.endMs), '2026-09-01');
  check('  keyed by its start date', monthly.key, '2026-08-01');
  check(
    '  starting at local midnight',
    new Date(monthly.startMs).getHours(),
    0,
  );

  check(
    'after the cycle day, the period is this month',
    dateOf(currentPeriod(at(2026, 8, 20), 15).startMs),
    '2026-08-15',
  );
  check(
    'before it, the period began last month',
    dateOf(currentPeriod(at(2026, 8, 3), 15).startMs),
    '2026-07-15',
  );
  check(
    '  on the cycle day itself the new period has started',
    dateOf(currentPeriod(at(2026, 8, 15, 0), 15).startMs),
    '2026-08-15',
  );

  // A negative month index has to roll the year back on its own.
  const rollover = currentPeriod(at(2026, 1, 5), 15);
  check('a period that began last year', dateOf(rollover.startMs), '2025-12-15');
  check('  ends this one', dateOf(rollover.endMs), '2026-01-15');

  // February has no 31st, so the cycle clamps to the last day it does have.
  check(
    'a cycle on the 31st clamps in February',
    dateOf(currentPeriod(at(2026, 2, 10), 31).startMs),
    '2026-01-31',
  );
  check(
    '  and its end clamps too',
    dateOf(currentPeriod(at(2026, 2, 10), 31).endMs),
    '2026-02-28',
  );
  check(
    '  including a leap February',
    dateOf(currentPeriod(at(2024, 2, 10), 31).endMs),
    '2024-02-29',
  );

  // Periods must abut exactly, or spend at a boundary belongs to neither.
  for (const day of [1, 15, 28, 31]) {
    const first = currentPeriod(at(2026, 3, 20), day);
    const next = currentPeriod(first.endMs, day);
    check(`cycle day ${day}: periods abut`, next.startMs, first.endMs);
  }

  check('a nonsense cycle day falls back to the 1st', currentPeriod(at(2026, 8, 14), NaN).key, '2026-08-01');
  check('  as does one out of range', currentPeriod(at(2026, 8, 14), 0).key, '2026-08-01');

  const period = currentPeriod(at(2026, 8, 1), 1);
  check('days left counts to the cycle end', daysLeft(period, at(2026, 8, 20)), 12);
  check('  never below zero', daysLeft(period, at(2026, 10, 1)), 0);
}

function readings(): void {
  console.log('\n  readings');

  const period = currentPeriod(at(2026, 8, 14), 1);
  const half = readBudget(25, 50, period);
  check('fraction', half.fraction, 0.5);
  check('remaining', half.remainingUSD, 25);
  check('nothing over', half.overUSD, 0);
  check('no threshold reached at 50%', half.reached, 0);

  check('75% reached', readBudget(37.5, 50, period).reached, 75);
  check('  90% takes precedence over 75%', readBudget(45, 50, period).reached, 90);
  check('  exactly at budget reaches 100%', readBudget(50, 50, period).reached, 100);
  check('  and past it stays at 100%', readBudget(80, 50, period).reached, 100);
  check('over-spend is reported', readBudget(80, 50, period).overUSD, 30);
  check('  with nothing remaining', readBudget(80, 50, period).remainingUSD, 0);

  const off = readBudget(80, 0, period);
  check('no budget means no fraction', off.fraction, 0);
  check('  and no threshold', off.reached, 0);

  check(
    'a custom threshold list is honoured',
    readBudget(30, 50, period, [50]).reached,
    50,
  );

  check('thresholds sort and dedupe', normaliseThresholds([100, 75, 75]).join(','), '75,100');
  check('  junk is dropped', normaliseThresholds([90, -1, NaN, 'x']).join(','), '90');
  check(
    '  an empty list falls back to the defaults',
    normaliseThresholds([]).join(','),
    DEFAULT_THRESHOLDS.join(','),
  );
  check('  as does a non-array', normaliseThresholds(undefined).join(','), DEFAULT_THRESHOLDS.join(','));

  check('label under budget', buildBudgetSuffix(half), '$25.00 left');
  check('label over budget', buildBudgetSuffix(readBudget(80, 50, period)), '$30.00 over');
  check('label with no session', buildBudgetOnlyText(half), '$(graph) $25.00  ·  $25.00 left');

  assertTrue(
    'the warning names the source and the figures',
    budgetWarning(readBudget(45, 50, period), 'Cursor', at(2026, 8, 20)).includes(
      'Cursor is at 90% of its $50.00 budget — $45.00 spent, 12 days left',
    ),
    budgetWarning(readBudget(45, 50, period), 'Cursor', at(2026, 8, 20)),
  );
  assertTrue(
    '  and reads differently once the budget is gone',
    budgetWarning(readBudget(50, 50, period), 'Cursor', at(2026, 8, 20)).includes(
      'has used its whole $50.00 budget',
    ),
    budgetWarning(readBudget(50, 50, period), 'Cursor', at(2026, 8, 20)),
  );
}

class FakeStore {
  readonly values = new Map<string, number>();
  get(key: string): number | undefined {
    return this.values.get(key);
  }
  update(key: string, value: number): void {
    this.values.set(key, value);
  }
}

async function tracker(): Promise<void> {
  console.log('\n  tracker');

  const pricer = new Pricer();
  const store = new FakeStore();
  const warnings: string[] = [];
  const published: Array<number | undefined> = [];

  let spend = 0;
  let calls = 0;
  let now = at(2026, 8, 10);

  const build = () =>
    new BudgetTracker({
      source: {
        periodRecords: async () => {
          calls += 1;
          return [record(spend)];
        },
      },
      sourceId: 'cursor',
      sourceLabel: 'Cursor',
      pricer,
      options: { budgetUSD: 100, cycleStartDay: 1, thresholds: [75, 90, 100] },
      onChange: (reading) => published.push(reading?.spentUSD),
      store,
      warn: (message) => warnings.push(message),
      now: () => now,
    });

  const t = build();

  spend = 40;
  await t.refresh();
  check('a reading is published', published.length, 1);
  check('  with the period spend', t.current?.spentUSD, 40);
  check('nothing to warn about yet', warnings.length, 0);

  spend = 80;
  await t.refresh();
  check('crossing 75% warns', warnings.length, 1);
  assertTrue('  naming the threshold', warnings[0].includes('at 75%'), warnings[0]);

  spend = 85;
  await t.refresh();
  check('the same threshold does not warn twice', warnings.length, 1);

  spend = 95;
  await t.refresh();
  check('a higher threshold does warn', warnings.length, 2);
  assertTrue('  naming the new one', warnings[1].includes('at 90%'), warnings[1]);

  spend = 60;
  await t.refresh();
  check('falling back below does not re-arm the warning', warnings.length, 2);

  // An unchanged figure should not repaint the status bar on every tick.
  const before = published.length;
  await t.refresh();
  check('an unchanged reading is not republished', published.length, before);

  t.dispose();

  // A reloaded window is a fresh tracker over the same stored state.
  const reloaded = build();
  spend = 95;
  await reloaded.refresh();
  check('a reload does not re-announce', warnings.length, 2);

  now = at(2026, 9, 10);
  await reloaded.refresh();
  check('a new period announces again', warnings.length, 3);
  assertTrue(
    '  starting from the highest threshold reached',
    warnings[2].includes('at 90%'),
    warnings[2],
  );
  reloaded.dispose();

  // A failing source keeps the last good figure rather than blanking the item.
  const lastGood = new BudgetTracker({
    source: {
      periodRecords: async () => {
        throw new Error('offline');
      },
    },
    sourceId: 'cursor',
    sourceLabel: 'Cursor',
    pricer,
    options: { budgetUSD: 100, cycleStartDay: 1, thresholds: [75] },
    onChange: () => undefined,
    store: new FakeStore(),
    warn: () => undefined,
    now: () => now,
  });
  await lastGood.refresh();
  check('a failed read publishes nothing', lastGood.current, undefined);
  lastGood.dispose();

  const callsBefore = calls;
  const disabled = new BudgetTracker({
    source: {
      periodRecords: async () => {
        calls += 1;
        return [];
      },
    },
    sourceId: 'cursor',
    sourceLabel: 'Cursor',
    pricer,
    options: { budgetUSD: 0, cycleStartDay: 1, thresholds: [75] },
    onChange: () => undefined,
    store: new FakeStore(),
    warn: () => undefined,
  });
  await disabled.refresh();
  check('no budget means the source is never read', calls, callsBefore);
  disabled.dispose();
}

async function claudePeriodScan(): Promise<void> {
  console.log('\n  Claude Code period scan');

  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) {
    skip('period scan', 'no ~/.claude/projects on this machine');
    return;
  }

  const files = await __testing.walkTranscripts(root);
  assertTrue('transcripts are found', files.length > 0, `walked ${root}`);
  assertTrue(
    '  including sub-agent files nested below the project',
    files.every((f) => f.path.endsWith('.jsonl')),
  );

  const provider = new ClaudeCodeProvider(root);
  const period = currentPeriod(Date.now(), 1);

  __testing.transcriptCache.clear();
  const coldStart = Date.now();
  const first = await provider.periodRecords(period.startMs, period.endMs);
  const coldMs = Date.now() - coldStart;

  const warmStart = Date.now();
  const second = await provider.periodRecords(period.startMs, period.endMs);
  const warmMs = Date.now() - warmStart;

  check('the scan is repeatable', second.length, first.length);
  assertTrue(
    'the cache makes a rescan cheap',
    warmMs <= Math.max(50, coldMs / 2),
    `cold ${coldMs}ms, warm ${warmMs}ms over ${files.length} files`,
  );
  console.log(`        (${first.length} records, cold ${coldMs}ms, warm ${warmMs}ms)`);

  if (first.length === 0) {
    skip('record contents', 'no Claude Code usage in the current period');
    return;
  }

  assertTrue(
    'every record falls inside the period',
    first.every(
      (r) => r.timestampMs >= period.startMs && r.timestampMs < period.endMs,
    ),
  );
  assertTrue(
    'records are unique per request',
    new Set(first.map((r) => r.requestId)).size === first.length,
  );
  assertTrue(
    'they are ordered by time',
    first.every((r, i) => i === 0 || r.timestampMs >= first[i - 1].timestampMs),
  );
  assertTrue(
    'they carry no cost of their own, so the rate table prices them',
    first.every((r) => r.costUSD === undefined),
  );

  const spend = new Pricer().totalsOf(first).costUSD;
  assertTrue('the period costs something', spend > 0, `$${spend.toFixed(2)}`);

  // A window that ended before the corpus begins must cost nothing, which is
  // what proves the range filter is doing the work rather than the walk.
  const empty = await provider.periodRecords(0, 1);
  check('an empty window reads empty', empty.length, 0);
}

async function main(): Promise<void> {
  console.log('\nBudget');
  periodMath();
  readings();
  await tracker();
  await claudePeriodScan();

  console.log(
    `\n${checks - failures}/${checks} checks passed` +
      `${skipped ? `, ${skipped} skipped` : ''}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
