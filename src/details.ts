import * as vscode from 'vscode';

import { allRecords, elapsedMs } from './aggregate';
import { BudgetReading, daysLeft } from './budget';
import {
  CHART_COLOURS,
  CHART_CSS,
  ChartPoint,
  barChart,
  legend,
  lineChart,
  moneyAxis,
  tokenAxis,
} from './chart';
import {
  escapeHtml,
  excerpt,
  formatClock,
  formatCost,
  formatCostPrecise,
  formatDuration,
  formatInt,
  formatPercent,
  formatTokens,
} from './format';
import { Pricer, cacheHitRate } from './pricing';
import {
  DayPoint,
  budgetPace,
  dailySpend,
  projectedSpend,
  promptSeries,
  trendPerStep,
} from './series';
import { SessionState, UsageRecord } from './types';

/** Everything the dashboard draws, gathered by the extension host. */
export interface DashboardData {
  state: SessionState | undefined;
  sessionName?: string;
  sourceLabel?: string;
  budget?: BudgetReading;
  /** Account-wide records for the billing period behind `budget`. */
  periodRecords?: readonly UsageRecord[];
}

export class DetailsPanel {
  private static current: DetailsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  private constructor(
    private pricer: Pricer,
    private data: DashboardData,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'tokenUsage.details',
      'Token Usage',
      vscode.ViewColumn.Active,
      { enableScripts: false, retainContextWhenHidden: true },
    );
    this.panel.onDidDispose(() => {
      this.disposed = true;
      DetailsPanel.current = undefined;
    });
    this.refresh();
  }

  static show(pricer: Pricer, data: DashboardData): DetailsPanel {
    if (DetailsPanel.current && !DetailsPanel.current.disposed) {
      DetailsPanel.current.update(pricer, data);
      DetailsPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return DetailsPanel.current;
    }
    DetailsPanel.current = new DetailsPanel(pricer, data);
    return DetailsPanel.current;
  }

  /** Push new data into an already-open panel; no-op when it is closed. */
  static updateIfOpen(pricer: Pricer, data: DashboardData): void {
    if (DetailsPanel.current && !DetailsPanel.current.disposed) {
      DetailsPanel.current.update(pricer, data);
    }
  }

  private update(pricer: Pricer, data: DashboardData): void {
    this.pricer = pricer;
    this.data = data;
    this.refresh();
  }

  private refresh(): void {
    if (!this.disposed) {
      this.panel.webview.html = this.render();
    }
  }

  private render(): string {
    const { state, budget } = this.data;
    const hasSession = !!state && state.prompts.length > 0;

    if (!hasSession && !budget) {
      return page(
        `<h1>Token Usage</h1>
         <p class="empty">No ${escapeHtml(this.data.sourceLabel ?? 'agent')} session
         found for this workspace.</p>
         <p class="empty">Run a prompt in this folder and the readout will appear.
         Set <code>tokenUsage.budget.cursorUSD</code> or
         <code>tokenUsage.budget.claudeUSD</code> to follow monthly spend even when
         nothing is running.</p>`,
      );
    }

    return page(
      [
        this.header(),
        this.sessionCards(),
        this.cycleSection(),
        hasSession ? this.sessionSection() : '',
        hasSession ? this.tables() : '',
        FOOTNOTE,
      ].join('\n'),
    );
  }

  private header(): string {
    const { state, sessionName, sourceLabel } = this.data;
    const bits: string[] = [];
    if (sourceLabel) {
      bits.push(escapeHtml(sourceLabel));
    }
    if (state && state.prompts.length > 0) {
      const session = this.pricer.totalsOf(allRecords(state));
      bits.push(
        escapeHtml(sessionName ?? 'session'),
        `${state.prompts.length} prompt${state.prompts.length === 1 ? '' : 's'}`,
        `${session.requests} request${session.requests === 1 ? '' : 's'}`,
        escapeHtml(formatDuration(elapsedMs(state))),
      );
      if (state.unattributedRecords.length > 0) {
        bits.push(
          `includes ${state.unattributedRecords.length} sub-agent request${
            state.unattributedRecords.length === 1 ? '' : 's'
          }`,
        );
      }
    } else {
      bits.push('no active session in this workspace');
    }
    return `<h1>Token Usage</h1><p class="sub">${bits.join(' · ')}</p>`;
  }

  /**
   * Cards are grouped with the section they describe rather than pooled at the
   * top: a single row of six wraps into an orphan at most panel widths, and the
   * budget figures mean more sitting above the budget chart than above a
   * session that has nothing to do with them.
   */
  private sessionCards(): string {
    const state = this.data.state;
    if (!state || state.prompts.length === 0) {
      return '';
    }
    const session = this.pricer.totalsOf(allRecords(state));
    const prompts = promptSeries(state, this.pricer);
    const perPrompt = prompts.length > 0 ? session.costUSD / prompts.length : 0;
    return (
      `<div class="cards">` +
      card('Session cost', formatCostPrecise(session.costUSD)) +
      card('Cost per prompt', formatCostPrecise(perPrompt), `${prompts.length} billed`) +
      card('Cache hit rate', formatPercent(cacheHitRate(session))) +
      card('Output tokens', formatInt(session.output)) +
      `</div>`
    );
  }

  private budgetCards(budget: BudgetReading): string {
    const now = Date.now();
    const days = daysLeft(budget.period, now);
    const projected = projectedSpend(budget.spentUSD, budget.period, now);
    return (
      `<div class="cards">` +
      card(
        'Spent this cycle',
        formatCost(budget.spentUSD),
        `of ${formatCost(budget.budgetUSD)} · ${formatPercent(budget.fraction)}`,
        budget.overUSD > 0 ? 'over' : budget.reached > 0 ? 'near' : undefined,
      ) +
      card(
        budget.overUSD > 0 ? 'Over budget by' : 'Remaining',
        formatCost(budget.overUSD > 0 ? budget.overUSD : budget.remainingUSD),
        `${days} day${days === 1 ? '' : 's'} left`,
        budget.overUSD > 0 ? 'over' : undefined,
      ) +
      card(
        'On pace for',
        projected === undefined ? '—' : formatCost(projected),
        projected === undefined
          ? 'too early in the cycle'
          : `by ${new Date(budget.period.endMs).toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'short',
            })}`,
        projected !== undefined && projected > budget.budgetUSD ? 'over' : undefined,
      ) +
      `</div>`
    );
  }

  /** Cumulative spend against an even-pace line, plus the daily bars. */
  private cycleSection(): string {
    const { budget, periodRecords } = this.data;
    if (!budget) {
      return '';
    }
    const now = Date.now();
    const days = dailySpend(periodRecords ?? [], budget.period, this.pricer, now);
    const from = new Date(budget.period.startMs).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    });
    const to = new Date(budget.period.endMs).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    });

    const label = (d: DayPoint) =>
      new Date(d.dayMs).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
      });

    const cumulative: ChartPoint[] = days.map((d) => ({
      label: label(d),
      value: d.cumulativeUSD,
      title: `${label(d)}: ${formatCostPrecise(d.cumulativeUSD)} spent so far`,
    }));
    // The pace line is the budget spread evenly, drawn only as far as the data
    // so the two lines can be compared at the same instant.
    const pace: ChartPoint[] = days.map((d, i) => ({
      label: label(d),
      value: budgetPace(
        budget.period,
        budget.budgetUSD,
        Math.min(now, days[i].dayMs + 86_400_000),
      ),
      title: `even pace by ${label(d)}`,
    }));

    const daily: ChartPoint[] = days.map((d) => ({
      label: label(d),
      value: d.costUSD,
      title:
        d.requests === 0
          ? `${label(d)}: nothing`
          : `${label(d)}: ${formatCostPrecise(d.costUSD)} over ${d.requests} request${
              d.requests === 1 ? '' : 's'
            }`,
    }));

    const busiest = days.reduce<DayPoint | undefined>(
      (best, d) => (!best || d.costUSD > best.costUSD ? d : best),
      undefined,
    );
    const average =
      days.length > 0 ? days.reduce((s, d) => s + d.costUSD, 0) / days.length : 0;

    const spentSoFar = cumulative[cumulative.length - 1]?.value ?? 0;

    return `
      <h2>This billing cycle <span class="hint">${escapeHtml(from)} – ${escapeHtml(to)}, every project on the account</span></h2>
      ${this.budgetCards(budget)}
      ${legend([
        { name: 'Spent so far', colour: CHART_COLOURS.cost },
        {
          name: `Even pace to ${formatCost(budget.budgetUSD)}`,
          colour: CHART_COLOURS.warning,
          dashed: true,
        },
      ])}
      ${lineChart(
        [
          {
            name: 'Spent so far',
            points: cumulative,
            colour: CHART_COLOURS.cost,
            fill: true,
          },
          {
            name: 'Even pace to budget',
            points: pace,
            colour: CHART_COLOURS.warning,
            dashed: true,
          },
        ],
        {
          format: moneyAxis(Math.max(spentSoFar, budget.budgetUSD)),
          maxXLabels: 10,
          emptyMessage: 'No spend recorded this cycle yet',
        },
      )}
      <h3>Spend per day</h3>
      ${legend([
        { name: 'Daily spend', colour: CHART_COLOURS.cost },
        ...(average > 0
          ? [
              {
                name: `Average ${formatCost(average)}/day`,
                colour: CHART_COLOURS.warning,
                dashed: true,
              },
            ]
          : []),
        ...(busiest && busiest.costUSD > 0
          ? [{ name: `Busiest ${label(busiest)}, ${formatCost(busiest.costUSD)}` }]
          : []),
      ])}
      ${barChart(daily, CHART_COLOURS.cost, {
        height: 170,
        format: moneyAxis(Math.max(...daily.map((d) => d.value), 0)),
        maxXLabels: 10,
        reference:
          average > 0 ? { value: average, label: `average ${formatCost(average)}/day` } : undefined,
        emptyMessage: 'No spend recorded this cycle yet',
      })}
    `;
  }

  /**
   * The session charts, which are the ones about prompt efficiency: what each
   * turn cost, and how much context it had to carry to get there.
   */
  private sessionSection(): string {
    const state = this.data.state;
    if (!state) {
      return '';
    }
    const prompts = promptSeries(state, this.pricer);
    if (prompts.length === 0) {
      return '';
    }

    const costs = prompts.map((p) => p.totals.costUSD);
    const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
    const slope = trendPerStep(costs);

    const describe = (index: number) => `#${index}`;
    const costPoints: ChartPoint[] = prompts.map((p) => ({
      label: describe(p.index),
      value: p.totals.costUSD,
      title:
        `#${p.index} at ${formatClock(p.startedAtMs)} — ` +
        `${formatCostPrecise(p.totals.costUSD)}, ` +
        `${p.totals.requests} request${p.totals.requests === 1 ? '' : 's'}\n` +
        excerpt(p.promptText, 100),
    }));

    const contextPoints: ChartPoint[] = prompts.map((p) => ({
      label: describe(p.index),
      value: p.totals.weightedInput,
      title: `#${p.index} — ${formatTokens(p.totals.weightedInput)} weighted input`,
    }));
    const outputPoints: ChartPoint[] = prompts.map((p) => ({
      label: describe(p.index),
      value: p.totals.output,
      title: `#${p.index} — ${formatTokens(p.totals.output)} output`,
    }));

    // A per-prompt drift worth mentioning: over a long session this is what
    // turns a cheap conversation into an expensive one.
    const drift =
      slope !== undefined && Math.abs(slope) * prompts.length > mean * 0.2
        ? `<p class="note">Cost per prompt is trending
             ${slope > 0 ? 'up' : 'down'} by about
             ${escapeHtml(formatCostPrecise(Math.abs(slope)))} per prompt.
             ${
               slope > 0
                 ? 'Context accumulates as a session runs; starting a fresh one resets it.'
                 : ''
             }</p>`
        : '';

    // Context and output share no sensible scale — input runs to hundreds of
    // thousands of tokens while output is in the low thousands, so one axis
    // would flatten output onto the baseline. Two charts, two axes.
    const pairOptions = { width: 470, height: 200, maxXLabels: 6 } as const;

    return `
      <h2>This session <span class="hint">one bar per prompt, oldest first</span></h2>
      ${legend([
        { name: 'Cost per prompt', colour: CHART_COLOURS.cost },
        {
          name: `Average ${formatCostPrecise(mean)}`,
          colour: CHART_COLOURS.warning,
          dashed: true,
        },
      ])}
      ${barChart(costPoints, CHART_COLOURS.cost, {
        format: moneyAxis(Math.max(...costs, 0)),
        reference: { value: mean, label: `average ${formatCostPrecise(mean)}` },
        maxXLabels: 12,
      })}
      ${drift}
      <div class="chart-pair">
        <div>
          <h3>Context carried <span class="hint">weighted input</span></h3>
          ${lineChart(
            [
              {
                name: 'Weighted input',
                points: contextPoints,
                colour: CHART_COLOURS.context,
                fill: true,
              },
            ],
            {
              ...pairOptions,
              format: tokenAxis(Math.max(...contextPoints.map((p) => p.value), 0)),
            },
          )}
        </div>
        <div>
          <h3>Output produced <span class="hint">tokens</span></h3>
          ${barChart(outputPoints, CHART_COLOURS.output, {
            ...pairOptions,
            format: tokenAxis(Math.max(...outputPoints.map((p) => p.value), 0)),
          })}
        </div>
      </div>
    `;
  }

  private tables(): string {
    const state = this.data.state;
    if (!state) {
      return '';
    }
    const records = allRecords(state);
    const models = this.pricer.totalsByModel(records);
    const unknown = this.pricer.unknownModelsIn(records);

    const rows = promptSeries(state, this.pricer)
      .map(
        (p) => `<tr>
          <td class="num">${p.index}</td>
          <td class="time">${escapeHtml(formatClock(p.startedAtMs))}</td>
          <td class="prompt">${escapeHtml(excerpt(p.promptText, 90))}</td>
          <td class="num">${p.totals.requests}</td>
          <td class="num">${formatInt(p.totals.input)}</td>
          <td class="num">${formatInt(p.totals.cacheWrite5m + p.totals.cacheWrite1h)}</td>
          <td class="num">${formatInt(p.totals.cacheRead)}</td>
          <td class="num">${formatInt(p.totals.output)}</td>
          <td class="num cost">${formatCostPrecise(p.totals.costUSD)}</td>
        </tr>`,
      )
      .reverse()
      .join('\n');

    const modelRows = [...models.entries()]
      .map(
        ([model, t]) => `<tr>
          <td><code>${escapeHtml(model)}</code></td>
          <td class="num">${t.requests}</td>
          <td class="num">${formatInt(t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead)}</td>
          <td class="num">${formatInt(t.output)}</td>
          <td class="num cost">${formatCostPrecise(t.costUSD)}</td>
        </tr>`,
      )
      .join('\n');

    const warning =
      unknown.length > 0
        ? `<p class="warn">Unrecognised model${unknown.length === 1 ? '' : 's'}
           priced at the Opus fallback rate:
           ${unknown.map((m) => `<code>${escapeHtml(m)}</code>`).join(', ')}.</p>`
        : '';

    return `
      ${warning}
      <h2>By model</h2>
      <table>
        <thead><tr>
          <th>Model</th><th class="num">Requests</th>
          <th class="num">Input side</th><th class="num">Output</th>
          <th class="num">Cost</th>
        </tr></thead>
        <tbody>${modelRows}</tbody>
      </table>

      <h2>By prompt <span class="hint">(most recent first)</span></h2>
      <table>
        <thead><tr>
          <th class="num">#</th><th>Time</th><th>Prompt</th>
          <th class="num">Reqs</th><th class="num">Input</th>
          <th class="num">Cache w</th><th class="num">Cache r</th>
          <th class="num">Output</th><th class="num">Cost</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  dispose(): void {
    this.panel.dispose();
  }
}

function card(
  label: string,
  value: string,
  sub?: string,
  tone?: 'over' | 'near',
): string {
  return (
    `<div class="card${tone ? ` ${tone}` : ''}">` +
    `<span class="label">${escapeHtml(label)}</span>` +
    `<span class="value">${escapeHtml(value)}</span>` +
    (sub ? `<span class="sub-value">${escapeHtml(sub)}</span>` : '') +
    `</div>`
  );
}

const FOOTNOTE = `
  <p class="footnote">
    Weighted input counts cache reads at 0.1× and cache writes at 1.25× (5&nbsp;min)
    or 2× (1&nbsp;hour), matching how they bill. Raw totals are dominated by cache
    reads and do not track spend. Hover any bar or point for its exact figures.
  </p>`;

function page(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 1.25rem 1.5rem 3rem;
    line-height: 1.5;
    max-width: 68rem;
  }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; font-weight: 600; }
  h2 {
    font-size: 1rem; margin: 2.25rem 0 .75rem; font-weight: 600;
    padding-bottom: .35rem;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }
  h3 {
    font-size: .9rem; margin: 1.5rem 0 .5rem; font-weight: 600;
    color: var(--vscode-foreground);
  }
  .hint, .sub { color: var(--vscode-descriptionForeground); font-weight: 400; }
  .sub { margin: 0 0 1.25rem; font-size: .9em; }
  .hint { font-size: .85em; margin-left: .5rem; }
  .empty { color: var(--vscode-descriptionForeground); max-width: 52ch; }
  .note {
    color: var(--vscode-descriptionForeground);
    font-size: .88em; margin: .6rem 0 0; max-width: 68ch;
  }
  .warn {
    color: var(--vscode-inputValidation-warningForeground,
                var(--vscode-editorWarning-foreground));
    border-left: 3px solid var(--vscode-editorWarning-foreground);
    padding: .4rem .75rem; margin: 1rem 0;
    background: var(--vscode-textBlockQuote-background);
  }
  .cards {
    display: grid; gap: .75rem; margin: 1rem 0 .5rem;
    grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
  }
  .card {
    display: flex; flex-direction: column; gap: .1rem;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border, transparent);
    border-left: 3px solid var(--vscode-charts-blue, #3794ff);
    border-radius: 6px; padding: .6rem .9rem;
  }
  .card.near { border-left-color: var(--vscode-charts-orange, #d18616); }
  .card.over { border-left-color: var(--vscode-charts-red, #f14c4c); }
  .card .label {
    font-size: .74em; text-transform: uppercase; letter-spacing: .05em;
    color: var(--vscode-descriptionForeground);
  }
  .card .value {
    font-size: 1.3rem; font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .card .sub-value {
    font-size: .8em; color: var(--vscode-descriptionForeground);
    font-variant-numeric: tabular-nums;
  }
  .legend { margin: 0 0 .4rem; font-size: .82em; display: flex; gap: 1rem; flex-wrap: wrap; }
  .legend-item {
    display: inline-flex; align-items: center; gap: .35rem;
    color: var(--vscode-descriptionForeground);
  }
  .swatch {
    width: .7rem; height: .7rem; border-radius: 2px; display: inline-block;
  }
  table {
    border-collapse: collapse; width: 100%; margin-top: .5rem;
    font-size: .9em; display: block; overflow-x: auto;
  }
  thead th {
    text-align: left; font-weight: 600; padding: .4rem .6rem;
    border-bottom: 1px solid var(--vscode-panel-border,
                                 var(--vscode-editorWidget-border));
    white-space: nowrap;
  }
  tbody td {
    padding: .35rem .6rem;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }
  tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .cost { font-weight: 600; }
  .time { white-space: nowrap; color: var(--vscode-descriptionForeground); }
  .prompt { max-width: 40ch; }
  code {
    font-family: var(--vscode-editor-font-family);
    background: var(--vscode-textCodeBlock-background); padding: .1em .3em;
    border-radius: 3px;
  }
  .footnote {
    margin-top: 2rem; font-size: .85em; max-width: 62ch;
    color: var(--vscode-descriptionForeground);
  }
${CHART_CSS}
</style>
</head>
<body>${body}</body>
</html>`;
}
