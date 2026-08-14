/**
 * Checks for the dashboard: chart geometry, the series behind it, and the
 * rendered page.
 *
 * The charts are plain strings, so the geometry is checked by reading the
 * numbers back out of the SVG rather than by looking at a picture. The three
 * things worth pinning are that a bar's height is proportional to its value
 * (a truncated axis would exaggerate differences between prompts), that
 * untrusted prompt text cannot escape into markup, and that the page never
 * grows a script — the panel runs under a policy that would silently drop one.
 *
 * The panel itself imports `vscode`, so the render check stubs that module and
 * captures the HTML. It also writes `out/dashboard-preview.html`, which opens
 * in a browser for a look at the real thing.
 *
 * Run with: npm run compile && npm run test:dashboard
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { currentPeriod, readBudget } from '../budget';
import {
  CHART_COLOURS,
  ChartPoint,
  barChart,
  labelIndices,
  lineChart,
  moneyAxis,
  niceTicks,
  tokenAxis,
} from '../chart';
import { Pricer } from '../pricing';
import { ClaudeCodeProvider } from '../providers/claudeCode';
import {
  budgetPace,
  dailySpend,
  periodElapsedFraction,
  projectedSpend,
  promptSeries,
  trendPerStep,
} from '../series';
import { SessionState, UsageRecord, createSessionState } from '../types';

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

function at(year: number, month1: number, day: number, hour = 12): number {
  return new Date(year, month1 - 1, day, hour).getTime();
}

function point(label: string, value: number): ChartPoint {
  return { label, value };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rects(svg: string): Rect[] {
  const out: Rect[] = [];
  const re =
    /<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g;
  for (let m = re.exec(svg); m; m = re.exec(svg)) {
    out.push({
      x: Number(m[1]),
      y: Number(m[2]),
      width: Number(m[3]),
      height: Number(m[4]),
    });
  }
  return out;
}

function scales(): void {
  console.log('\n  axis scales');

  check('ticks step by 1', niceTicks(4).join(','), '0,1,2,3,4');
  check('  by 2 when 1 would crowd', niceTicks(8).join(','), '0,2,4,6,8');
  check('  by 5', niceTicks(19).join(','), '0,5,10,15,20');
  check('  and scale by powers of ten', niceTicks(1900).join(','), '0,500,1000,1500,2000');
  check('  fractions do not drift', niceTicks(0.4).join(','), '0,0.1,0.2,0.3,0.4');
  assertTrue('ticks always start at zero', niceTicks(37)[0] === 0);
  assertTrue(
    '  and always cover the maximum',
    niceTicks(37)[niceTicks(37).length - 1] >= 37,
    niceTicks(37).join(','),
  );
  check('an empty range still yields an axis', niceTicks(0).join(','), '0,1');
  check('  as does a nonsense one', niceTicks(NaN).join(','), '0,1');

  // One axis, one precision: `$50.00` sitting directly under `$100` reads as
  // two different kinds of number.
  check('a coarse money axis drops the decimals', niceTicks(150).map(moneyAxis(150)).join(' '), '$0 $50 $100 $150');
  check('  a fine one keeps them', niceTicks(0.3).map(moneyAxis(0.3)).join(' '), '$0.00 $0.10 $0.20 $0.30');
  check('  and a very fine one goes further', moneyAxis(0.03)(0.0125), '$0.013');
  check('  thousands are grouped', moneyAxis(4000)(4000), '$4,000');

  // Same argument for tokens: `formatTokens` switches unit per value, which on
  // an axis prints 500 directly below 1.0k.
  check('a token axis holds one unit', niceTicks(2000).map(tokenAxis(2000)).join(' '), '0 500 1,000 1,500 2,000');
  check('  switching to k only when the step does', niceTicks(80000).map(tokenAxis(80000)).join(' '), '0 20k 40k 60k 80k');
  check('  and to M for very large steps', tokenAxis(4e6)(2e6), '2M');

  check('every label is kept when they fit', labelIndices(5, 8).join(','), '0,1,2,3,4');
  const thinned = labelIndices(40, 8);
  assertTrue('thinned labels start at the first', thinned[0] === 0);
  assertTrue('  and end at the last', thinned[thinned.length - 1] === 39, thinned.join(','));
  assertTrue('  and stay within the budget', thinned.length <= 9, `${thinned.length}`);
  check('no points means no labels', labelIndices(0, 8).length, 0);
}

function bars(): void {
  console.log('\n  bar chart');

  const svg = barChart([point('a', 0), point('b', 2), point('c', 4)], CHART_COLOURS.cost);
  const drawn = rects(svg);
  check('one bar per point', drawn.length, 3);
  check('a zero value draws nothing', drawn[0].height, 0);

  // The axis tops out at 4, so a value of 4 must fill the plot and 2 must be
  // exactly half of it. This is what a truncated axis would break.
  assertTrue(
    'the tallest bar fills the plot',
    Math.abs(drawn[2].height - 170) < 1,
    `height ${drawn[2].height}`,
  );
  assertTrue(
    'half the value is half the height',
    Math.abs(drawn[1].height - drawn[2].height / 2) < 1,
    `${drawn[1].height} vs ${drawn[2].height}`,
  );
  assertTrue(
    'bars sit on a common baseline',
    Math.abs(drawn[1].y + drawn[1].height - (drawn[2].y + drawn[2].height)) < 0.5,
  );
  assertTrue('bars run left to right', drawn[0].x < drawn[1].x && drawn[1].x < drawn[2].x);
  assertTrue('bars do not overlap', drawn[0].x + drawn[0].width <= drawn[1].x + 0.01);

  assertTrue('each bar carries hover text', (svg.match(/<title>/g) ?? []).length === 3);
  assertTrue('the reference line is absent by default', !svg.includes('class="reference"'));

  const withRef = barChart([point('a', 4)], CHART_COLOURS.cost, {
    reference: { value: 2, label: 'avg' },
  });
  assertTrue('a reference line is drawn when asked', withRef.includes('class="reference"'));
  const offScale = barChart([point('a', 4)], CHART_COLOURS.cost, {
    reference: { value: 400, label: 'avg' },
  });
  assertTrue(
    '  and suppressed when it falls off the top',
    !offScale.includes('class="reference"'),
  );

  const empty = barChart([], CHART_COLOURS.cost, { emptyMessage: 'nothing here' });
  assertTrue('an empty series says so', empty.includes('nothing here'));
  assertTrue('  and still returns valid svg', empty.startsWith('<svg') && empty.endsWith('</svg>'));

  const nasty = barChart(
    [{ label: '<script>x</script>', value: 1, title: 'a "quoted" & <tagged> prompt' }],
    CHART_COLOURS.cost,
  );
  assertTrue('labels are escaped', !nasty.includes('<script>'), nasty.slice(0, 200));
  assertTrue('  including hover text', nasty.includes('&lt;tagged&gt;'));
  assertTrue('  and quotes in it', nasty.includes('&quot;quoted&quot;'));
}

function lines(): void {
  console.log('\n  line chart');

  const svg = lineChart([
    {
      name: 'spend',
      points: [point('a', 0), point('b', 5), point('c', 10)],
      colour: CHART_COLOURS.cost,
      fill: true,
    },
  ]);
  const path = /<path d="(M[^"]+)" fill="none"/.exec(svg);
  assertTrue('a line path is drawn', !!path, svg.slice(0, 300));
  const commands = (path?.[1] ?? '').split(' ');
  check('one command per point', commands.length, 3);
  assertTrue('it starts with a move', commands[0].startsWith('M'));
  assertTrue('and continues with lines', commands.slice(1).every((c) => c.startsWith('L')));

  const ys = commands.map((c) => Number(c.split(',')[1]));
  assertTrue('a rising series falls down the screen', ys[0] > ys[1] && ys[1] > ys[2], ys.join(','));
  assertTrue('the filled area is closed', svg.includes('Z" fill='));
  assertTrue('points carry hover targets', (svg.match(/class="dot"/g) ?? []).length === 3);

  const two = lineChart([
    { name: 'a', points: [point('x', 1)], colour: CHART_COLOURS.cost },
    { name: 'b', points: [point('x', 2)], colour: CHART_COLOURS.output, dashed: true },
  ]);
  check('both series are drawn', (two.match(/fill="none"/g) ?? []).length, 2);
  assertTrue('a dashed series is dashed', two.includes('stroke-dasharray'));

  const single = lineChart([
    { name: 'a', points: [point('only', 3)], colour: CHART_COLOURS.cost },
  ]);
  assertTrue('a single point does not divide by zero', !single.includes('NaN'), single.slice(0, 200));

  assertTrue(
    'an empty series says so',
    lineChart([], { emptyMessage: 'no data' }).includes('no data'),
  );
  assertTrue(
    '  as does one with no points',
    lineChart([{ name: 'a', points: [], colour: 'red' }], {
      emptyMessage: 'no data',
    }).includes('no data'),
  );
}

function record(costUSD: number, timestampMs: number): UsageRecord {
  return {
    requestId: `r${timestampMs}-${costUSD}`,
    timestampMs,
    model: 'claude-sonnet-5',
    input: 100,
    output: 50,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    costUSD,
  };
}

function seriesMath(): void {
  console.log('\n  series');

  const pricer = new Pricer();
  const period = currentPeriod(at(2026, 8, 14), 1);

  const days = dailySpend(
    [
      record(1, at(2026, 8, 1, 9)),
      record(2, at(2026, 8, 1, 18)),
      record(4, at(2026, 8, 3, 10)),
    ],
    period,
    pricer,
    at(2026, 8, 5),
  );
  check('one point per day up to today', days.length, 5);
  check('same-day records combine', days[0].costUSD, 3);
  check('  and count their requests', days[0].requests, 2);
  check('an idle day is kept as zero', days[1].costUSD, 0);
  check('cumulative carries across idle days', days[1].cumulativeUSD, 3);
  check('  and picks up again', days[2].cumulativeUSD, 7);
  check('  ending at the total', days[4].cumulativeUSD, 7);
  assertTrue(
    'cumulative never decreases',
    days.every((d, i) => i === 0 || d.cumulativeUSD >= days[i - 1].cumulativeUSD),
  );
  // Stepping the calendar rather than adding 24 hours is what keeps this true
  // across a daylight-saving change.
  assertTrue(
    'every bucket is a local midnight',
    days.every((d) => new Date(d.dayMs).getHours() === 0),
  );

  const outside = dailySpend(
    [record(9, at(2026, 7, 20)), record(9, at(2026, 9, 20))],
    period,
    pricer,
    at(2026, 8, 5),
  );
  check('records outside the period are ignored', outside[outside.length - 1].cumulativeUSD, 0);

  check('a period just begun is barely elapsed', periodElapsedFraction(period, period.startMs), 0);
  check('  and a finished one is fully', periodElapsedFraction(period, period.endMs), 1);
  assertTrue(
    '  halfway is about half',
    Math.abs(periodElapsedFraction(period, (period.startMs + period.endMs) / 2) - 0.5) < 1e-9,
  );

  assertTrue(
    'pace is the budget spread evenly',
    Math.abs(budgetPace(period, 100, (period.startMs + period.endMs) / 2) - 50) < 1e-9,
  );
  check('a projection needs some of the cycle gone', projectedSpend(10, period, period.startMs), undefined);
  assertTrue(
    '  then extrapolates the rate so far',
    Math.abs(
      (projectedSpend(50, period, (period.startMs + period.endMs) / 2) ?? 0) - 100,
    ) < 1e-9,
  );

  check('a trend needs three points', trendPerStep([1, 2]), undefined);
  check('a flat series has no slope', trendPerStep([2, 2, 2]), 0);
  check('a rising series slopes up', trendPerStep([1, 2, 3]), 1);
  check('  and a falling one down', trendPerStep([3, 2, 1]), -1);

  // promptSeries drops prompts that never billed, so a chart has no run of
  // meaningless zero bars in the middle of it.
  const state: SessionState = createSessionState('test');
  state.prompts.push(
    { promptText: 'billed', startedAtMs: 1, records: [record(1, 1)] },
    { promptText: 'interrupted', startedAtMs: 2, records: [] },
    { promptText: 'billed again', startedAtMs: 3, records: [record(2, 3)] },
  );
  const prompts = promptSeries(state, pricer);
  check('unbilled prompts are dropped', prompts.length, 2);
  check('  and the rest are renumbered', prompts.map((p) => p.index).join(','), '1,2');
  check('  keeping their totals', prompts[1].totals.costUSD, 2);
}

/** Load the panel with `vscode` stubbed, and capture the HTML it produces. */
function renderDashboard(data: unknown, pricer: Pricer): string {
  let html = '';
  const fakePanel = {
    webview: {
      set html(value: string) {
        html = value;
      },
      get html(): string {
        return html;
      },
    },
    onDidDispose: () => undefined,
    reveal: () => undefined,
    dispose: () => undefined,
  };
  const stub = {
    window: { createWebviewPanel: () => fakePanel },
    ViewColumn: { Active: 1 },
  };

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module') as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const original = Module._load;
  Module._load = function patched(request, parent, isMain) {
    return request === 'vscode' ? stub : original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../details')];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DetailsPanel } = require('../details') as {
      DetailsPanel: { show(p: Pricer, d: unknown): { dispose(): void } };
    };
    DetailsPanel.show(pricer, data).dispose();
  } finally {
    Module._load = original;
  }
  return html;
}

async function rendered(): Promise<void> {
  console.log('\n  rendered page');

  const pricer = new Pricer();
  const now = Date.now();
  const period = currentPeriod(now, 1);

  // A synthetic session with a deliberate upward drift in cost, so the trend
  // note has something to report.
  const state = createSessionState('synthetic');
  const day = period.startMs;
  for (let i = 0; i < 9; i += 1) {
    state.prompts.push({
      promptText: `Prompt number ${i + 1} — <b>untrusted</b> "text" & symbols`,
      startedAtMs: day + i * 3_600_000,
      records: [
        {
          requestId: `req-${i}`,
          timestampMs: day + i * 3_600_000,
          model: 'claude-sonnet-5',
          input: 1_200 + i * 400,
          output: 800 + i * 120,
          cacheWrite5m: 4_000 + i * 2_500,
          cacheWrite1h: 0,
          cacheRead: 20_000 + i * 30_000,
          costUSD: undefined,
        },
      ],
    });
  }

  const periodRecords: UsageRecord[] = [];
  for (let d = 0; d < 14; d += 1) {
    const count = d % 4 === 3 ? 0 : 1 + (d % 3);
    for (let i = 0; i < count; i += 1) {
      periodRecords.push(
        record(0.4 + ((d * 7 + i * 3) % 11) / 6, period.startMs + d * 86_400_000 + 3_600_000 * (8 + i)),
      );
    }
  }
  const spent = pricer.totalsOf(periodRecords).costUSD;
  const budget = readBudget(spent, 40, period);

  const html = renderDashboard(
    {
      state,
      sessionName: 'synthetic-session',
      sourceLabel: 'Claude Code',
      budget,
      periodRecords,
    },
    pricer,
  );

  assertTrue('the page renders', html.startsWith('<!DOCTYPE html>'), html.slice(0, 80));
  assertTrue('it never contains a script', !/<script/i.test(html));
  assertTrue('the policy stays restrictive', html.includes("default-src 'none'"));
  assertTrue('the cycle section is present', html.includes('This billing cycle'));
  assertTrue('the session section is present', html.includes('This session'));
  assertTrue('the per-prompt table is present', html.includes('By prompt'));
  assertTrue('the pace line is drawn', html.includes('Even pace to budget'));
  assertTrue(
    'the upward drift is called out',
    html.includes('trending') && html.includes('up'),
  );
  assertTrue(
    'untrusted prompt text is escaped',
    !html.includes('<b>untrusted</b>') && html.includes('&lt;b&gt;untrusted'),
  );
  const svgCount = (html.match(/<svg/g) ?? []).length;
  check('five charts are drawn', svgCount, 5);
  assertTrue(
    'context and output are given separate axes',
    html.includes('Context carried') && html.includes('Output produced'),
  );
  assertTrue('no chart produced NaN geometry', !html.includes('NaN'), 'NaN in output');

  // A budget with no session must still render, since it stays visible between
  // sessions; and a session with no budget must not mention a cycle.
  const budgetOnly = renderDashboard(
    { state: undefined, sourceLabel: 'Cursor', budget, periodRecords },
    pricer,
  );
  assertTrue('a budget renders without a session', budgetOnly.includes('This billing cycle'));
  assertTrue('  and says the session is absent', budgetOnly.includes('no active session'));
  assertTrue('  without a session section', !budgetOnly.includes('This session'));

  const sessionOnly = renderDashboard(
    { state, sessionName: 's', sourceLabel: 'Claude Code' },
    pricer,
  );
  assertTrue('a session renders without a budget', sessionOnly.includes('This session'));
  assertTrue('  without a cycle section', !sessionOnly.includes('This billing cycle'));

  const nothing = renderDashboard({ state: undefined }, pricer);
  assertTrue('nothing at all explains itself', nothing.includes('Run a prompt in this folder'));

  // Real data, when this machine has some, so the preview is worth looking at.
  let previewHtml = html;
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (fs.existsSync(root)) {
    const real = await new ClaudeCodeProvider(root).periodRecords(
      period.startMs,
      period.endMs,
    );
    if (real.length > 0) {
      previewHtml = renderDashboard(
        {
          state,
          sessionName: 'synthetic-session',
          sourceLabel: 'Claude Code',
          budget: readBudget(pricer.totalsOf(real).costUSD, 600, period),
          periodRecords: real,
        },
        pricer,
      );
      console.log(`  info  preview uses ${real.length} real records this cycle`);
    }
  } else {
    skip('real-data preview', 'no ~/.claude/projects');
  }

  const out = path.resolve(__dirname, '../dashboard-preview.html');
  fs.writeFileSync(out, withThemeFallbacks(previewHtml), 'utf8');
  console.log(`  info  wrote ${out}`);
}

/**
 * VS Code's theme variables only exist inside the editor, so the preview
 * supplies dark-theme values for them. Only the preview file is affected.
 */
function withThemeFallbacks(html: string): string {
  const vars = `
  :root {
    --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --vscode-editor-font-family: "SF Mono", Menlo, monospace;
    --vscode-font-size: 13px;
    --vscode-foreground: #cccccc;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-editorWidget-background: #252526;
    --vscode-widget-border: #3c3c3c;
    --vscode-panel-border: #3c3c3c;
    --vscode-list-hoverBackground: #2a2d2e;
    --vscode-textCodeBlock-background: #1e1e1e;
    --vscode-textBlockQuote-background: #2a2a2a;
    --vscode-editorWarning-foreground: #cca700;
    --vscode-charts-blue: #3794ff;
    --vscode-charts-purple: #b180d7;
    --vscode-charts-green: #89d185;
    --vscode-charts-orange: #d18616;
    --vscode-charts-red: #f14c4c;
  }
  body { background: #1e1e1e; }
`;
  return html.replace('<style>', `<style>${vars}`);
}

async function main(): Promise<void> {
  console.log('\nDashboard');
  scales();
  bars();
  lines();
  seriesMath();
  await rendered();

  console.log(
    `\n${checks - failures}/${checks} checks passed` +
      `${skipped ? `, ${skipped} skipped` : ''}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
