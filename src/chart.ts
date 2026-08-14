/**
 * Inline SVG charts, generated as strings.
 *
 * The details panel runs with scripts disabled and a `default-src 'none'` policy,
 * so there is no charting library to reach for and no canvas to draw on. That is
 * a better position than it sounds: the markup is produced by pure functions, so
 * the geometry can be asserted directly, and a chart cannot fail to appear
 * because a script did not load.
 *
 * Colours come from VS Code's chart variables, so the output follows the user's
 * theme rather than pinning light-theme colours into a dark editor.
 */

import { escapeHtml } from './format';

export interface ChartPoint {
  label: string;
  value: number;
  /** Native SVG hover text; the panel has no scripting for anything richer. */
  title?: string;
}

export interface ChartSeries {
  name: string;
  points: readonly ChartPoint[];
  colour: string;
  /** Shade the area under the line. Only sensible for a cumulative series. */
  fill?: boolean;
  dashed?: boolean;
}

export interface ChartOptions {
  width?: number;
  height?: number;
  /** Formats y-axis ticks. Defaults to a plain rounded number. */
  format?: (value: number) => string;
  /**
   * Horizontal marker, such as a mean or a budget pace.
   *
   * The label is hover text rather than print: a caption placed anywhere inside
   * the plot eventually lands on a bar. Name the line in the legend instead.
   */
  reference?: { value: number; label: string };
  /** Roughly how many x labels to print before they start colliding. */
  maxXLabels?: number;
  /** Shown in place of the chart when there is nothing to plot. */
  emptyMessage?: string;
}

export const CHART_COLOURS = {
  cost: 'var(--vscode-charts-blue, #3794ff)',
  context: 'var(--vscode-charts-purple, #b180d7)',
  output: 'var(--vscode-charts-green, #89d185)',
  warning: 'var(--vscode-charts-orange, #d18616)',
  muted: 'var(--vscode-descriptionForeground, #999)',
} as const;

/**
 * Chart dimensions are a coordinate system, not a size: the stylesheet stretches
 * the SVG to its container and the viewBox scales everything to match. This is
 * roughly the width of a full-width panel, so text lands near its nominal size.
 */
const DEFAULT_WIDTH = 980;
const DEFAULT_HEIGHT = 210;
const MARGIN = { top: 12, right: 16, bottom: 28, left: 62 };

/**
 * Axis ticks at 1, 2 or 5 times a power of ten.
 *
 * Always anchored at zero: a bar chart with a truncated axis exaggerates
 * differences, and the whole point here is judging one prompt against another.
 */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) {
    return [0, 1];
  }
  const rough = max / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const step =
    (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10) *
    magnitude;

  const ticks: number[] = [];
  // Multiply rather than accumulate, so a fractional step cannot drift.
  for (let i = 0; i * step <= max + step / 1000; i += 1) {
    ticks.push(round(i * step));
  }
  if (ticks[ticks.length - 1] < max) {
    ticks.push(round(ticks.length * step));
  }
  return ticks;
}

/** Trims the float noise that multiplying a fractional step leaves behind. */
function round(value: number): number {
  return Math.abs(value) < 1e-9 ? 0 : Number(value.toPrecision(12));
}

/**
 * A money formatter whose precision is chosen once for the whole axis.
 *
 * Formatting each tick on its own merits gives `$50.00` directly below `$100`,
 * which reads as two different kinds of number rather than one scale.
 */
export function moneyAxis(max: number): (value: number) => string {
  const decimals = (() => {
    const step = axisStep(max);
    return step >= 1 ? 0 : step >= 0.1 ? 2 : 3;
  })();
  return (value: number) =>
    `$${value.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}`;
}

/**
 * Token counts on one axis, in one unit.
 *
 * `formatTokens` switches units per value, which is right in prose and wrong on
 * an axis: it prints `500` directly below `1.0k`, so the reader has to notice
 * the unit changed halfway up.
 */
export function tokenAxis(max: number): (value: number) => string {
  const step = axisStep(max);
  const [divisor, suffix] =
    step >= 1e6 ? [1e6, 'M'] : step >= 1e3 ? [1e3, 'k'] : [1, ''];
  return (value: number) =>
    `${(value / divisor).toLocaleString('en-US', {
      maximumFractionDigits: 0,
    })}${value === 0 ? '' : suffix}`;
}

function axisStep(max: number): number {
  const ticks = niceTicks(max);
  return ticks.length > 1 ? ticks[1] : 1;
}

function defaultFormat(value: number): string {
  return String(Math.round(value));
}

/** Indices to label, thinned evenly so the first and last always appear. */
export function labelIndices(count: number, maxLabels: number): number[] {
  if (count <= 0) {
    return [];
  }
  if (count <= maxLabels) {
    return Array.from({ length: count }, (_, i) => i);
  }
  const stride = Math.ceil(count / maxLabels);
  const indices: number[] = [];
  for (let i = 0; i < count; i += stride) {
    indices.push(i);
  }
  const last = count - 1;
  if (indices[indices.length - 1] !== last) {
    // Replace rather than append whenever the last stride is short, since two
    // labels closer together than the stride are what overlap.
    if (last - indices[indices.length - 1] < stride) {
      indices[indices.length - 1] = last;
    } else {
      indices.push(last);
    }
  }
  return indices;
}

interface Frame {
  width: number;
  height: number;
  plotWidth: number;
  plotHeight: number;
  top: number;
  ticks: number[];
  y: (value: number) => number;
}

function frame(max: number, options: ChartOptions): Frame {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  return {
    width,
    height,
    plotWidth,
    plotHeight,
    top,
    ticks,
    y: (value: number) =>
      MARGIN.top + plotHeight - (Math.max(0, value) / top) * plotHeight,
  };
}

function gridAndAxis(f: Frame, format: (v: number) => string): string {
  const lines = f.ticks.map((tick) => {
    const y = f.y(tick).toFixed(1);
    return (
      `<line x1="${MARGIN.left}" y1="${y}" x2="${MARGIN.left + f.plotWidth}" y2="${y}" class="grid"/>` +
      `<text x="${MARGIN.left - 8}" y="${y}" class="tick" text-anchor="end" dominant-baseline="middle">${escapeHtml(
        format(tick),
      )}</text>`
    );
  });
  return lines.join('');
}

function xLabels(
  points: readonly ChartPoint[],
  f: Frame,
  centreOf: (index: number) => number,
  maxLabels: number,
): string {
  const y = MARGIN.top + f.plotHeight + 16;
  return labelIndices(points.length, maxLabels)
    .map((i) => {
      const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
      // Nudge the outer labels inward so they cannot overhang the plot area.
      const x =
        i === 0
          ? MARGIN.left
          : i === points.length - 1
            ? MARGIN.left + f.plotWidth
            : centreOf(i);
      return `<text x="${x.toFixed(1)}" y="${y}" class="tick" text-anchor="${anchor}">${escapeHtml(
        points[i].label,
      )}</text>`;
    })
    .join('');
}

function referenceLine(f: Frame, options: ChartOptions): string {
  const reference = options.reference;
  if (!reference || !(reference.value > 0) || reference.value > f.top) {
    return '';
  }
  const y = f.y(reference.value).toFixed(1);
  return (
    `<line x1="${MARGIN.left}" y1="${y}" x2="${MARGIN.left + f.plotWidth}" y2="${y}" class="reference">` +
    `<title>${escapeHtml(reference.label)}</title></line>`
  );
}

function empty(options: ChartOptions): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  return (
    `<svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
    `<text x="${width / 2}" y="${height / 2}" class="tick" text-anchor="middle" dominant-baseline="middle">${escapeHtml(
      options.emptyMessage ?? 'Not enough data yet',
    )}</text>` +
    `</svg>`
  );
}

function open(f: Frame, title: string): string {
  return (
    `<svg class="chart" viewBox="0 0 ${f.width} ${f.height}" width="${f.width}" height="${f.height}" ` +
    `role="img" aria-label="${escapeHtml(title)}">`
  );
}

/** Discrete values — one bar per prompt or per day. */
export function barChart(
  points: readonly ChartPoint[],
  colour: string,
  options: ChartOptions = {},
): string {
  if (points.length === 0) {
    return empty(options);
  }
  const format = options.format ?? defaultFormat;
  const max = Math.max(...points.map((p) => p.value), 0);
  const f = frame(max, options);

  const slot = f.plotWidth / points.length;
  // Bars stay legible when there are three of them and still separated when
  // there are two hundred.
  const barWidth = Math.max(1, Math.min(slot - 2, slot * 0.72));
  const centreOf = (i: number) => MARGIN.left + slot * (i + 0.5);

  const bars = points
    .map((point, i) => {
      const y = f.y(point.value);
      const height = Math.max(
        point.value > 0 ? 1 : 0,
        MARGIN.top + f.plotHeight - y,
      );
      const x = centreOf(i) - barWidth / 2;
      return (
        `<rect x="${x.toFixed(1)}" y="${(MARGIN.top + f.plotHeight - height).toFixed(1)}" ` +
        `width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}" ` +
        `fill="${colour}" class="bar">` +
        `<title>${escapeHtml(point.title ?? `${point.label}: ${format(point.value)}`)}</title>` +
        `</rect>`
      );
    })
    .join('');

  return (
    open(f, options.emptyMessage ?? 'bar chart') +
    gridAndAxis(f, format) +
    bars +
    referenceLine(f, options) +
    xLabels(points, f, centreOf, options.maxXLabels ?? 8) +
    `</svg>`
  );
}

/** One or more lines sharing an axis, for continuous or cumulative values. */
export function lineChart(
  series: readonly ChartSeries[],
  options: ChartOptions = {},
): string {
  const plotted = series.filter((s) => s.points.length > 0);
  if (plotted.length === 0) {
    return empty(options);
  }
  const format = options.format ?? defaultFormat;
  const max = Math.max(
    ...plotted.flatMap((s) => s.points.map((p) => p.value)),
    options.reference?.value ?? 0,
    0,
  );
  const f = frame(max, options);

  const count = Math.max(...plotted.map((s) => s.points.length));
  // A single point has no span, so pin it to the left edge rather than dividing
  // by zero and placing it at NaN.
  const xOf = (i: number) =>
    count <= 1 ? MARGIN.left : MARGIN.left + (f.plotWidth * i) / (count - 1);

  const paths = plotted
    .map((s) => {
      const d = s.points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${f.y(p.value).toFixed(1)}`)
        .join(' ');
      const area = s.fill
        ? `<path d="${d} L${xOf(s.points.length - 1).toFixed(1)},${(MARGIN.top + f.plotHeight).toFixed(1)} ` +
          `L${xOf(0).toFixed(1)},${(MARGIN.top + f.plotHeight).toFixed(1)} Z" fill="${s.colour}" class="area"/>`
        : '';
      const line =
        `<path d="${d}" fill="none" stroke="${s.colour}" stroke-width="2" ` +
        `stroke-linejoin="round" stroke-linecap="round"` +
        `${s.dashed ? ' stroke-dasharray="4 4"' : ''}/>`;
      // Hover targets, since a stroke is too thin to aim at.
      const dots = s.points
        .map(
          (p, i) =>
            `<circle cx="${xOf(i).toFixed(1)}" cy="${f.y(p.value).toFixed(1)}" r="7" ` +
            `fill="transparent" class="dot">` +
            `<title>${escapeHtml(p.title ?? `${p.label}: ${format(p.value)}`)}</title></circle>`,
        )
        .join('');
      return area + line + dots;
    })
    .join('');

  const longest =
    plotted.find((s) => s.points.length === count)?.points ?? plotted[0].points;

  return (
    open(f, plotted.map((s) => s.name).join(' and ')) +
    gridAndAxis(f, format) +
    paths +
    referenceLine(f, options) +
    xLabels(longest, f, xOf, options.maxXLabels ?? 8) +
    `</svg>`
  );
}

/** Styles the charts depend on. Injected once into the page's stylesheet. */
export const CHART_CSS = `
  .chart { width: 100%; height: auto; display: block; }
  .chart-pair {
    display: grid; gap: 1.5rem;
    grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr));
  }
  .chart .grid {
    stroke: var(--vscode-panel-border, rgba(128,128,128,.25));
    stroke-width: 1; shape-rendering: crispEdges;
  }
  .chart .tick {
    fill: var(--vscode-descriptionForeground);
    font-size: 11px; font-family: var(--vscode-font-family);
  }
  .chart .bar { rx: 1.5; }
  .chart .bar:hover { opacity: .75; }
  .chart .area { opacity: .14; }
  .chart .reference {
    stroke: var(--vscode-charts-orange, #d18616);
    stroke-width: 1.5; stroke-dasharray: 5 4;
  }
`;

export interface LegendItem {
  name: string;
  /** Omitted for a plain annotation, which gets no swatch. */
  colour?: string;
  dashed?: boolean;
}

/** Names each series, and carries the captions that cannot go inside the plot. */
export function legend(items: readonly LegendItem[]): string {
  return (
    `<p class="legend">` +
    items
      .map((item) => {
        const swatch = item.colour
          ? `<span class="swatch" style="background:${item.colour}${
              item.dashed ? ';opacity:.6' : ''
            }"></span>`
          : '';
        return `<span class="legend-item">${swatch}${escapeHtml(item.name)}</span>`;
      })
      .join('') +
    `</p>`
  );
}
