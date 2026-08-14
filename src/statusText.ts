import { BudgetReading } from './budget';
import { formatCost, formatTokens } from './format';
import { Totals } from './types';

export type DisplayMode = 'cost-and-tokens' | 'cost' | 'tokens';

/** The budget half of the label: what is left, or by how much it was passed. */
export function buildBudgetSuffix(reading: BudgetReading): string {
  return reading.overUSD > 0
    ? `${formatCost(reading.overUSD)} over`
    : `${formatCost(reading.remainingUSD)} left`;
}

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
  budget?: BudgetReading,
): string {
  const cost = formatCost(session.costUSD);
  const tokens = last
    ? `↑${formatTokens(last.weightedInput)} ↓${formatTokens(last.output)}`
    : '';

  const parts: string[] = [];
  switch (mode) {
    case 'cost':
      parts.push(cost);
      break;
    case 'tokens':
      // Fall back to cost when there is no last prompt to describe, rather than
      // showing a bare icon.
      parts.push(tokens || cost);
      break;
    case 'cost-and-tokens':
    default:
      parts.push(cost);
      if (tokens) {
        parts.push(tokens);
      }
      break;
  }
  if (budget) {
    parts.push(buildBudgetSuffix(budget));
  }
  return `$(graph) ${parts.join('  ·  ')}`;
}

/**
 * The label when a budget is set but no session is running.
 *
 * A budget is the one figure worth showing with nothing in flight — it is the
 * question "how much have I got left this month", which does not stop being
 * interesting between sessions.
 */
export function buildBudgetOnlyText(reading: BudgetReading): string {
  return `$(graph) ${formatCost(reading.spentUSD)}  ·  ${buildBudgetSuffix(reading)}`;
}
