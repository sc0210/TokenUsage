# Token Usage

Shows what the current AI coding session is costing, in the status bar.

```
$(graph) $0.42  ·  ↑12.4k ↓5.9k
```

- **$0.42** — cost of the active session so far
- **↑12.4k** — the last prompt's input tokens, weighted so the number tracks spend
- **↓5.9k** — the last prompt's output tokens

Hover for a full breakdown (input / output / cache writes by TTL / cache reads,
cache hit rate, per-model split, last prompt). Click for a per-prompt history.

## Where the numbers come from

Claude Code writes a JSONL transcript per session under `~/.claude/projects/`.
The extension follows the transcript for the folder you have open and adds up
the `usage` block on each API response.

Three details matter for the totals to be right:

1. **One response is written as several lines** — one per content block — each
   repeating the same usage. Requests are deduplicated by `requestId`; counting
   lines instead would inflate cost several-fold.
2. **Sub-agent turns live in separate files** (`<session>/subagents/agent-*.jsonl`)
   and are counted too. They open no prompt of their own, so they are attributed
   to the prompt that was running when they were made.
3. **Cache writes have two TTLs at different prices** — 5-minute writes bill at
   1.25× input, 1-hour writes at 2×. They are tracked separately.

There is no cost field in the transcript, so cost is computed locally from a
rate table. Unrecognised models fall back to the Opus rate and are flagged in
the tooltip rather than silently reported as free.

## Cursor

> **Cursor support relies on a private API.**
> `cursor.com/api/dashboard/*` is undocumented and unsupported. It can change or
> disappear without notice, which would break Cursor readings — Claude Code
> support is unaffected either way. Requests go only to Cursor, authenticated
> with the session Cursor itself stored; the extension never asks for, stores,
> or transmits credentials anywhere else. Nothing is sent to any third party.

Cursor reports **what it actually charged**, so nothing is estimated here: cost
comes from Cursor rather than from the rate table, which cannot know your plan,
your tier, or whether a request was later refunded.

Set `tokenUsage.provider` to `cursor`. Being signed in to Cursor is the only
setup — no hook, no config. The session token is read from Cursor's own
`state.vscdb` and used against `cursor.com/api/dashboard/get-filtered-usage-events`,
which returns one event per billed turn:

```json
{ "timestamp": "1786675265026", "model": "composer-2.5-fast",
  "tokenUsage": { "inputTokens": 52333, "outputTokens": 1665,
                  "cacheReadTokens": 74528, "totalCents": 21.9238 },
  "chargedCents": 21.9238, "conversationId": "ffa1de66-..." }
```

### Why not read it locally

The obvious approach does not work, and fails in the worst possible way:

- `~/.cursor/projects/*/agent-transcripts/*.jsonl` is conversation text only —
  no usage block, no model, no request id.
- `state.vscdb` **does** carry `tokenCount: {inputTokens, outputTokens}` on
  each assistant bubble, but Cursor stopped populating it around **September
  2025**. The field is still in the schema and every current turn writes zeros.
- `ai-code-tracking.db` counts AI-authored *lines*, not tokens.

A local reader would therefore report **$0.00 for live usage** — the one failure
mode `pricing.ts` exists to avoid.

### Details that matter

1. **Cost is authoritative.** `UsageRecord.costUSD` is set from `chargedCents`,
   and `Pricer` prefers it over the rate table. `chargedCents` is used rather
   than `tokenUsage.totalCents` so a discounted or refunded turn reads correctly,
   and an unpriced model like `composer-2.5-fast` is not flagged as an estimate
   when the real figure is known.
2. **Spend is attributed per project.** Each event carries a `conversationId`;
   `workspaceStorage/<hash>/workspace.json` names the folder a hash stands for,
   and `composerHeaders` maps conversations onto it.
3. **Prompt text comes from the local database, cost from the API.** Neither half
   is sufficient alone — the API knows what a turn cost but not what was asked,
   and the database knows the prompts but no longer records tokens. They are
   zipped in order; a surplus event stays unattributed rather than being dropped,
   so the total is never understated.
4. **No cache-write figure is reported**, so those columns read zero. This does
   not affect cost, which comes from the API rather than from cache multipliers.

This provider is polled, not tailed — there is no byte offset to resume from, so
it re-reads the window every 60s.

### Reading Cursor's SQLite

Two backends, tried in that order, because no single one covers every host:

| Backend | Available where |
|---|---|
| `node:sqlite` | Node 22+; Cursor 3.15 embeds Node 24 |
| `sqlite3` CLI | macOS and most Linux images ship it; **Windows does not** |

The built-in module is preferred, and matters most on Windows: nothing there
provides a `sqlite3` on `PATH`, so a CLI-only reader reports nothing at all on
that platform while looking identical to "no usage yet". The extension still
ships no native modules and downloads nothing — `node:sqlite` is part of the
runtime Cursor already embeds. Where it is missing the CLI is used instead, and
`Show Diagnostics` names the backend in play.

Both backends must return identical rows, so `test:sqlite` runs the same queries
through each and compares them; a divergence would otherwise surface on one
platform only. Two details make that hold: Cursor declares both key-value tables
as `BLOB` and stores JSON text in them, so the built-in backend's bytes are
decoded to text, and the CLI's row-per-line output means any column that can
contain a newline is flattened in SQL.

Bubbles are read with a **prefix range** (`key >= p AND key < p′`) rather than
`LIKE 'p%'`. `LIKE` is case-insensitive by default, so SQLite cannot use the key
index behind it and scans the whole table: on a real 958 MB `state.vscdb` that
is 767 ms per read against 5 ms for the range scan. That gap is what makes the
synchronous built-in backend safe to call at all.

## Choosing a source

Both agents can be used in the same folder — this repository is such a case — so
the extension detects which one to read rather than being told.

`tokenUsage.provider` defaults to `auto`: the source that was **most recently
active in this workspace** wins. Set it to `claude-code` or `cursor` to pin one.

### Why not detect the host editor

The `appName` API does distinguish Cursor from VS Code, and using it would be
wrong. Claude Code runs in a terminal, and that terminal is very often Cursor's
own — so "running inside Cursor" says nothing about which agent is spending.

The failure is not hypothetical: ask Cursor something in the morning, then run
Claude Code in Cursor's terminal all afternoon, and host detection reports the
morning's Cursor spend while hiding the Claude Code cost still accruing. That is
the larger number, and the one being actively spent.

Activity is probed locally for both, so no network call is needed to choose:

| Source | Signal |
|---|---|
| Claude Code | mtime of the workspace's newest transcript |
| Cursor | `MAX(lastUpdatedAt)` over the workspace's `composerHeaders` rows |

The choice is re-evaluated every 30s, and the tracker is restarted only when the
winner actually changes — restarting unconditionally would discard tail offsets
and re-read every transcript from byte zero. When a workspace has history from
both, the tooltip names the active source and lists the other with how long ago
it ran, so its spend never looks like it simply vanished.

## Budgets

Set `tokenUsage.budget.cursorUSD` or `tokenUsage.budget.claudeUSD` and the status
bar gains a `$31.50 left` segment, turning amber as each threshold passes and red
once the budget is gone. A budget is followed only for the source currently being
read, since that is the one on screen.

Two things differ from the session readout, both deliberately:

- **It counts every project on the account, not this workspace.** A budget is a
  property of the plan being paid for, so spend from everywhere counts against
  it. The workspace figure answers a different question and stays separate.
- **It stays visible between sessions.** The session readout hides itself when a
  folder has no history, because a zero there is noise. "How much have I got left
  this month" does not stop being interesting when nothing is running.

The cycle is monthly, starting on `tokenUsage.budget.cycleStartDay` in local time.
A month with no such day uses its last one, so a cycle on the 31st runs to
28 February and back out again rather than skipping the month.

Warnings fire once per threshold per cycle. What has already been announced is
stored rather than held in memory, so reloading the window does not re-announce a
threshold passed days ago, and the highest threshold reached is what is compared —
a window that was closed when 90% went by still hears about it on the next read.

### What it costs to compute

| Source | How | Cost |
|---|---|---|
| Cursor | The billing endpoint, paginated over the cycle | one round trip per page |
| Claude Code | Every transcript under the projects root | ~600ms cold over 117MB |

Neither is cheap enough to run on the session timer, so period spend refreshes
every five minutes instead of every ten seconds — a month-to-date figure does not
meaningfully move in a minute.

Pagination matters for Cursor specifically: the session readout only ever needs
the first page, but a cycle can exceed it, and stopping early would under-report
spend. Under-reporting is the one failure that makes a budget warning worthless.

The Claude Code scan is cached per file and invalidated on size and mtime, which
takes a rescan from 138ms to 3ms on this machine. Transcripts are append-only, so
a file last written before the cycle began cannot contain anything inside it and
is skipped without being opened — that keeps the walk bounded by recent activity
rather than by the size of all history ever recorded. A file that did change is
re-parsed whole rather than resumed from an offset, because deduplicating by
`requestId` needs the whole file's ids, and it is only ever the one file.

## Settings

| Setting | Default | |
|---|---|---|
| `tokenUsage.display` | `cost-and-tokens` | `cost` or `tokens` for a shorter label |
| `tokenUsage.claudeProjectsPath` | `~/.claude/projects` | Transcript root |
| `tokenUsage.pricing` | `{}` | Per-model rate overrides, USD per million tokens |
| `tokenUsage.warnThresholdUSD` | `0` | Highlight the item above this spend; 0 disables |
| `tokenUsage.statusBarPriority` | `100` | Position among status bar items |
| `tokenUsage.provider` | `auto` | Most recently active source; or pin `claude-code`/`cursor` |
| `tokenUsage.budget.cursorUSD` | `0` | Monthly Cursor budget; 0 disables |
| `tokenUsage.budget.claudeUSD` | `0` | Monthly Claude Code budget; 0 disables |
| `tokenUsage.budget.cycleStartDay` | `1` | Day of month the cycle starts |
| `tokenUsage.budget.warnAtPercent` | `[75, 90, 100]` | Warn once per cycle at each |

## Commands

- **Token Usage: Show Session Details** — per-prompt table
- **Token Usage: Refresh** — re-read the transcript from scratch
- **Token Usage: Copy Session Summary** — markdown summary to the clipboard
- **Token Usage: Select Source** — see what was detected and pin a source
- **Token Usage: Show Diagnostics** — why the item is showing what it is

### Nothing is showing

Every failure mode here is a hidden status bar item, so **Show Diagnostics** is
the first stop. It reports the editor, the workspace, both sources' last
activity, and a one-line reason from the Cursor provider — distinguishing "not
signed in", "Cursor never opened this folder", "no billed usage yet", and "the
API call failed", which otherwise all look identical.

Two things surprise people:

- **`auto` follows the newest source.** A folder used with both agents shows the
  one that ran most recently; the other is named in the tooltip. Use **Select
  Source** to pin the one you want.
- **There is no Cursor sign-in prompt.** The extension reuses the session token
  Cursor already stored. If that token is missing or expired, sign in to Cursor
  itself and reload the window — the extension never asks for credentials.

If the folder you have open has no history for the active provider, the item
hides itself rather than showing a zero.

## Development

```sh
npm install
npm run compile
npm run test:fixtures   # invariant checks against your real transcripts
npm run test:cursor-api # captured payloads + local state (add --live for the API)
npm run test:detect     # source auto-detection, incl. the both-agents case
npm run test:sqlite     # both SQLite backends, compared against each other
npm run test:budget     # billing-period calendar maths, warnings, period scan
node ./out/test/smoke.js . --watch   # live readout without an editor
```

The backend comparison needs both backends present, so it skips on a Node older
than 22. To run it against the runtime the extension actually gets, use Cursor's
own embedded Node rather than whatever `node` resolves to:

```sh
ELECTRON_RUN_AS_NODE=1 /Applications/Cursor.app/Contents/MacOS/Cursor \
  ./out/test/sqlite.js
```
