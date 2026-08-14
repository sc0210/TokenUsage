import { formatCost, formatTokens } from './format';
import { Totals } from './types';

export type DisplayMode = 'cost-and-tokens' | 'cost' | 'tokens';

/**
 * The status bar label. Pure, so the exact string a user sees can be asserted
 * without a running editor.
 *
 * `$(graph)` is a VS Code codicon reference, rendered as an icon in the status
 * bar and left as literal text everywhere else.
 */
export function buildStatusText(
  session: Totals,
  last: Totals | undefined,
  mode: DisplayMode,
): string {
  const cost = formatCost(session.costUSD);
  const tokens = last
    ? `↑${formatTokens(last.weightedInput)} ↓${formatTokens(last.output)}`
    : '';

  switch (mode) {
    case 'cost':
      return `$(graph) ${cost}`;
    case 'tokens':
      // Fall back to cost when there is no last prompt to describe, rather than
      // showing a bare icon.
      return tokens ? `$(graph) ${tokens}` : `$(graph) ${cost}`;
    case 'cost-and-tokens':
    default:
      return tokens ? `$(graph) ${cost}  ·  ${tokens}` : `$(graph) ${cost}`;
  }
}
