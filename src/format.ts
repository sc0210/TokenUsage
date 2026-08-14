/** Compact token count: exact under 1k, then `12.4k`, then `1.2M`. */
export function formatTokens(n: number): string {
  const value = Math.round(n);
  if (value < 1_000) {
    return String(value);
  }
  if (value < 1_000_000) {
    const k = value / 1_000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = value / 1_000_000;
  return `${m < 10 ? m.toFixed(2) : m.toFixed(1)}M`;
}

/** Never render `$0.00` for spend that actually happened. */
export function formatCost(usd: number): string {
  if (usd <= 0) {
    return '$0.00';
  }
  if (usd < 0.01) {
    return '<$0.01';
  }
  if (usd < 100) {
    return `$${usd.toFixed(2)}`;
  }
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

/** Full precision, for the details table where the exact figure matters. */
export function formatCostPrecise(usd: number): string {
  if (usd === 0) {
    return '$0.0000';
  }
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) {
    return '0s';
  }
  const totalSeconds = Math.floor(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function formatClock(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Single-line prompt excerpt for tables and tooltips. */
export function excerpt(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}

/** Escape markdown-table-hostile characters in untrusted prompt text. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|<>])/g, '\\$1');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
