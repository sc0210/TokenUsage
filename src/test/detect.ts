/**
 * Checks for source auto-detection.
 *
 * The interesting case is a workspace that has been worked on with *both*
 * agents, which is not exotic: Claude Code runs in a terminal, and that terminal
 * is very often Cursor's own. This repository is such a workspace, so the
 * detection is exercised against it directly.
 *
 * Run with: npm run compile && npm run test:detect
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SOURCE_LABELS,
  detectSources,
  selectProvider,
} from '../providers/detect';

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

const CLAUDE_ROOT = '~/.claude/projects';
const CURSOR_USER = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Cursor',
  'User',
);

async function main(): Promise<void> {
  console.log('\nSource detection\n');

  const here = path.resolve(__dirname, '../..');

  // ---- explicit configuration wins ----------------------------------------
  console.log('  explicit configuration');
  for (const kind of ['claude-code', 'cursor'] as const) {
    const selection = await selectProvider(kind, here, CLAUDE_ROOT, CURSOR_USER);
    check(`"${kind}" is honoured as-is`, selection.active, kind);
    assertTrue(
      `  and yields a provider`,
      selection.provider !== undefined,
    );
    check(
      `  and reports no runners-up`,
      selection.others.length,
      0,
    );
  }

  const custom = await selectProvider('custom', here, CLAUDE_ROOT, CURSOR_USER);
  check('"custom" still reports nothing', custom.provider, undefined);
  check('  and names no source', custom.active, undefined);

  // ---- a folder neither agent has touched ---------------------------------
  console.log('\n  empty workspace');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-detect-'));
  const none = await detectSources(empty, CLAUDE_ROOT, CURSOR_USER);
  check('no sources detected', none.length, 0);
  const noneSel = await selectProvider('auto', empty, CLAUDE_ROOT, CURSOR_USER);
  check('auto selects nothing', noneSel.provider, undefined);
  check('  and names no source', noneSel.active, undefined);

  // ---- this repository, which has both ------------------------------------
  console.log('\n  this workspace');
  const sources = await detectSources(here, CLAUDE_ROOT, CURSOR_USER);
  if (sources.length === 0) {
    skip('real detection', 'no agent history for this folder');
  } else {
    console.log(
      `  info  ${sources
        .map(
          (s) =>
            `${SOURCE_LABELS[s.kind]}@${new Date(s.lastActivityMs)
              .toISOString()
              .slice(11, 16)}`,
        )
        .join('  ')}`,
    );
    assertTrue(
      'sources are ordered newest first',
      sources.every(
        (s, i) => i === 0 || sources[i - 1].lastActivityMs >= s.lastActivityMs,
      ),
    );
    assertTrue(
      'every detected source has real activity',
      sources.every((s) => s.lastActivityMs > 0),
    );

    const auto = await selectProvider('auto', here, CLAUDE_ROOT, CURSOR_USER);
    check('auto picks the newest', auto.active, sources[0].kind);
    assertTrue('  and yields a provider', auto.provider !== undefined);
    check(
      '  and reports the rest as runners-up',
      auto.others.length,
      sources.length - 1,
    );
    assertTrue(
      '  runners-up exclude the winner',
      auto.others.every((o) => o.kind !== auto.active),
    );

    if (sources.length > 1) {
      console.log(
        `  info  both agents used here — active ${SOURCE_LABELS[auto.active!]}, ` +
          `also ${auto.others.map((o) => SOURCE_LABELS[o.kind]).join(', ')}`,
      );
      assertTrue(
        'the losing source is surfaced, not dropped',
        auto.others.length > 0,
        'otherwise its spend would look like it vanished',
      );
    } else {
      skip('both-agent case', 'only one source has history here');
    }
  }

  // ---- detection never throws ---------------------------------------------
  console.log('\n  robustness');
  const bogus = await detectSources(
    here,
    '/nonexistent/claude/root',
    '/nonexistent/cursor/user',
  );
  check('missing roots detect nothing', bogus.length, 0);
  const bogusSel = await selectProvider(
    'auto',
    here,
    '/nonexistent/claude/root',
    '/nonexistent/cursor/user',
  );
  check('  and select nothing', bogusSel.provider, undefined);

  console.log(
    `\n${failures === 0 ? 'PASS' : 'FAIL'} — ${
      checks - failures
    }/${checks} checks passed${skipped ? `, ${skipped} skipped` : ''}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
