/**
 * End-to-end smoke test: drives the real SessionTracker against a real
 * workspace and prints exactly what the status bar would show.
 *
 * Everything below the `vscode` boundary runs here unmodified — provider,
 * resolver, tailer, watcher, aggregator, pricer, and the status-bar label.
 *
 * Usage:
 *   node ./out/test/smoke.js [workspaceFolder] [--watch]
 *
 * With --watch it stays running and re-renders on every append, which is how
 * to confirm the live-update path without an editor.
 */
import * as os from 'os';
import * as path from 'path';

import { allRecords, effectivePrompts, elapsedMs, lastActivePrompt } from '../aggregate';
import {
  excerpt,
  formatCostPrecise,
  formatDuration,
  formatInt,
  formatPercent,
} from '../format';
import { Pricer, cacheHitRate } from '../pricing';
import { ClaudeCodeProvider } from '../providers/claudeCode';
import { SessionTracker } from '../session';
import { buildStatusText } from '../statusText';
import { SessionState } from '../types';

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const workspace = path.resolve(
  args.find((a) => !a.startsWith('--')) ?? process.cwd(),
);

const pricer = new Pricer();
const provider = ClaudeCodeProvider.fromConfiguredPath('~/.claude/projects');

let renders = 0;

function render(state: SessionState | undefined, tracker: SessionTracker): void {
  renders += 1;
  const stamp = new Date().toLocaleTimeString('en-US');
  console.log(`\n───── render #${renders} at ${stamp} ─────`);

  if (!state || state.prompts.length === 0) {
    console.log('status bar: (hidden — no session for this workspace)');
    return;
  }

  const records = allRecords(state);
  if (records.length === 0) {
    console.log('status bar: (hidden — session found but no requests yet)');
    return;
  }

  const session = pricer.totalsOf(records);
  const last = lastActivePrompt(state);
  const lastTotals = last ? pricer.totalsOf(last.records) : undefined;

  console.log(`status bar: ${buildStatusText(session, lastTotals, 'cost-and-tokens')}`);
  console.log(`            ${buildStatusText(session, lastTotals, 'cost')}`);
  console.log(`            ${buildStatusText(session, lastTotals, 'tokens')}`);

  console.log(
    `\nsession    ${tracker.sessionName} · ${tracker.sourceCount} file(s) followed`,
  );
  console.log(
    `           ${state.prompts.length} prompts · ${session.requests} requests · ` +
      `${formatDuration(elapsedMs(state))}`,
  );
  if (state.unattributedRecords.length > 0) {
    console.log(`           ${state.unattributedRecords.length} sub-agent requests`);
  }

  console.log('\ntokens');
  const row = (label: string, n: number) =>
    console.log(`  ${label.padEnd(18)}${formatInt(n).padStart(14)}`);
  row('input', session.input);
  row('output', session.output);
  row('cache write 5m', session.cacheWrite5m);
  row('cache write 1h', session.cacheWrite1h);
  row('cache read', session.cacheRead);
  row('weighted input', session.weightedInput);
  console.log(`  ${'cache hit rate'.padEnd(18)}${formatPercent(cacheHitRate(session)).padStart(14)}`);
  console.log(`  ${'cost'.padEnd(18)}${formatCostPrecise(session.costUSD).padStart(14)}`);

  const byModel = pricer.totalsByModel(records);
  if (byModel.size > 0) {
    console.log('\nby model');
    for (const [model, totals] of byModel) {
      console.log(
        `  ${model.padEnd(22)}${String(totals.requests).padStart(5)} req  ` +
          `${formatCostPrecise(totals.costUSD).padStart(10)}`,
      );
    }
  }

  const unknown = pricer.unknownModelsIn(records);
  if (unknown.length > 0) {
    console.log(`\n  ! unpriced models (Opus fallback): ${unknown.join(', ')}`);
  }

  const prompts = effectivePrompts(state).filter((p) => p.records.length > 0);
  console.log('\nlast 5 prompts');
  for (const prompt of prompts.slice(-5)) {
    const t = pricer.totalsOf(prompt.records);
    console.log(
      `  ${formatCostPrecise(t.costUSD).padStart(10)}  ` +
        `${String(t.requests).padStart(3)} req  ` +
        `${excerpt(prompt.promptText, 60)}`,
    );
  }
}

async function main(): Promise<void> {
  console.log(`workspace: ${workspace}`);
  console.log(`home:      ${os.homedir()}`);

  const session = await provider.resolveSession(workspace);
  if (session) {
    console.log(`resolved:  ${session.primary}`);
    if (session.auxiliary.length > 0) {
      console.log(`auxiliary: ${session.auxiliary.length} sub-agent file(s)`);
    }
  } else {
    console.log('resolved:  (none)');
  }

  const tracker = new SessionTracker(provider, workspace, (state) =>
    render(state, tracker),
  );
  await tracker.start();

  if (!watch) {
    tracker.dispose();
    return;
  }

  console.log('\nwatching for appends — Ctrl-C to stop');
  process.on('SIGINT', () => {
    tracker.dispose();
    process.exit(0);
  });
  // Hold the process open; the tracker's watcher timers are unref'd so they
  // would not keep it alive on their own.
  setInterval(() => undefined, 1 << 30);
}

void main();
