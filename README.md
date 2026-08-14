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
it re-reads the window every 60s. Reading Cursor's SQLite uses the `sqlite3`
CLI, since the extension ships no native modules and `node:sqlite` needs Node 22.

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

## Settings

| Setting | Default | |
|---|---|---|
| `tokenUsage.display` | `cost-and-tokens` | `cost` or `tokens` for a shorter label |
| `tokenUsage.claudeProjectsPath` | `~/.claude/projects` | Transcript root |
| `tokenUsage.pricing` | `{}` | Per-model rate overrides, USD per million tokens |
| `tokenUsage.warnThresholdUSD` | `0` | Highlight the item above this spend; 0 disables |
| `tokenUsage.statusBarPriority` | `100` | Position among status bar items |
| `tokenUsage.provider` | `auto` | Most recently active source; or pin `claude-code`/`cursor` |

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
node ./out/test/smoke.js . --watch   # live readout without an editor
```
