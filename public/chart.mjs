// Trend chart: least-squares regression, ±1σ band, and a 5-1-1 forecast.
// Math is pure; renderChart() draws inline SVG.
import { currentSession, isValidDuration } from "./state.mjs";

const MIN = 60e3;
const HOUR = 3600e3;

const median = (arr) => {
  if (!arr.length) return 0;
  const b = [...arr].sort((p, q) => p - q);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};

/**
 * Robust straight-line fit y = a + b·x over points [{x, y}], x in ms, slope per hour.
 * Theil–Sen: the slope is the median of all pairwise slopes, so a few outliers
 * (a missed tap, a lull, a 3-second mis-tap) can't drag the line. Spread is
 * 1.4826·MAD of the residuals, which plays the role of σ. The slope interval
 * [bLo, bHi] is Sen's distribution-free 90% confidence interval.
 */
export function fit(points) {
  const n = points.length;
  if (n < 2) return null;
  const x0 = points[0].x;
  const xs = points.map((p) => (p.x - x0) / HOUR);
  const ys = points.map((p) => p.y);
  const slopes = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) if (xs[j] !== xs[i]) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
  }
  if (!slopes.length) return null;
  slopes.sort((p, q) => p - q);
  const b = median(slopes);
  const a = median(ys.map((y, i) => y - b * xs[i]));
  const res = ys.map((y, i) => y - (a + b * xs[i]));
  const sigma = n > 2 ? 1.4826 * median(res.map(Math.abs)) : null;
  // Sen's 90% slope interval: ranks N/2 ± z·sqrt(var(S))/2 with z = 1.645.
  const N = slopes.length;
  const C = 1.645 * Math.sqrt((n * (n - 1) * (2 * n + 5)) / 18);
  const lo = Math.max(0, Math.floor((N - C) / 2));
  const hi = Math.min(N - 1, Math.ceil((N + C) / 2));
  const bLo = slopes[lo];
  const bHi = slopes[hi];
  const at = (t) => a + b * ((t - x0) / HOUR);
  // Where a line with slope `slope` through the fit's anchor (at `anchorT`) reaches `target`.
  const crossingWith = (target, slope, anchorT) => {
    if (!slope) return null;
    return anchorT + ((target - at(anchorT)) / slope) * HOUR;
  };
  const crossing = (target, offset = 0) => (b ? x0 + ((target - offset - a) / b) * HOUR : null);
  return { n, a, b, bLo, bHi, sigma, x0, at, crossing, crossingWith };
}

export function seriesFrom(state) {
  const list = currentSession(state.contractions);
  const intervals = [];
  for (let i = 1; i < list.length; i++) {
    intervals.push({ x: list[i].start, y: (list[i].start - list[i - 1].start) / MIN, id: list[i].id });
  }
  const durations = list.filter(isValidDuration).map((c) => ({ x: c.start, y: (c.end - c.start) / 1000, id: c.id }));
  const hiddenSessions = state.contractions.length - list.length;
  const ignored = list.filter((c) => c.end != null && !isValidDuration(c)).length;
  return { intervals, durations, session: list, hiddenSessions, ignored };
}

export const FORECAST_HORIZON = 6 * HOUR;

/**
 * When does the trend reach the rule? Interval must fall to `rule.interval`,
 * duration must rise to `rule.duration`. Returns one of:
 *  { status: "insufficient" }
 *  { status: "met" }                       both already at the target
 *  { status: "no-trend", reasons }         a series is drifting the wrong way
 *  { status: "far", at }                   right direction, but > 6h away at this pace
 *  { status: "forecast", at, early, late, hospitalAt, confidence, drift }
 *     confidence "clear" when the slope interval excludes zero; "low" when the
 *     drift is there but not yet distinguishable from flat (late = Infinity).
 */
export function forecast(state, rule, now = Date.now()) {
  const { intervals, durations } = seriesFrom(state);
  const fi = fit(intervals);
  const fd = fit(durations);
  if (!fi || !fd || intervals.length < 3 || durations.length < 3) return { status: "insufficient" };

  const parts = [];
  const reasons = [];
  const consider = (f, target, direction, label) => {
    const cur = f.at(now);
    if (direction < 0 ? cur <= target : cur >= target) return; // already there
    if (Math.sign(f.b) !== direction) {
      reasons.push(label);
      return;
    }
    const fast = direction < 0 ? f.bLo : f.bHi; // steepest plausible slope toward the target
    const slow = direction < 0 ? f.bHi : f.bLo; // shallowest
    const at = Math.max(now, f.crossingWith(target, f.b, now));
    const early = Math.max(now, f.crossingWith(target, fast, now) ?? now);
    const slowCross = Math.sign(slow) === direction ? f.crossingWith(target, slow, now) : null;
    const late = slowCross == null ? Infinity : Math.max(at, slowCross);
    parts.push({ at, early, late, label, clear: Math.sign(slow) === direction, drift: f.b });
  };
  consider(fi, rule.interval / MIN, -1, "interval");
  consider(fd, rule.duration / 1000, +1, "duration");

  if (reasons.length) return { status: "no-trend", reasons };
  if (parts.length === 0) return { status: "met" };
  const at = Math.max(...parts.map((p) => p.at));
  if (at - now > FORECAST_HORIZON) return { status: "far", at, sources: parts.map((p) => p.label) };
  let late = Math.max(...parts.map((p) => p.late));
  // A plausible-range edge beyond the horizon is as good as "unknown".
  if (late - now > FORECAST_HORIZON) late = Infinity;
  return {
    status: "forecast",
    at,
    early: Math.max(...parts.map((p) => p.early)),
    late,
    hospitalAt: at + rule.span,
    confidence: parts.every((p) => p.clear) && late !== Infinity ? "clear" : "low",
    sources: parts.map((p) => p.label),
    drift: Object.fromEntries(parts.map((p) => [p.label, p.drift])),
  };
}

// ---------- rendering ----------
const NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function niceStep(range, targetTicks, steps) {
  const raw = range / targetTicks;
  return steps.find((s) => s >= raw) ?? steps[steps.length - 1];
}

/**
 * Draw the chart into `svg`. Returns the layout so the caller can map pointer
 * positions back to points for the tooltip.
 */
export function renderChart(svg, state, rule, now = Date.now()) {
  const W = 360, H = 320;
  const L = 34, R = 12, T = 12;
  const P1 = { top: T, h: 150 };
  const P2 = { top: P1.top + P1.h + 30, h: 80 };
  const XB = P2.top + P2.h; // x-axis baseline
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.replaceChildren();

  const { intervals, durations } = seriesFrom(state);
  const fi = fit(intervals);
  const fd = fit(durations);
  const fc = forecast(state, rule, now);
  const targetI = rule.interval / MIN;
  const targetD = rule.duration / 1000;

  const allX = [...intervals, ...durations].map((p) => p.x);
  if (allX.length === 0) return null;
  let xMin = Math.min(...allX);
  let xMax = Math.max(now, ...allX);
  if (fc.status === "forecast") {
    const far = fc.late === Infinity ? fc.at + Math.max(fc.at - now, 30 * MIN) : fc.late;
    xMax = Math.max(xMax, Math.min(far, now + FORECAST_HORIZON));
  }
  const span0 = Math.max(xMax - xMin, 20 * MIN);
  xMin = xMax - span0;
  xMax += span0 * 0.06;
  xMin -= span0 * 0.04;
  const sx = (t) => L + ((t - xMin) / (xMax - xMin)) * (W - L - R);

  // Scale to the bulk of the data (90th percentile), not to a single outlier;
  // anything above is drawn as a hollow marker pinned to the top.
  const q90 = (arr) => { const b = [...arr].sort((p, q) => p - q); return b.length ? b[Math.floor((b.length - 1) * 0.9)] : 0; };
  const yMaxI = Math.max(targetI * 1.4, q90(intervals.map((p) => p.y)) * 1.15) * 1.12;
  const yMaxD = Math.max(targetD * 1.5, q90(durations.map((p) => p.y)) * 1.15) * 1.12;
  const syI = (v) => P1.top + P1.h - (Math.min(v, yMaxI) / yMaxI) * P1.h;
  const syD = (v) => P2.top + P2.h - (Math.min(v, yMaxD) / yMaxD) * P2.h;

  const g = (cls) => svg.appendChild(svgEl("g", { class: cls }));

  // Grid + axes
  const grid = g("grid");
  const stepI = niceStep(yMaxI, 4, [1, 2, 5, 10, 15, 30, 60]);
  for (let v = 0; v <= yMaxI; v += stepI) {
    grid.appendChild(svgEl("line", { x1: L, x2: W - R, y1: syI(v), y2: syI(v) }));
    grid.appendChild(svgEl("text", { x: L - 4, y: syI(v) + 3, "text-anchor": "end" }, `${v}m`));
  }
  const stepD = niceStep(yMaxD, 3, [15, 30, 60, 120, 300]);
  for (let v = 0; v <= yMaxD; v += stepD) {
    grid.appendChild(svgEl("line", { x1: L, x2: W - R, y1: syD(v), y2: syD(v) }));
    grid.appendChild(svgEl("text", { x: L - 4, y: syD(v) + 3, "text-anchor": "end" }, `${v}s`));
  }
  const stepX = niceStep((xMax - xMin) / MIN, 5, [5, 10, 15, 30, 60, 120, 180, 360]) * MIN;
  for (let t = Math.ceil(xMin / stepX) * stepX; t <= xMax; t += stepX) {
    grid.appendChild(svgEl("line", { x1: sx(t), x2: sx(t), y1: P1.top, y2: XB, class: "vgrid" }));
    grid.appendChild(svgEl("text", { x: sx(t), y: XB + 14, "text-anchor": "middle" }, clock(t)));
  }
  grid.appendChild(svgEl("text", { x: L, y: P1.top - 2, class: "panel-title" }, "Minutes between contractions"));
  grid.appendChild(svgEl("text", { x: L, y: P2.top - 4, class: "panel-title" }, "Duration (seconds)"));

  // Forecast window + now marker
  const marks = g("marks");
  if (fc.status === "forecast") {
    const e = sx(Math.min(fc.early, xMax)), l = sx(Math.min(fc.late, xMax));
    marks.appendChild(svgEl("rect", {
      x: e, y: P1.top, width: Math.max(l - e, 2), height: XB - P1.top,
      class: "fc-band" + (fc.late === Infinity ? " open-ended" : ""),
    }));
    const fx = sx(Math.min(fc.at, xMax));
    marks.appendChild(svgEl("line", { x1: fx, x2: fx, y1: P1.top, y2: XB, class: "fc-line" + (fc.confidence === "low" ? " low" : "") }));
    const tag = fc.confidence === "low" ? `${rule.label} ~${clock(fc.at)}?` : `${rule.label} ~${clock(fc.at)}`;
    marks.appendChild(svgEl("text", { x: fx, y: P1.top + 10, "text-anchor": fx > W - 70 ? "end" : "start", dx: fx > W - 70 ? -4 : 4, class: "fc-label" }, tag));
  }
  const nx = sx(now);
  marks.appendChild(svgEl("line", { x1: nx, x2: nx, y1: P1.top, y2: XB, class: "now-line" }));
  marks.appendChild(svgEl("text", { x: nx, y: XB + 24, "text-anchor": "middle", class: "now-label" }, "now"));

  // One panel: band, trend, target, points
  const panel = (points, f, target, sy, pTop, pH, labelFmt) => {
    const grp = g("panel");
    const tEnd = xMax;
    if (f) {
      const tStart = f.x0;
      if (f.sigma != null) {
        const d = [
          `M${sx(tStart)},${sy(f.at(tStart) + f.sigma)}`,
          `L${sx(tEnd)},${sy(f.at(tEnd) + f.sigma)}`,
          `L${sx(tEnd)},${sy(f.at(tEnd) - f.sigma)}`,
          `L${sx(tStart)},${sy(f.at(tStart) - f.sigma)}Z`,
        ].join("");
        grp.appendChild(svgEl("path", { d, class: "band", "clip-path": `url(#clip-${pTop})` }));
      }
      grp.appendChild(svgEl("line", {
        x1: sx(tStart), y1: sy(f.at(tStart)), x2: sx(tEnd), y2: sy(f.at(tEnd)), class: "trend", "clip-path": `url(#clip-${pTop})`,
      }));
    }
    grp.appendChild(svgEl("line", { x1: L, x2: W - R, y1: sy(target), y2: sy(target), class: "target" }));
    grp.appendChild(svgEl("text", { x: W - R, y: sy(target) - 3, "text-anchor": "end", class: "target-label" }, `target ${labelFmt(target)}`));
    if (points.length) {
      const d = points.map((p, i) => `${i ? "L" : "M"}${sx(p.x)},${sy(p.y)}`).join("");
      grp.appendChild(svgEl("path", { d, class: "series" }));
      const yMax = sy === syI ? yMaxI : yMaxD;
      for (const p of points) {
        const clipped = p.y > yMax;
        grp.appendChild(svgEl("circle", { cx: sx(p.x), cy: clipped ? sy(yMax) + 5 : sy(p.y), r: 3.5, class: clipped ? "dot clipped" : "dot" }));
      }
      const last = points[points.length - 1];
      grp.appendChild(svgEl("text", { x: sx(last.x), y: sy(last.y) - 7, "text-anchor": "middle", class: "endpoint" }, labelFmt(last.y)));
    }
  };
  const defs = svg.appendChild(svgEl("defs"));
  const grad = defs.appendChild(svgEl("linearGradient", { id: "fc-fade", x1: 0, x2: 1, y1: 0, y2: 0 }));
  grad.appendChild(svgEl("stop", { offset: "0", "stop-color": "var(--target)", "stop-opacity": 0.16 }));
  grad.appendChild(svgEl("stop", { offset: "1", "stop-color": "var(--target)", "stop-opacity": 0 }));
  for (const p of [P1, P2]) {
    const cp = defs.appendChild(svgEl("clipPath", { id: `clip-${p.top}` }));
    cp.appendChild(svgEl("rect", { x: L, y: p.top, width: W - L - R, height: p.h }));
  }
  panel(intervals, fi, targetI, syI, P1.top, P1.h, (v) => `${Math.round(v * 10) / 10}m`);
  panel(durations, fd, targetD, syD, P2.top, P2.h, (v) => `${Math.round(v)}s`);

  // Hover layer (filled in by the caller)
  const hover = g("hover");
  hover.appendChild(svgEl("line", { x1: 0, x2: 0, y1: P1.top, y2: XB, class: "crosshair", visibility: "hidden" }));

  const series = seriesFrom(state);
  return { W, H, L, R, sx, syI, syD, xMin, xMax, intervals, durations, fi, fd, fc, P1, P2, XB,
    hiddenSessions: series.hiddenSessions, ignored: series.ignored, sessionStart: series.session[0]?.start ?? null };
}

/** Human summary of the forecast for the caption under the chart. */
export function describeForecast(fc, rule) {
  const perHour = (v, unit) => `${Math.abs(v).toFixed(1)} ${unit} per hour`;
  switch (fc.status) {
    case "insufficient":
      return "Need at least 3 finished contractions in this session to fit a trend.";
    case "met":
      return `The trend is already at ${rule.label} spacing and length. The banner tracks how long it holds.`;
    case "no-trend": {
      const what = fc.reasons.map((r) => (r === "interval" ? "intervals aren't getting shorter" : "durations aren't getting longer")).join(" and ");
      return `No ${rule.label} forecast yet: ${what} on this session's trend.`;
    }
    case "far":
      return `The drift is in the right direction, but at this pace the ${rule.label} pattern is more than 6 hours away.`;
    case "forecast": {
      const drift = fc.sources
        .map((k) => (k === "interval" ? `intervals shortening about ${perHour(fc.drift.interval, "min")}` : `durations lengthening about ${perHour(fc.drift.duration, "sec")}`))
        .join(", ");
      if (fc.confidence === "low") {
        return `So far ${drift}, but the pace is still uncertain. If it holds, ${rule.label} could start around ${clock(fc.at)}, possibly much later. More contractions will sharpen this.`;
      }
      const range = fc.early !== fc.late ? ` (likely ${clock(fc.early)}–${clock(fc.late)})` : "";
      return `Clear trend: ${drift}. The ${rule.label} pattern should start around ${clock(fc.at)}${range}. An hour of that puts the hospital around ${clock(fc.hospitalAt)}.`;
    }
    default:
      return "";
  }
}
