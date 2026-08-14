/**
 * Checks for the Cursor billing-API provider.
 *
 * The offline half runs against the payload *shape* of `get-filtered-usage-events`
 * with synthetic values, so a schema change on Cursor's side shows up here rather
 * than as a silently wrong number in the status bar.
 *
 * The local half exercises the workspace -> conversation mapping against the
 * real Cursor state on this machine, and skips itself where Cursor is absent.
 *
 * Pass --live to additionally hit the real endpoint with the signed-in token.
 *
 * Run with: npm run compile && npm run test:cursor-api
 */
import * as os from 'os';
import * as path from 'path';

import { allRecords, effectivePrompts } from '../aggregate';
import { Pricer } from '../pricing';
import {
  CursorApiProvider,
  conversationIdsFor,
  fetchUsageEvents,
  readAuth,
  __testing,
} from '../providers/cursorApi';

const { parseEvent, buildState } = __testing;

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

/**
 * The shape `get-filtered-usage-events` returns, with every value replaced by a
 * synthetic one.
 *
 * The field names, their types, and the string-encoded counters are what the
 * parser is verified against; the account id and conversation id that came with
 * the captured response identify a real account, so they are not committed.
 */
const SAMPLE_EVENT = {
  timestamp: '1700000000000',
  model: 'composer-2.5-fast',
  kind: 'USAGE_EVENT_KIND_CUSTOM_SUBSCRIPTION',
  customSubscriptionName: 'free',
  requestsCosts: 5.5,
  usageBasedCosts: '-',
  isTokenBasedCall: true,
  tokenUsage: {
    inputTokens: 50000,
    outputTokens: 2000,
    cacheReadTokens: 75000,
    totalCents: 20.5,
  },
  owningUser: '000000000',
  cursorTokenFee: 0,
  isChargeable: true,
  serviceAccountId: 'null',
  isHeadless: false,
  chargedCents: 20.5,
  conversationId: '00000000-0000-4000-8000-000000000000',
  subscriptionProductId: 'free',
};

async function main(): Promise<void> {
  console.log('\nCursor billing API provider\n');

  // ---- parsing the captured payload shape --------------------------------------------
  console.log('  parse');
  const event = parseEvent(SAMPLE_EVENT);
  assertTrue('a well-formed event parses', event !== null);
  if (event) {
    check('timestamp read from a string', event.timestampMs, 1700000000000);
    check('model', event.model, 'composer-2.5-fast');
    check('input tokens', event.input, 50000);
    check('output tokens', event.output, 2000);
    check('cache read tokens', event.cacheRead, 75000);
    check(
      'cost converted from cents to dollars',
      Math.round(event.costUSD * 1e6) / 1e6,
      Math.round((20.5 / 100) * 1e6) / 1e6,
    );
    check('conversation id', event.conversationId, SAMPLE_EVENT.conversationId);
  }

  // The API returns 64-bit counters as strings; a naive parse yields NaN.
  const stringy = parseEvent({
    ...SAMPLE_EVENT,
    tokenUsage: {
      inputTokens: '123456',
      outputTokens: '10000',
      cacheReadTokens: '700000',
      totalCents: 90.0,
    },
  });
  check('string counters are coerced', stringy?.input, 123456);
  check('and stay finite', Number.isFinite(stringy?.cacheRead ?? NaN), true);

  // chargedCents wins over totalCents, so refunds and discounts read correctly.
  const discounted = parseEvent({ ...SAMPLE_EVENT, chargedCents: 0 });
  check('a refunded turn costs nothing', discounted?.costUSD, 0);

  check('an event with no usage is dropped', parseEvent({ timestamp: '1' }), null);
  check(
    'an all-zero event is dropped',
    parseEvent({
      ...SAMPLE_EVENT,
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    }),
    null,
  );
  check('junk is dropped', parseEvent('nope'), null);

  // ---- state building ------------------------------------------------------
  console.log('\n  state');
  const second = parseEvent({
    ...SAMPLE_EVENT,
    timestamp: '1700000060000',
    chargedCents: 10,
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      totalCents: 10,
    },
  })!;
  const state = buildState('conv', [event!, second], ['first ask', 'second ask']);
  check('one bucket per prompt', state.prompts.length, 2);
  check('both events recorded', allRecords(state).length, 2);
  const prompts = effectivePrompts(state);
  check('prompt text preserved', prompts[0]?.promptText, 'first ask');
  check('each prompt owns its turn', prompts.map((p) => p.records.length).join(','), '1,1');

  // A surplus event must not be silently dropped.
  const surplus = buildState('conv', [event!, second], ['only one prompt']);
  check('surplus events are still counted', allRecords(surplus).length, 2);

  // ---- authoritative costing ----------------------------------------------
  console.log('\n  costing');
  const pricer = new Pricer();
  const totals = pricer.totalsOf(allRecords(state));
  const expected = 20.5 / 100 + 10 / 100;
  check(
    'cost comes from the API, not the rate table',
    Math.round(totals.costUSD * 1e6) / 1e6,
    Math.round(expected * 1e6) / 1e6,
  );
  assertTrue(
    'an unpriced model is not flagged when cost is authoritative',
    pricer.unknownModelsIn(allRecords(state)).length === 0,
    `flagged: ${pricer.unknownModelsIn(allRecords(state)).join(', ')}`,
  );
  assertTrue(
    'the model really is absent from the rate table',
    !pricer.isKnown('composer-2.5-fast'),
    'if this ever becomes known the test above proves nothing',
  );
  // Claude Code records carry no cost and must still be priced locally.
  const localOnly = pricer.totalsOf([
    {
      requestId: 'r',
      timestampMs: 0,
      model: 'claude-sonnet-4-5',
      input: 1000,
      output: 100,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
    },
  ]);
  check(
    'rate-table pricing still applies without a cost field',
    Math.round(localOnly.costUSD * 1e9) / 1e9,
    Math.round(((1000 * 3 + 100 * 15) / 1_000_000) * 1e9) / 1e9,
  );

  // ---- local Cursor state --------------------------------------------------
  console.log('\n  local state');
  const userDir = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Cursor',
    'User',
  );
  const auth = await readAuth(userDir);
  if (!auth) {
    skip('auth token', 'not signed in to Cursor on this machine');
  } else {
    assertTrue('a session token is readable', auth.token.length > 0);
    assertTrue('and carries a user id', auth.userId.length > 0);
    // Neither the token nor the account id is printed: this output gets pasted
    // into issues.
    console.log('  info  signed in');
  }

  const here = path.resolve(__dirname, '../..');
  const ids = await conversationIdsFor(userDir, here);
  if (ids.length === 0) {
    skip('workspace mapping', 'no Cursor conversations for this folder');
  } else {
    assertTrue(
      'this workspace maps to conversations',
      ids.length > 0,
      `${ids.length} found`,
    );
    assertTrue(
      'ids look like uuids',
      /^[0-9a-f-]{36}$/.test(ids[0]),
      ids[0],
    );
    console.log(`  info  ${ids.length} conversation(s), newest ${ids[0]}`);
  }

  check(
    'an unknown folder maps to nothing',
    (await conversationIdsFor(userDir, '/tmp/definitely-not-a-project-xyz')).length,
    0,
  );

  // ---- diagnosis -----------------------------------------------------------
  // Every failure mode here is a hidden status bar item, so the explanation is
  // the only thing standing between "not signed in" and "the extension is broken".
  console.log('\n  diagnosis');
  const unauthed = new CursorApiProvider('/nonexistent/Cursor/User');
  const noAuthReason = await unauthed.diagnose(here);
  assertTrue(
    'a missing token explains itself',
    /not signed in/i.test(noAuthReason),
    noAuthReason,
  );
  assertTrue(
    'and says no login will be prompted',
    /no login happens here/i.test(noAuthReason),
    'users otherwise wait for a sign-in flow that does not exist',
  );

  if (auth) {
    const strangerReason = await new CursorApiProvider().diagnose(
      os.tmpdir(),
    );
    assertTrue(
      'an unknown folder explains itself',
      /never opened this folder|no conversation/i.test(strangerReason),
      strangerReason,
    );
  } else {
    skip('unknown-folder diagnosis', 'not signed in');
  }

  // ---- live endpoint (opt-in) ---------------------------------------------
  console.log('\n  live');
  if (!process.argv.includes('--live')) {
    skip('live API call', 'pass --live to enable');
  } else if (!auth) {
    skip('live API call', 'no token');
  } else {
    const now = Date.now();
    const events = await fetchUsageEvents(auth, now - 90 * 86400_000, now);
    assertTrue('the endpoint answered', Array.isArray(events), `${events.length} events`);
    console.log(`  info  ${events.length} usage events in the last 90 days`);
    if (events.length > 0) {
      const totalUSD = events.reduce((sum, e) => sum + e.costUSD, 0);
      const totalIn = events.reduce((sum, e) => sum + e.input, 0);
      const totalOut = events.reduce((sum, e) => sum + e.output, 0);
      const totalCache = events.reduce((sum, e) => sum + e.cacheRead, 0);
      console.log(
        `  info  ↑${totalIn} ↓${totalOut} cache-read ${totalCache} ` +
          `= $${totalUSD.toFixed(4)}`,
      );
      assertTrue('every live event has a model', events.every((e) => e.model.length > 0));
      assertTrue('every live event has a timestamp', events.every((e) => e.timestampMs > 0));
    }

    const provider = new CursorApiProvider();
    const snap = await provider.snapshot(here);
    console.log(
      `  info  snapshot for this folder: ${
        snap ? `${allRecords(snap).length} records` : 'none'
      }`,
    );
  }

  console.log(
    `\n${failures === 0 ? 'PASS' : 'FAIL'} — ${
      checks - failures
    }/${checks} checks passed${skipped ? `, ${skipped} skipped` : ''}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
