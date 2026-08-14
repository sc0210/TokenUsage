import * as vscode from 'vscode';

import { allRecords, effectivePrompts, elapsedMs } from './aggregate';
import {
  escapeHtml,
  excerpt,
  formatClock,
  formatCostPrecise,
  formatDuration,
  formatInt,
  formatPercent,
} from './format';
import { Pricer, cacheHitRate } from './pricing';
import { SessionState } from './types';

export class DetailsPanel {
  private static current: DetailsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  private constructor(
    private pricer: Pricer,
    private state: SessionState | undefined,
    private sessionName: string | undefined,
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

  static show(
    pricer: Pricer,
    state: SessionState | undefined,
    sessionName: string | undefined,
  ): DetailsPanel {
    if (DetailsPanel.current && !DetailsPanel.current.disposed) {
      DetailsPanel.current.update(pricer, state, sessionName);
      DetailsPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return DetailsPanel.current;
    }
    DetailsPanel.current = new DetailsPanel(pricer, state, sessionName);
    return DetailsPanel.current;
  }

  /** Push new data into an already-open panel; no-op when it is closed. */
  static updateIfOpen(
    pricer: Pricer,
    state: SessionState | undefined,
    sessionName: string | undefined,
  ): void {
    if (DetailsPanel.current && !DetailsPanel.current.disposed) {
      DetailsPanel.current.update(pricer, state, sessionName);
    }
  }

  private update(
    pricer: Pricer,
    state: SessionState | undefined,
    sessionName: string | undefined,
  ): void {
    this.pricer = pricer;
    this.state = state;
    this.sessionName = sessionName;
    this.refresh();
  }

  private refresh(): void {
    if (!this.disposed) {
      this.panel.webview.html = this.render();
    }
  }

  private render(): string {
    const state = this.state;
    if (!state || state.prompts.length === 0) {
      return page(
        `<h1>Token Usage</h1>
         <p class="empty">No Claude Code session found for this workspace.</p>
         <p class="empty">Transcripts are read from <code>~/.claude/projects</code>.
         Run a prompt in this folder and the readout will appear.</p>`,
      );
    }

    const records = allRecords(state);
    const session = this.pricer.totalsOf(records);
    const models = this.pricer.totalsByModel(records);
    const unknown = this.pricer.unknownModelsIn(records);

    const rows = effectivePrompts(state)
      .filter((p) => p.records.length > 0)
      .map((prompt, index) => {
        const t = this.pricer.totalsOf(prompt.records);
        return `<tr>
          <td class="num">${index + 1}</td>
          <td class="time">${escapeHtml(formatClock(prompt.startedAtMs))}</td>
          <td class="prompt">${escapeHtml(excerpt(prompt.promptText, 90))}</td>
          <td class="num">${t.requests}</td>
          <td class="num">${formatInt(t.input)}</td>
          <td class="num">${formatInt(t.cacheWrite5m + t.cacheWrite1h)}</td>
          <td class="num">${formatInt(t.cacheRead)}</td>
          <td class="num">${formatInt(t.output)}</td>
          <td class="num cost">${formatCostPrecise(t.costUSD)}</td>
        </tr>`;
      })
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

    return page(`
      <h1>Token Usage</h1>
      <p class="sub">
        ${escapeHtml(this.sessionName ?? 'session')} ·
        ${state.prompts.length} prompt${state.prompts.length === 1 ? '' : 's'} ·
        ${session.requests} request${session.requests === 1 ? '' : 's'} ·
        ${escapeHtml(formatDuration(elapsedMs(state)))}${
          state.unattributedRecords.length > 0
            ? ` · includes ${state.unattributedRecords.length} sub-agent request${
                state.unattributedRecords.length === 1 ? '' : 's'
              }`
            : ''
        }
      </p>

      <div class="cards">
        <div class="card"><span class="label">Session cost</span>
          <span class="value">${formatCostPrecise(session.costUSD)}</span></div>
        <div class="card"><span class="label">Output tokens</span>
          <span class="value">${formatInt(session.output)}</span></div>
        <div class="card"><span class="label">Cache hit rate</span>
          <span class="value">${formatPercent(cacheHitRate(session))}</span></div>
        <div class="card"><span class="label">Weighted input</span>
          <span class="value">${formatInt(session.weightedInput)}</span></div>
      </div>

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

      <p class="footnote">
        Weighted input counts cache reads at 0.1× and cache writes at 1.25× (5&nbsp;min)
        or 2× (1&nbsp;hour), matching how they bill. Raw totals are dominated by cache
        reads and do not track spend.
      </p>
    `);
  }

  dispose(): void {
    this.panel.dispose();
  }
}

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
  }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; font-weight: 600; }
  h2 { font-size: 1rem; margin: 2rem 0 .5rem; font-weight: 600; }
  .hint, .sub { color: var(--vscode-descriptionForeground); font-weight: 400; }
  .sub { margin: 0 0 1.25rem; font-size: .9em; }
  .hint { font-size: .85em; }
  .empty { color: var(--vscode-descriptionForeground); max-width: 46ch; }
  .warn {
    color: var(--vscode-inputValidation-warningForeground,
                var(--vscode-editorWarning-foreground));
    border-left: 3px solid var(--vscode-editorWarning-foreground);
    padding: .4rem .75rem; margin: 1rem 0;
    background: var(--vscode-textBlockQuote-background);
  }
  .cards { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1rem 0 .5rem; }
  .card {
    display: flex; flex-direction: column; gap: .15rem;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 6px; padding: .6rem .9rem; min-width: 9rem;
  }
  .card .label {
    font-size: .78em; text-transform: uppercase; letter-spacing: .04em;
    color: var(--vscode-descriptionForeground);
  }
  .card .value {
    font-size: 1.25rem; font-weight: 600;
    font-variant-numeric: tabular-nums;
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
</style>
</head>
<body>${body}</body>
</html>`;
}
