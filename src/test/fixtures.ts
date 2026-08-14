/**
 * Verification against the real Claude Code transcripts on this machine.
 *
 * These are invariant and differential checks rather than pinned numbers.
 * Claude Code prunes old transcripts — the corpus dropped from 25 files to 16
 * during a single working session — so any expectation hardcoded to a specific
 * session id rots. Each check below instead derives its own expectation from
 * whatever data is present, using a deliberately naive second pass over the raw
 * lines, and compares that against what the parser produced.
 *
 * Run with: npm run compile && npm run test:fixtures
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { allRecords, effectivePrompts } from '../aggregate';
import { Pricer } from '../pricing';
import { ClaudeCodeProvider } from '../providers/claudeCode';
import { FileTailer } from '../providers/tail';
import { createSessionState } from '../types';

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

let failures = 0;
let checks = 0;

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

function listTranscripts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue; // Pruned while we were walking.
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
}

/** Is this transcript a sub-agent log rather than a main session? */
function isSubagentFile(file: string): boolean {
  return path.basename(path.dirname(file)) === 'subagents';
}

interface RawStats {
  /** Distinct billing keys among non-synthetic assistant lines. */
  requestKeys: Set<string>;
  /** Billing key -> how many lines repeat it. */
  linesPerKey: Map<string, number>;
  /** Billing key -> output_tokens as written on the line. */
  outputPerKey: Map<string, number>;
  cacheSplitMismatches: number;
}

/**
 * A second, intentionally simple pass over the raw lines. It shares no code
 * with the parser, so agreement between the two is meaningful.
 */
function rawStats(lines: readonly string[]): RawStats {
  const requestKeys = new Set<string>();
  const linesPerKey = new Map<string, number>();
  const outputPerKey = new Map<string, number>();
  let cacheSplitMismatches = 0;

  for (const line of lines) {
    if (!line.startsWith('{')) {
      continue;
    }
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant') {
      continue;
    }
    const model = entry?.message?.model;
    if (typeof model !== 'string' || model === '<synthetic>') {
      continue;
    }
    const usage = entry?.message?.usage;
    if (!usage) {
      continue;
    }
    const key: string | undefined = entry.requestId ?? entry.uuid;
    if (!key) {
      continue;
    }
    requestKeys.add(key);
    linesPerKey.set(key, (linesPerKey.get(key) ?? 0) + 1);
    outputPerKey.set(key, usage.output_tokens ?? 0);

    if (usage.cache_creation) {
      const split =
        (usage.cache_creation.ephemeral_5m_input_tokens ?? 0) +
        (usage.cache_creation.ephemeral_1h_input_tokens ?? 0);
      if (split !== (usage.cache_creation_input_tokens ?? 0)) {
        cacheSplitMismatches += 1;
      }
    }
  }

  return { requestKeys, linesPerKey, outputPerKey, cacheSplitMismatches };
}

function parse(lines: readonly string[], isPrimary: boolean, label: string) {
  const provider = new ClaudeCodeProvider(PROJECTS_ROOT);
  const state = createSessionState(label);
  provider.ingest(lines, state, isPrimary);
  return state;
}

async function main(): Promise<void> {
  if (!fs.existsSync(PROJECTS_ROOT)) {
    console.error(`No transcripts at ${PROJECTS_ROOT}; nothing to verify.`);
    process.exit(1);
  }

  const files = listTranscripts(PROJECTS_ROOT);
  console.log(`\nCorpus: ${files.length} transcript(s) under ${PROJECTS_ROOT}`);
  assertTrue('at least one transcript to verify against', files.length > 0);
  if (files.length === 0) {
    process.exit(1);
  }

  console.log('\n1. Every billed request is counted exactly once');
  // The parser must emit one record per distinct request id — no duplicates
  // from multi-content-block lines, and nothing silently dropped.
  let mismatchedFiles = 0;
  let totalParsed = 0;
  let totalExpected = 0;
  let duplicatedLineFiles = 0;
  for (const file of files) {
    const lines = readLines(file);
    const raw = rawStats(lines);
    const state = parse(lines, !isSubagentFile(file), file);
    const parsed = allRecords(state);

    totalParsed += parsed.length;
    totalExpected += raw.requestKeys.size;
    if (parsed.length !== raw.requestKeys.size) {
      mismatchedFiles += 1;
      console.error(
        `        ${path.basename(file)}: parsed ${parsed.length}, expected ${raw.requestKeys.size}`,
      );
    }
    if ([...raw.linesPerKey.values()].some((n) => n > 1)) {
      duplicatedLineFiles += 1;
    }
  }
  check('files where parsed count != distinct request ids', mismatchedFiles, 0);
  check('corpus records parsed', totalParsed, totalExpected);
  assertTrue(
    'corpus actually contains multi-line responses to dedupe',
    duplicatedLineFiles > 0,
    `${duplicatedLineFiles} file(s) repeat a request id across lines`,
  );

  console.log('\n2. Dedupe regression, on whatever duplication exists now');
  // Pick a request written across the most lines and prove it bills once.
  let worst: { file: string; key: string; lines: number; output: number } | undefined;
  for (const file of files) {
    const raw = rawStats(readLines(file));
    for (const [key, count] of raw.linesPerKey) {
      if (!worst || count > worst.lines) {
        worst = { file, key, lines: count, output: raw.outputPerKey.get(key) ?? 0 };
      }
    }
  }
  if (!worst || worst.lines < 2) {
    console.error('  SKIP  no request id currently spans multiple lines');
  } else {
    const state = parse(readLines(worst.file), !isSubagentFile(worst.file), worst.file);
    const matches = allRecords(state).filter((r) => r.requestId === worst!.key);
    console.log(
      `  info  ${worst.key} written across ${worst.lines} lines in ${path.basename(worst.file)}`,
    );
    check('records emitted for it', matches.length, 1);
    check('output tokens counted once', matches[0]?.output, worst.output);
    assertTrue(
      'naive line counting would have over-billed',
      worst.lines * worst.output > worst.output,
      `${worst.lines} x ${worst.output}`,
    );
  }

  console.log('\n3. Cache-write TTL split is preserved');
  let splitMismatches = 0;
  let sum5m = 0;
  let sum1h = 0;
  let sumSplitFromLines = 0;
  for (const file of files) {
    const lines = readLines(file);
    splitMismatches += rawStats(lines).cacheSplitMismatches;
    const state = parse(lines, !isSubagentFile(file), file);
    for (const record of allRecords(state)) {
      sum5m += record.cacheWrite5m;
      sum1h += record.cacheWrite1h;
    }
    // Independent total of cache_creation_input_tokens over deduped requests.
    const seen = new Set<string>();
    for (const line of lines) {
      if (!line.startsWith('{')) {
        continue;
      }
      try {
        const entry: any = JSON.parse(line);
        if (entry?.type !== 'assistant') {
          continue;
        }
        const model = entry?.message?.model;
        if (typeof model !== 'string' || model === '<synthetic>') {
          continue;
        }
        const key = entry.requestId ?? entry.uuid;
        if (!key || seen.has(key)) {
          continue;
        }
        seen.add(key);
        sumSplitFromLines += entry?.message?.usage?.cache_creation_input_tokens ?? 0;
      } catch {
        // ignore
      }
    }
  }
  check('lines where 5m + 1h != cache_creation_input_tokens', splitMismatches, 0);
  check('parsed cache writes reconcile with raw total', sum5m + sum1h, sumSplitFromLines);
  console.log(
    `  info  cache writes 5m=${sum5m.toLocaleString()} 1h=${sum1h.toLocaleString()}` +
      ` (1h bills at 2x input, 5m at 1.25x)`,
  );

  console.log('\n4. Sub-agent turns are retained, never dropped');
  // Sub-agent files open no prompt of their own — every user line in them is a
  // sidechain. Treating that as "no bucket, discard" loses real spend, so they
  // must land in unattributedRecords instead.
  const subagentFiles = files.filter(isSubagentFile);
  const sample = subagentFiles[0] ?? files[0];
  const sampleLines = readLines(sample);
  const expected = rawStats(sampleLines).requestKeys.size;
  const asAux = parse(sampleLines, false, sample);
  console.log(
    `  info  ${subagentFiles.length} real sub-agent file(s); exercising with ` +
      `${path.basename(sample)}`,
  );
  check('auxiliary ingest opens no prompts', asAux.prompts.length, 0);
  check('all its requests are retained', asAux.unattributedRecords.length, expected);
  check('and are visible to allRecords', allRecords(asAux).length, expected);

  console.log('\n5. Timestamp attribution loses nothing');
  // Must use a main transcript: a sub-agent file has no prompts by definition,
  // so folding into it would be vacuously true.
  const primaryFile =
    files.find((f) => !isSubagentFile(f) && parse(readLines(f), true, f).prompts.length > 0) ??
    files[0];
  console.log(`  info  using ${path.basename(primaryFile)}`);
  const withPrompts = parse(readLines(primaryFile), true, primaryFile);
  // Force a mixed state: some records attributed, some not.
  withPrompts.unattributedRecords.push({
    requestId: 'synthetic-unattributed',
    timestampMs: Date.now(),
    model: 'claude-opus-5',
    input: 1,
    output: 1,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
  });
  const before = allRecords(withPrompts).length;
  const folded = effectivePrompts(withPrompts);
  const afterFold = folded.reduce((sum, p) => sum + p.records.length, 0);
  assertTrue(
    'fixture transcript has prompts to fold into',
    withPrompts.prompts.length > 0,
  );
  if (withPrompts.prompts.length === 0) {
    check('no prompts means nothing to fold into', folded.length, 0);
  } else {
    check('effectivePrompts preserves every record', afterFold, before);
    check('effectivePrompts preserves prompt count', folded.length, withPrompts.prompts.length);
    assertTrue(
      'records within a prompt are time-ordered',
      folded.every((p) =>
        p.records.every(
          (r, i) => i === 0 || p.records[i - 1].timestampMs <= r.timestampMs,
        ),
      ),
    );
  }

  console.log('\n6. Pricing arithmetic');
  const pricer = new Pricer();
  const cost = pricer.costOf({
    requestId: 'x',
    timestampMs: 0,
    model: 'claude-opus-5',
    input: 1_000_000,
    output: 1_000_000,
    cacheWrite5m: 1_000_000,
    cacheWrite1h: 1_000_000,
    cacheRead: 1_000_000,
  });
  // input 5 + output 25 + 5m 6.25 + 1h 10 + read 0.5
  check('opus-5 unit-token cost', Number(cost.toFixed(4)), 46.75);
  check('unknown model falls back, never free', pricer.rateFor('future-model').input, 5);
  check(
    'unknown model is surfaced',
    pricer.unknownModelsIn([
      {
        requestId: 'y',
        timestampMs: 0,
        model: 'future-model',
        input: 1,
        output: 1,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
      },
    ]).length,
    1,
  );
  const overridden = new Pricer({ 'claude-opus-5': { input: 1, output: 2 } });
  check('config override applies', overridden.rateFor('claude-opus-5').output, 2);

  console.log('\n7. Tailer: incremental reads and truncation recovery');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-'));
  const scratchFile = path.join(scratch, 'session.jsonl');
  try {
    fs.writeFileSync(scratchFile, '{"a":1}\n{"b":2}\n');
    const tailer = new FileTailer(scratchFile);
    check('first read line count', (await tailer.readNew()).lines.length, 2);

    // A complete line plus a partial one; only the complete line is delivered.
    fs.appendFileSync(scratchFile, '{"c":3}\n{"partial":');
    const second = await tailer.readNew();
    check('partial line withheld', second.lines.length, 1);
    check('complete line delivered', second.lines[0], '{"c":3}');

    fs.appendFileSync(scratchFile, '4}\n');
    check('completed partial delivered next', (await tailer.readNew()).lines[0], '{"partial":4}');

    // A multi-byte character split across a read boundary must survive: this is
    // why the pending fragment is held as a Buffer, not a string.
    const emoji = Buffer.from('{"e":"🎉"}\n', 'utf8');
    fs.appendFileSync(scratchFile, emoji.subarray(0, 6));
    await tailer.readNew();
    fs.appendFileSync(scratchFile, emoji.subarray(6));
    check('utf8 intact across boundary', (await tailer.readNew()).lines[0], '{"e":"🎉"}');

    fs.writeFileSync(scratchFile, '{"z":9}\n');
    const truncated = await tailer.readNew();
    check('truncation flagged', truncated.reset, true);
    check('truncation re-reads from zero', truncated.lines.length, 1);

    // A deleted file must not throw — transcripts get pruned underneath us.
    fs.rmSync(scratchFile);
    const gone = await tailer.readNew();
    check('deleted file yields no lines, no throw', gone.lines.length, 0);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  console.log('\n8. Workspace and session resolution');
  const resolver = new ClaudeCodeProvider(PROJECTS_ROOT);
  const cwds = new Set<string>();
  for (const file of files) {
    for (const line of readLines(file).slice(0, 50)) {
      if (!line.includes('"cwd"')) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.cwd === 'string') {
          cwds.add(parsed.cwd);
          break;
        }
      } catch {
        // ignore
      }
    }
  }
  assertTrue('found at least one recorded cwd to resolve', cwds.size > 0);
  const [someCwd] = [...cwds];
  if (someCwd) {
    const dir = await resolver.resolveProjectDir(someCwd);
    assertTrue(
      `recorded cwd resolves to a project dir (${someCwd})`,
      dir !== null,
      `got ${dir}`,
    );
    const session = await resolver.resolveSession(someCwd);
    assertTrue('and to an active session', session !== null);
    if (session) {
      assertTrue(
        'session primary is a transcript',
        session.primary.endsWith('.jsonl'),
        session.primary,
      );
      assertTrue(
        'session watches at least its project dir',
        session.watchDirs.length >= 1,
      );
      console.log(
        `  info  primary=${path.basename(session.primary)} ` +
          `auxiliary=${session.auxiliary.length} watchDirs=${session.watchDirs.length}`,
      );
    }
  }
  check(
    'unknown workspace resolves to no session',
    await resolver.resolveSession('/tmp/definitely-not-a-project-xyz'),
    null,
  );

  console.log(
    `\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
