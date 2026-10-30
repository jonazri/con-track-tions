// Trend chart: least-squares regression, ±1σ band, and a 5-1-1 forecast.
// Math is pure; renderChart() draws inline SVG.

const MIN = 60e3;
const HOUR = 3600e3;

/** Least-squares fit y = a + b·x over points [{x, y}], x in ms. Slope is per hour. */
export function fit(points) {
  const n = points.length;
  if (n < 2) return null;
  const x0 = points[0].x;
  const xs = points.map((p) => (p.x - x0) / HOUR);
  const ys = points.map((p) => p.y);
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  const a = my - b * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - (a + b * xs[i])) ** 2;
  const sigma = n > 2 ? Math.sqrt(sse / (n - 2)) : null;
  const at = (t) => a + b * ((t - x0) / HOUR);
  // Time at which the line (shifted by `offset`) reaches `target`, or null if it never will.
  const crossing = (target, offset = 0) => {
    if (b === 0) return null;
    return x0 + ((target - offset - a) / b) * HOUR;
  };
  return { n, a, b, sigma, x0, at, crossing };
}

export function seriesFrom(state) {
  const list = [...state.contractions].sort((p, q) => p.start - q.start);
  const intervals = [];
  for (let i = 1; i < list.length; i++) {
    intervals.push({ x: list[i].start, y: (list[i].start - list[i - 1].start) / MIN, id: list[i].id });
  }
  const durations = list
    .filter((c) => c.end != null)
    .map((c) => ({ x: c.start, y: (c.end - c.start) / 1000, id: c.id }));
  return { intervals, durations };
}

/**
 * When does the trend reach the rule? Interval must fall to `rule.interval`,
 * duration must rise to `rule.duration`. Returns one of:
 *  { status: "insufficient" }
 *  { status: "met" }                      both already at the target
 *  { status: "no-trend", reasons: [...] } a series is moving the wrong way
 *  { status: "forecast", at, early, late, hospitalAt, sources }
 */
export function forecast(state, rule, now = Date.now()) {
  const { intervals, durations } = seriesFrom(state);
  const fi = fit(intervals);
  const fd = fit(durations);
  if (!fi || !fd || intervals.length < 3 || durations.length < 3) return { status: "insufficient" };

  const targetI = rule.interval / MIN;
  const targetD = rule.duration / 1000;
  const parts = [];
  const reasons = [];

  const consider = (f, target, direction, label) => {
    const cur = f.at(now);
    const met = direction < 0 ? cur <= target : cur >= target;
    if (met) return;
    if (Math.sign(f.b) !== direction) {
      reasons.push(label);
      return;
    }
    const s = f.sigma ?? 0;
    // The band edge closer to the target crosses first.
    const t = f.crossing(target);
    const e = f.crossing(target, direction < 0 ? -s : s);
    const l = f.crossing(target, direction < 0 ? s : -s);
    parts.push({ at: Math.max(t, now), early: Math.max(e, now), late: Math.max(l, now), label });
  };
  consider(fi, targetI, -1, "interval");
  consider(fd, targetD, +1, "duration");

  if (reasons.length) return { status: "no-trend", reasons };
  if (parts.length === 0) return { status: "met" };
  const at = Math.max(...parts.map((p) => p.at));
  return {
    status: "forecast",
    at,
    early: Math.max(...parts.map((p) => p.early)),
    late: Math.max(...parts.map((p) => p.late)),
    hospitalAt: at + rule.span,
    sources: parts.map((p) => p.label),
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
  if (fc.status === "forecast") xMax = Math.max(xMax, Math.min(fc.late, now + 6 * HOUR));
  const span0 = Math.max(xMax - xMin, 20 * MIN);
  xMin = xMax - span0;
  xMax += span0 * 0.06;
  xMin -= span0 * 0.04;
  const sx = (t) => L + ((t - xMin) / (xMax - xMin)) * (W - L - R);

  const yMaxI = Math.max(targetI * 1.4, ...intervals.map((p) => p.y)) * 1.12;
  const yMaxD = Math.max(targetD * 1.5, ...durations.map((p) => p.y)) * 1.12;
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
    marks.appendChild(svgEl("rect", { x: e, y: P1.top, width: Math.max(l - e, 2), height: XB - P1.top, class: "fc-band" }));
    const fx = sx(Math.min(fc.at, xMax));
    marks.appendChild(svgEl("line", { x1: fx, x2: fx, y1: P1.top, y2: XB, class: "fc-line" }));
    marks.appendChild(svgEl("text", { x: fx, y: P1.top + 10, "text-anchor": fx > W - 70 ? "end" : "start", dx: fx > W - 70 ? -4 : 4, class: "fc-label" },
      `${rule.label} ~${clock(fc.at)}`));
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
      for (const p of points) grp.appendChild(svgEl("circle", { cx: sx(p.x), cy: sy(p.y), r: 3.5, class: "dot" }));
      const last = points[points.length - 1];
      grp.appendChild(svgEl("text", { x: sx(last.x), y: sy(last.y) - 7, "text-anchor": "middle", class: "endpoint" }, labelFmt(last.y)));
    }
  };
  const defs = svg.appendChild(svgEl("defs"));
  for (const p of [P1, P2]) {
    const cp = defs.appendChild(svgEl("clipPath", { id: `clip-${p.top}` }));
    cp.appendChild(svgEl("rect", { x: L, y: p.top, width: W - L - R, height: p.h }));
  }
  panel(intervals, fi, targetI, syI, P1.top, P1.h, (v) => `${Math.round(v * 10) / 10}m`);
  panel(durations, fd, targetD, syD, P2.top, P2.h, (v) => `${Math.round(v)}s`);

  // Hover layer (filled in by the caller)
  const hover = g("hover");
  hover.appendChild(svgEl("line", { x1: 0, x2: 0, y1: P1.top, y2: XB, class: "crosshair", visibility: "hidden" }));

  return { W, H, L, R, sx, syI, syD, xMin, xMax, intervals, durations, fi, fd, fc, P1, P2, XB };
}

/** Human summary of the forecast for the caption under the chart. */
export function describeForecast(fc, rule) {
  switch (fc.status) {
    case "insufficient":
      return "Need at least 3 finished contractions to fit a trend.";
    case "met":
      return `The trend is already at ${rule.label} spacing and length. The banner tracks how long it holds.`;
    case "no-trend": {
      const what = fc.reasons.map((r) => (r === "interval" ? "intervals aren't shortening" : "durations aren't lengthening")).join(" and ");
      return `No ${rule.label} forecast yet: ${what} on the current trend.`;
    }
    case "forecast": {
      const range = fc.early !== fc.late ? ` (±1σ: ${clock(fc.early)}–${clock(fc.late)})` : "";
      return `At this trend the ${rule.label} pattern starts around ${clock(fc.at)}${range}. An hour of that puts the hospital around ${clock(fc.hospitalAt)}.`;
    }
    default:
      return "";
  }
}
