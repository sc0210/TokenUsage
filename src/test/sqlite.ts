/**
 * Checks for the SQLite access layer.
 *
 * The point of this layer is that two different backends read the same database
 * interchangeably, so the checks that matter compare them against each other on
 * the real Cursor state: a divergence would show up on one platform only, which
 * is exactly the class of bug that motivated the CLI being replaced.
 *
 * Everything here skips itself where Cursor is absent.
 *
 * Run with: npm run compile && npm run test:sqlite
 */
import * as fsSync from 'fs';
import * as path from 'path';

import { globalStorageDir } from '../providers/cursorApi';
import {
  Row,
  describeBackend,
  prefixUpperBound,
  queryRows,
  resolveBackend,
  __testing,
} from '../providers/sqlite';

const { nodeSqlite, queryNode, queryCli } = __testing;

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

function shape(rows: readonly Row[]): string {
  return rows.map((row) => row.join('\x1f')).join('\n');
}

async function main(): Promise<void> {
  console.log('\nSQLite access layer\n');

  // ---- prefix bounds -------------------------------------------------------
  console.log('  prefix bounds');
  check('last character is bumped', prefixUpperBound('bubbleId:abc:'), 'bubbleId:abc;');
  check('an empty prefix is left alone', prefixUpperBound(''), '');
  assertTrue(
    'the bound is above every string with the prefix',
    'bubbleId:abc:zzzz' < prefixUpperBound('bubbleId:abc:'),
  );
  assertTrue(
    'and below the next unrelated key',
    prefixUpperBound('bubbleId:abc:') < 'bubbleId:abd:',
  );

  // ---- backend availability ------------------------------------------------
  console.log('\n  backend');
  const backend = await resolveBackend();
  assertTrue(
    'a backend is available on this host',
    backend !== undefined,
    'neither node:sqlite nor a sqlite3 on PATH',
  );
  if (backend) {
    console.log(`  info  using ${describeBackend(backend)}`);
  }

  const db = path.join(globalStorageDir(), 'globalStorage', 'state.vscdb');
  if (!fsSync.existsSync(db)) {
    skip('database checks', 'Cursor has no state.vscdb on this machine');
    report();
    return;
  }

  // ---- reading the real database -------------------------------------------
  console.log('\n  reading');
  const tables = await queryRows(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
  );
  assertTrue('tables are listed', tables.length > 0, `${tables.length} found`);

  const empty = await queryRows(
    db,
    "SELECT value FROM ItemTable WHERE key='no-such-key-xyz';",
  );
  check('a query matching nothing yields no rows', empty.length, 0);

  // Both key-value tables are declared BLOB and hold JSON text, so a backend
  // that returned raw bytes would break every json_extract downstream.
  const blob = await queryRows(
    db,
    "SELECT value FROM ItemTable WHERE key='cursorAuth/stripeMembershipType';",
  );
  if (blob.length === 0) {
    skip('BLOB decoding', 'not signed in to Cursor');
  } else {
    assertTrue(
      'a BLOB column decodes to text, not bytes',
      typeof blob[0][0] === 'string' && !blob[0][0].startsWith('[object'),
      JSON.stringify(blob[0][0]),
    );
  }

  // ---- the two backends must agree ----------------------------------------
  console.log('\n  backend equivalence');
  const ctor = nodeSqlite();
  let cliWorks = true;
  try {
    await queryCli(db, 'SELECT 1;');
  } catch {
    cliWorks = false;
  }

  if (!ctor || !cliWorks) {
    skip(
      'backend equivalence',
      !ctor ? 'no built-in node:sqlite here' : 'no sqlite3 CLI here',
    );
  } else {
    const conversation = (
      await queryRows(
        db,
        'SELECT composerId FROM composerHeaders ' +
          'ORDER BY COALESCE(lastUpdatedAt, createdAt) DESC LIMIT 1;',
      )
    )[0]?.[0];

    const queries: Array<[string, string]> = [
      [
        'single value',
        "SELECT value FROM ItemTable WHERE key='cursorAuth/stripeMembershipType';",
      ],
      ['no rows', "SELECT value FROM ItemTable WHERE key='nope-xyz';"],
      [
        'many rows',
        'SELECT composerId FROM composerHeaders ' +
          'ORDER BY COALESCE(lastUpdatedAt, createdAt) DESC LIMIT 25;',
      ],
      ['multiple columns', 'SELECT 1, 2, 3;'],
    ];
    if (conversation) {
      queries.push([
        'prompt text',
        `SELECT replace(replace(COALESCE(json_extract(value,'$.text'),''),char(10),' '),char(13),' ') ` +
          `FROM cursorDiskKV WHERE key >= 'bubbleId:${conversation}:' ` +
          `AND key < '${prefixUpperBound(`bubbleId:${conversation}:`)}' ` +
          `AND json_extract(value,'$.type')=1 ORDER BY rowid;`,
      ]);
    }

    for (const [name, sql] of queries) {
      const viaNode = queryNode(ctor, db, sql);
      const viaCli = await queryCli(db, sql);
      // A NULL aggregate is the one shape the two disagree on by design: the
      // CLI prints a blank line that is indistinguishable from no output. No
      // query above aggregates, so the rows must match exactly.
      assertTrue(
        `both backends agree — ${name}`,
        shape(viaNode) === shape(viaCli),
        `node: ${shape(viaNode).slice(0, 120)}\n        cli:  ${shape(viaCli).slice(0, 120)}`,
      );
    }

    // ---- the range scan must not change what is returned -------------------
    console.log('\n  range scan');
    if (!conversation) {
      skip('range scan equivalence', 'no Cursor conversations on this machine');
    } else {
      const prefix = `bubbleId:${conversation}:`;
      const viaLike = await queryRows(
        db,
        `SELECT key FROM cursorDiskKV WHERE key LIKE '${prefix}%' ORDER BY rowid;`,
      );
      const viaRange = await queryRows(
        db,
        `SELECT key FROM cursorDiskKV WHERE key >= '${prefix}' ` +
          `AND key < '${prefixUpperBound(prefix)}' ORDER BY rowid;`,
      );
      assertTrue(
        'the range scan returns exactly what LIKE returned',
        shape(viaLike) === shape(viaRange),
        `like: ${viaLike.length} rows, range: ${viaRange.length} rows`,
      );

      // The whole reason for the rewrite: LIKE cannot use the key index.
      const plan = await queryRows(
        db,
        `EXPLAIN QUERY PLAN SELECT key FROM cursorDiskKV WHERE key >= '${prefix}' ` +
          `AND key < '${prefixUpperBound(prefix)}';`,
      );
      // SQLite says "COVERING INDEX" when the index alone answers the query,
      // which depends on the columns selected rather than on the seek itself.
      const planText = plan.map((row) => row.join(' ')).join(' | ');
      assertTrue(
        'and it seeks the index instead of scanning',
        /USING\s+(COVERING\s+)?INDEX/.test(planText) && !/\bSCAN\b/.test(planText),
        planText,
      );
    }
  }

  report();
}

function report(): void {
  console.log(
    `\n${failures === 0 ? 'PASS' : 'FAIL'} — ${
      checks - failures
    }/${checks} checks passed${skipped ? `, ${skipped} skipped` : ''}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
