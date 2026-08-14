# Changelog

Notable changes per release. Dates are the version's build date.

## 0.2.0 — 2026-08-14

### Added

- **Monthly budgets.** `tokenUsage.budget.cursorUSD` and
  `tokenUsage.budget.claudeUSD` put a `$31.50 left` segment in the status bar,
  amber as each threshold passes and red once the budget is gone. Spend is
  counted account-wide rather than per workspace, because a budget belongs to
  the plan being paid for. Warnings fire once per threshold per cycle and are
  remembered across window reloads.
- **Billing cycles that follow the calendar.** `tokenUsage.budget.cycleStartDay`
  sets the day the cycle starts; a month without that day uses its last one, so
  a cycle on the 31st still lands in February.
- **A charted dashboard.** The details panel now plots cumulative spend against
  an even-pace line, spend per day, cost per prompt, and context carried beside
  output produced. Charts are inline SVG generated in the extension host, so
  they work under the panel's `default-src 'none'` policy with scripts disabled.
- **A trend note.** When cost per prompt drifts up far enough to matter, the
  panel says so and explains that context accumulates as a session runs.

### Fixed

- **Cursor usage on Windows.** The provider shelled out to `sqlite3`, which
  Windows does not ship, so every query failed and the status bar item hid
  itself — indistinguishable from having no usage yet. It now prefers Node's
  built-in `node:sqlite` and keeps the CLI as a fallback.
- **Under-reported Cursor spend over a month.** The billing endpoint was read
  one page deep. A single session never needs more, but a billing cycle can
  exceed a page, so budget reads now paginate.

### Changed

- Bubble lookups use an explicit key range instead of `LIKE 'prefix%'`, which
  could not use the index. Against a real 958MB `state.vscdb` that is 767ms down
  to 5ms.

## 0.1.0

- Initial release: per-prompt token usage and cost for Claude Code and Cursor,
  in the status bar and a details panel.
