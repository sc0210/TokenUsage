import * as vscode from 'vscode';

import { allRecords, lastActivePrompt } from './aggregate';
import { DEFAULT_THRESHOLDS, normaliseThresholds } from './budget';
import { BudgetOptions, BudgetTracker } from './budgetTracker';
import { DetailsPanel } from './details';
import {
  excerpt,
  formatCostPrecise,
  formatDuration,
  formatInt,
  formatPercent,
  formatTokens,
} from './format';
import { ModelRate, Pricer, cacheHitRate } from './pricing';
import { CursorApiProvider } from './providers/cursorApi';
import {
  ProviderKind,
  SOURCE_LABELS,
  SourceActivity,
  detectSources,
  selectProvider,
} from './providers/detect';
import { describeBackend, resolveBackend } from './providers/sqlite';
import { isPeriodSpendSource } from './providers/types';
import { SessionTracker } from './session';
import { DisplayMode, StatusBar, StatusBarConfig } from './statusBar';
import { SessionState } from './types';

let statusBar: StatusBar | undefined;
let tracker: SessionTracker | undefined;
let budgetTracker: BudgetTracker | undefined;
let pricer = new Pricer();
let latestState: SessionState | undefined;
let activeSource: ProviderKind | undefined;
let otherSources: SourceActivity[] = [];
let extensionContext: vscode.ExtensionContext | undefined;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  pricer = buildPricer();
  statusBar = new StatusBar(pricer, readStatusBarConfig());
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenUsage.showDetails', () => {
      DetailsPanel.show(pricer, latestState, tracker?.sessionName);
    }),
    vscode.commands.registerCommand('tokenUsage.refresh', async () => {
      await Promise.all([tracker?.rebuild(), budgetTracker?.refresh()]);
    }),
    vscode.commands.registerCommand('tokenUsage.copySessionSummary', async () => {
      const summary = buildSummary(latestState, tracker?.sessionName);
      if (!summary) {
        void vscode.window.showInformationMessage(
          'Token Usage: no session data for this workspace yet.',
        );
        return;
      }
      await vscode.env.clipboard.writeText(summary);
      void vscode.window.showInformationMessage('Token Usage: summary copied.');
    }),
    vscode.commands.registerCommand('tokenUsage.selectSource', selectSource),
    vscode.commands.registerCommand('tokenUsage.showDiagnostics', showDiagnostics),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => void restartTracker()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('tokenUsage')) {
        return;
      }
      pricer = buildPricer();
      statusBar?.updateConfig(pricer, readStatusBarConfig());
      // Provider or path may have changed; rebuild from scratch rather than
      // reasoning about which specific key moved.
      void restartTracker();
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      tracker?.dispose();
      budgetTracker?.dispose();
    },
  });

  void restartTracker();
}

export function deactivate(): void {
  tracker?.dispose();
  tracker = undefined;
  budgetTracker?.dispose();
  budgetTracker = undefined;
  if (reselectTimer) {
    clearInterval(reselectTimer);
    reselectTimer = undefined;
  }
  statusBar?.dispose();
  statusBar = undefined;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('tokenUsage');
}

function buildPricer(): Pricer {
  const overrides =
    config().get<Record<string, Partial<ModelRate>>>('pricing') ?? {};
  return new Pricer(overrides);
}

function readStatusBarConfig(): StatusBarConfig {
  const c = config();
  return {
    display: c.get<DisplayMode>('display') ?? 'cost-and-tokens',
    warnThresholdUSD: c.get<number>('warnThresholdUSD') ?? 0,
    priority: c.get<number>('statusBarPriority') ?? 100,
  };
}

/**
 * How often `auto` re-checks which source is the live one.
 *
 * Switching between agents mid-session is normal — ask Cursor something while a
 * Claude Code run is going — and the tracker's own discovery timer only fires
 * while there is no session at all, so it would never notice the change.
 */
const RESELECT_INTERVAL_MS = 30_000;

let reselectTimer: NodeJS.Timeout | undefined;

async function restartTracker(): Promise<void> {
  tracker?.dispose();
  tracker = undefined;
  budgetTracker?.dispose();
  budgetTracker = undefined;
  latestState = undefined;
  statusBar?.updateBudget(undefined);

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file') {
    activeSource = undefined;
    otherSources = [];
    statusBar?.render(undefined);
    return;
  }

  const c = config();
  const selection = await selectProvider(
    c.get<string>('provider') ?? 'auto',
    folder.uri.fsPath,
    c.get<string>('claudeProjectsPath') ?? '~/.claude/projects',
  );
  activeSource = selection.active;
  otherSources = selection.others;
  statusBar?.updateSource(sourceLabel(), otherSources);

  if (!selection.provider) {
    statusBar?.render(undefined);
    ensureReselectTimer();
    return;
  }

  tracker = new SessionTracker(selection.provider, folder.uri.fsPath, (state) => {
    latestState = state;
    statusBar?.render(state);
    DetailsPanel.updateIfOpen(pricer, state, tracker?.sessionName);
  });
  await tracker.start();
  startBudgetTracker(selection.provider);
  ensureReselectTimer();
}

/**
 * Follow the budget for whichever source is active.
 *
 * One tracker rather than one per source: the budgets are per plan and the
 * status bar shows one source at a time, so following the inactive one would
 * cost a paginated API call every five minutes to display nothing.
 */
function startBudgetTracker(provider: unknown): void {
  if (!activeSource || !isPeriodSpendSource(provider)) {
    return;
  }
  const options = readBudgetOptions(activeSource);
  if (!(options.budgetUSD > 0)) {
    return;
  }
  const store = extensionContext?.globalState;
  budgetTracker = new BudgetTracker({
    source: provider,
    sourceId: activeSource,
    sourceLabel: SOURCE_LABELS[activeSource],
    pricer,
    options,
    onChange: (reading) => statusBar?.updateBudget(reading),
    store: {
      get: (key) => store?.get<number>(key),
      update: (key, value) => store?.update(key, value),
    },
    warn: (message) => {
      void vscode.window
        .showWarningMessage(message, 'Show details')
        .then((choice) => {
          if (choice === 'Show details') {
            void vscode.commands.executeCommand('tokenUsage.showDetails');
          }
        });
    },
  });
  void budgetTracker.start();
}

function readBudgetOptions(source: ProviderKind): BudgetOptions {
  const c = config();
  const key = source === 'cursor' ? 'budget.cursorUSD' : 'budget.claudeUSD';
  return {
    budgetUSD: c.get<number>(key) ?? 0,
    cycleStartDay: c.get<number>('budget.cycleStartDay') ?? 1,
    thresholds: normaliseThresholds(
      c.get<number[]>('budget.warnAtPercent') ?? DEFAULT_THRESHOLDS,
    ),
  };
}

function sourceLabel(): string | undefined {
  return activeSource ? SOURCE_LABELS[activeSource] : undefined;
}

function ago(ms: number): string {
  return `${formatDuration(Math.max(0, Date.now() - ms))} ago`;
}

/**
 * Pick which source to read, showing what was detected.
 *
 * Auto-selection is otherwise invisible: with both agents used in a folder the
 * quieter one simply never appears, and there is no way to tell that from the
 * extension being broken.
 */
async function selectSource(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file') {
    void vscode.window.showErrorMessage('Token Usage: open a folder first.');
    return;
  }

  const claudeRoot =
    config().get<string>('claudeProjectsPath') ?? '~/.claude/projects';
  const detected = await detectSources(folder.uri.fsPath, claudeRoot);
  const byKind = new Map(detected.map((d) => [d.kind, d.lastActivityMs]));

  const describe = (kind: ProviderKind): string => {
    const seen = byKind.get(kind);
    return seen ? `last active ${ago(seen)}` : 'no history in this folder';
  };

  const items: Array<vscode.QuickPickItem & { value: string }> = [
    {
      label: 'Auto',
      description: detected.length
        ? `→ ${SOURCE_LABELS[detected[0].kind]} (most recent)`
        : 'nothing detected here',
      detail: 'Follow whichever source was most recently active.',
      value: 'auto',
    },
    {
      label: SOURCE_LABELS['claude-code'],
      description: describe('claude-code'),
      detail: 'Always read Claude Code transcripts.',
      value: 'claude-code',
    },
    {
      label: SOURCE_LABELS.cursor,
      description: describe('cursor'),
      detail: "Always read Cursor's billing API.",
      value: 'cursor',
    },
  ];

  const current = config().get<string>('provider') ?? 'auto';
  for (const item of items) {
    if (item.value === current) {
      item.label = `$(check) ${item.label}`;
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Token Usage: source for this workspace',
    placeHolder: `Currently: ${current}`,
  });
  if (!picked) {
    return;
  }
  await config().update(
    'provider',
    picked.value,
    vscode.ConfigurationTarget.Workspace,
  );
  // The configuration listener restarts the tracker; report what happened, since
  // a source with no data still renders as a hidden item.
  await restartTracker();
  if (!latestState && picked.value !== 'auto') {
    void vscode.window
      .showWarningMessage(
        `Token Usage: ${picked.label.replace('$(check) ', '')} has nothing to show here.`,
        'Why?',
      )
      .then((choice) => {
        if (choice === 'Why?') {
          void showDiagnostics();
        }
      });
  }
}

/** Write a full account of what was detected and why, to an output channel. */
async function showDiagnostics(): Promise<void> {
  const channel = ensureChannel();
  channel.clear();
  channel.show(true);

  const folder = vscode.workspace.workspaceFolders?.[0];
  channel.appendLine('Token Usage — diagnostics');
  channel.appendLine('='.repeat(60));
  channel.appendLine(`editor          ${vscode.env.appName}`);
  channel.appendLine(`workspace       ${folder?.uri.fsPath ?? '(none open)'}`);
  channel.appendLine(`provider setting ${config().get<string>('provider') ?? 'auto'}`);
  channel.appendLine(`active source   ${sourceLabel() ?? '(none)'}`);
  const backend = await resolveBackend();
  channel.appendLine(
    `sqlite backend  ${backend ? describeBackend(backend) : '(none available)'}`,
  );
  channel.appendLine('');

  if (!folder || folder.uri.scheme !== 'file') {
    channel.appendLine('No file-scheme folder is open, so nothing can be read.');
    return;
  }

  const claudeRoot =
    config().get<string>('claudeProjectsPath') ?? '~/.claude/projects';
  const detected = await detectSources(folder.uri.fsPath, claudeRoot);
  channel.appendLine('Detected sources (newest first)');
  if (detected.length === 0) {
    channel.appendLine('  none — neither agent has history for this folder');
  }
  for (const source of detected) {
    channel.appendLine(
      `  ${SOURCE_LABELS[source.kind].padEnd(12)} last active ${ago(
        source.lastActivityMs,
      )}`,
    );
  }
  channel.appendLine('');

  channel.appendLine('Cursor');
  try {
    const reason = await new CursorApiProvider().diagnose(folder.uri.fsPath);
    channel.appendLine(`  ${reason}`);
  } catch (error) {
    channel.appendLine(
      `  diagnosis failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  channel.appendLine('');

  channel.appendLine('Budget');
  if (!activeSource) {
    channel.appendLine('  no active source, so no budget is being followed');
  } else {
    const options = readBudgetOptions(activeSource);
    if (!(options.budgetUSD > 0)) {
      channel.appendLine(`  not set for ${SOURCE_LABELS[activeSource]}`);
    } else {
      const reading = budgetTracker?.current;
      channel.appendLine(`  budget    ${formatCostPrecise(options.budgetUSD)}`);
      channel.appendLine(`  cycle day ${options.cycleStartDay}`);
      channel.appendLine(`  warn at   ${options.thresholds.join('%, ')}%`);
      channel.appendLine(
        reading
          ? `  spent     ${formatCostPrecise(reading.spentUSD)} (${formatPercent(
              reading.fraction,
            )}) since ${new Date(reading.period.startMs).toLocaleDateString()}`
          : '  spent     not read yet',
      );
    }
  }
  channel.appendLine('');

  channel.appendLine('Current reading');
  if (!latestState) {
    channel.appendLine('  no state — the status bar item is hidden');
  } else {
    const records = allRecords(latestState);
    const totals = pricer.totalsOf(records);
    channel.appendLine(`  session   ${tracker?.sessionName ?? '(unnamed)'}`);
    channel.appendLine(`  prompts   ${latestState.prompts.length}`);
    channel.appendLine(`  requests  ${totals.requests}`);
    channel.appendLine(`  cost      ${formatCostPrecise(totals.costUSD)}`);
  }
}

let channel: vscode.OutputChannel | undefined;

function ensureChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Token Usage');
  }
  return channel;
}

/**
 * Re-run detection and restart only when the winner actually changed. Restarting
 * unconditionally would discard tail offsets every 30s and re-read every
 * transcript from byte zero.
 */
async function reselectIfChanged(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file') {
    return;
  }
  const c = config();
  const configured = c.get<string>('provider') ?? 'auto';
  if (configured !== 'auto') {
    return;
  }
  try {
    const selection = await selectProvider(
      configured,
      folder.uri.fsPath,
      c.get<string>('claudeProjectsPath') ?? '~/.claude/projects',
    );
    if (selection.active !== activeSource) {
      await restartTracker();
    } else {
      // Same winner, but the runners-up may have moved.
      otherSources = selection.others;
      statusBar?.updateSource(sourceLabel(), otherSources);
    }
  } catch {
    // Detection is best-effort; keep whatever is on screen.
  }
}

function ensureReselectTimer(): void {
  if (reselectTimer) {
    return;
  }
  reselectTimer = setInterval(() => {
    void reselectIfChanged();
  }, RESELECT_INTERVAL_MS);
  if (typeof reselectTimer.unref === 'function') {
    reselectTimer.unref();
  }
}

function buildSummary(
  state: SessionState | undefined,
  sessionName: string | undefined,
): string | undefined {
  if (!state || state.prompts.length === 0) {
    return undefined;
  }
  const records = allRecords(state);
  if (records.length === 0) {
    return undefined;
  }

  const totals = pricer.totalsOf(records);
  const lines: string[] = [
    `# Token usage — ${sessionName ?? 'session'}`,
    '',
    `- Prompts: ${state.prompts.length}`,
    `- Requests: ${totals.requests}`,
    `- Cost: ${formatCostPrecise(totals.costUSD)}`,
    `- Cache hit rate: ${formatPercent(cacheHitRate(totals))}`,
    '',
    '| Category | Tokens |',
    '|:--|--:|',
    `| Input | ${formatInt(totals.input)} |`,
    `| Output | ${formatInt(totals.output)} |`,
    `| Cache write (5m) | ${formatInt(totals.cacheWrite5m)} |`,
    `| Cache write (1h) | ${formatInt(totals.cacheWrite1h)} |`,
    `| Cache read | ${formatInt(totals.cacheRead)} |`,
    `| Weighted input | ${formatInt(totals.weightedInput)} |`,
    '',
  ];

  const byModel = pricer.totalsByModel(records);
  if (byModel.size > 1) {
    lines.push('| Model | Requests | Cost |', '|:--|--:|--:|');
    for (const [model, t] of byModel) {
      lines.push(`| \`${model}\` | ${t.requests} | ${formatCostPrecise(t.costUSD)} |`);
    }
    lines.push('');
  }

  const last = lastActivePrompt(state);
  if (last) {
    const t = pricer.totalsOf(last.records);
    lines.push(
      `Last prompt — "${excerpt(last.promptText, 60)}": ` +
        `↑${formatTokens(t.weightedInput)} ↓${formatTokens(t.output)}, ` +
        `${formatCostPrecise(t.costUSD)}`,
    );
  }

  return lines.join('\n');
}
