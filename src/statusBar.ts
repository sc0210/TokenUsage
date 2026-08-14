import * as vscode from 'vscode';

import { allRecords, elapsedMs, lastActivePrompt, promptCount } from './aggregate';
import {
  escapeMarkdown,
  excerpt,
  formatCostPrecise,
  formatDuration,
  formatInt,
  formatPercent,
  formatTokens,
} from './format';
import { Pricer, cacheHitRate } from './pricing';
import { DisplayMode, buildStatusText } from './statusText';
import { SessionState, Totals } from './types';

export type { DisplayMode };

export interface StatusBarConfig {
  display: DisplayMode;
  warnThresholdUSD: number;
  priority: number;
}

/** A source with history here that is not the one being read. */
export interface OtherSource {
  kind: string;
  lastActivityMs: number;
}

export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private sourceLabel: string | undefined;
  private others: readonly OtherSource[] = [];

  constructor(
    private pricer: Pricer,
    private config: StatusBarConfig,
  ) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      config.priority,
    );
    this.item.command = 'tokenUsage.showDetails';
    this.item.name = 'Token Usage';
  }

  updateConfig(pricer: Pricer, config: StatusBarConfig): void {
    this.pricer = pricer;
    this.config = config;
  }

  /** Which source is being read, and which others have history here. */
  updateSource(label: string | undefined, others: readonly OtherSource[]): void {
    this.sourceLabel = label;
    this.others = others;
  }

  render(state: SessionState | undefined): void {
    // A workspace Claude Code has never touched is the common case, not an
    // error — say nothing rather than occupying the status bar with a zero.
    if (!state || state.prompts.length === 0) {
      this.item.hide();
      return;
    }

    const records = allRecords(state);
    if (records.length === 0) {
      this.item.hide();
      return;
    }

    const sessionTotals = this.pricer.totalsOf(records);
    const last = lastActivePrompt(state);
    const lastTotals = last ? this.pricer.totalsOf(last.records) : undefined;

    this.item.text = buildStatusText(sessionTotals, lastTotals, this.config.display);
    this.item.tooltip = this.buildTooltip(state, sessionTotals, lastTotals);
    this.item.backgroundColor =
      this.config.warnThresholdUSD > 0 &&
      sessionTotals.costUSD >= this.config.warnThresholdUSD
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    this.item.show();
  }

  private buildTooltip(
    state: SessionState,
    session: Totals,
    lastTotals: Totals | undefined,
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    // Required for the command: link at the bottom to be clickable.
    md.isTrusted = true;
    md.supportThemeIcons = true;

    const prompts = promptCount(state);
    md.appendMarkdown(
      `**Token Usage** — this workspace's active session${
        this.sourceLabel ? ` · ${this.sourceLabel}` : ''
      }\n\n`,
    );
    md.appendMarkdown(
      `${prompts} prompt${prompts === 1 ? '' : 's'} · ` +
        `${session.requests} request${session.requests === 1 ? '' : 's'} · ` +
        `${formatDuration(elapsedMs(state))}\n\n`,
    );

    // Say so when another agent has also been used here, rather than letting
    // its spend look like it vanished.
    if (this.others.length > 0) {
      const names = this.others
        .map((o) => `${o.kind} (last active ${formatDuration(Date.now() - o.lastActivityMs)} ago)`)
        .join(', ');
      md.appendMarkdown(`Also used here: ${names}\n\n`);
    }

    md.appendMarkdown(`| | Tokens | Cost |\n|:--|--:|--:|\n`);
    const rate = (model: string) => this.pricer.rateFor(model).input;
    // Cost per row is only well-defined for a single model; when a session
    // spans models the per-model table below is the authoritative breakdown.
    const models = this.pricer.totalsByModel(allRecords(state));
    const single = models.size === 1 ? [...models.keys()][0] : undefined;
    const inRate = single ? rate(single) : undefined;
    const outRate = single ? this.pricer.rateFor(single).output : undefined;

    const row = (label: string, tokens: number, cost: number | undefined) =>
      md.appendMarkdown(
        `| ${label} | ${formatInt(tokens)} | ${
          cost === undefined ? '—' : formatCostPrecise(cost)
        } |\n`,
      );

    row(
      'Input',
      session.input,
      inRate === undefined ? undefined : (session.input * inRate) / 1e6,
    );
    row(
      'Output',
      session.output,
      outRate === undefined ? undefined : (session.output * outRate) / 1e6,
    );
    row(
      'Cache write (5m)',
      session.cacheWrite5m,
      inRate === undefined ? undefined : (session.cacheWrite5m * inRate * 1.25) / 1e6,
    );
    row(
      'Cache write (1h)',
      session.cacheWrite1h,
      inRate === undefined ? undefined : (session.cacheWrite1h * inRate * 2.0) / 1e6,
    );
    row(
      'Cache read',
      session.cacheRead,
      inRate === undefined ? undefined : (session.cacheRead * inRate * 0.1) / 1e6,
    );
    md.appendMarkdown(`| **Total** | | **${formatCostPrecise(session.costUSD)}** |\n\n`);

    md.appendMarkdown(
      `Cache hit rate: **${formatPercent(cacheHitRate(session))}**\n\n`,
    );

    if (models.size > 1) {
      md.appendMarkdown(`**By model**\n\n| Model | Requests | Cost |\n|:--|--:|--:|\n`);
      for (const [model, totals] of models) {
        md.appendMarkdown(
          `| \`${model}\` | ${totals.requests} | ${formatCostPrecise(totals.costUSD)} |\n`,
        );
      }
      md.appendMarkdown('\n');
    }

    const unknown = this.pricer.unknownModelsIn(allRecords(state));
    if (unknown.length > 0) {
      md.appendMarkdown(
        `⚠️ Unrecognised model${unknown.length === 1 ? '' : 's'} ` +
          `priced at the Opus fallback rate: ` +
          `${unknown.map((m) => `\`${m}\``).join(', ')}\n\n`,
      );
    }

    const last = lastActivePrompt(state);
    if (last && lastTotals) {
      md.appendMarkdown(`**Last prompt**\n\n`);
      md.appendMarkdown(`> ${escapeMarkdown(excerpt(last.promptText, 80))}\n\n`);
      md.appendMarkdown(
        `${lastTotals.requests} request${lastTotals.requests === 1 ? '' : 's'} · ` +
          `↑${formatTokens(lastTotals.weightedInput)} weighted in · ` +
          `↓${formatTokens(lastTotals.output)} out · ` +
          `${formatCostPrecise(lastTotals.costUSD)}\n\n`,
      );
    }

    md.appendMarkdown(
      `↑ counts cache reads at 0.1× and cache writes at 1.25×/2× so it tracks spend.\n\n`,
    );
    md.appendMarkdown(`[Show session details](command:tokenUsage.showDetails)`);
    return md;
  }

  dispose(): void {
    this.item.dispose();
  }
}
