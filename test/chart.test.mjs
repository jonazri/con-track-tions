import { test } from "node:test";
import assert from "node:assert/strict";
import { fit, forecast, seriesFrom, describeForecast } from "../public/chart.mjs";
import { RULES } from "../public/state.mjs";

const T0 = Date.parse("2026-10-30T10:00:00Z");
const M = 60e3, H = 3600e3;
const rule = RULES["511"];

function build(specs) {
  // specs: [{ at: ms offset from T0, dur: seconds }]
  return { rule: "511", contractions: specs.map((s, i) => ({ id: "c" + i, start: T0 + s.at, end: T0 + s.at + s.dur * 1000 })) };
}

test("fit recovers a straight line with zero sigma", () => {
  const pts = [0, 1, 2, 3].map((h) => ({ x: T0 + h * H, y: 10 - 2 * h }));
  const f = fit(pts);
  assert.ok(Math.abs(f.a - 10) < 1e-9 && Math.abs(f.b + 2) < 1e-9);
  assert.ok(f.sigma < 1e-9);
  assert.ok(Math.abs(f.crossing(5) - (T0 + 2.5 * H)) < 1);
  assert.equal(fit([pts[0]]), null);
});

test("fit sigma is the residual standard deviation", () => {
  const f = fit([{ x: T0, y: 1 }, { x: T0 + H, y: 3 }, { x: T0 + 2 * H, y: 1 }, { x: T0 + 3 * H, y: 3 }]);
  assert.ok(Math.abs(f.b - 0.4) < 1e-9);
  assert.ok(Math.abs(f.sigma - Math.sqrt(3.2 / 2)) < 1e-9);
});

test("series: intervals in minutes at the later start, durations in seconds", () => {
  const s = build([{ at: 0, dur: 30 }, { at: 10 * M, dur: 40 }]);
  const { intervals, durations } = seriesFrom(s);
  assert.deepEqual(intervals, [{ x: T0 + 10 * M, y: 10, id: "c1" }]);
  assert.equal(durations.length, 2);
  assert.equal(durations[1].y, 40);
});

test("forecast: intervals shortening and durations lengthening give a crossing time", () => {
  // Interval shrinks 2 min per contraction from 12m; duration grows 8s from 30s.
  const specs = [];
  let at = 0;
  for (let i = 0; i < 5; i++) {
    specs.push({ at, dur: 30 + 8 * i });
    at += (12 - 2 * i) * M;
  }
  const s = build(specs);
  const now = T0 + at;
  const fc = forecast(s, rule, now);
  assert.equal(fc.status, "forecast");
  assert.ok(fc.at >= now);
  assert.ok(fc.early <= fc.at && fc.at <= fc.late);
  assert.equal(fc.hospitalAt, fc.at + rule.span);
  assert.match(describeForecast(fc, rule), /5-1-1 pattern starts around/);
});

test("forecast: already at the pattern", () => {
  const specs = [];
  for (let i = 0; i < 6; i++) specs.push({ at: i * 4 * M, dur: 70 });
  const fc = forecast(build(specs), rule, T0 + 21 * M);
  assert.equal(fc.status, "met");
});

test("forecast: wrong-direction trend and too little data", () => {
  const specs = [];
  for (let i = 0; i < 5; i++) specs.push({ at: i * (8 + i) * M, dur: 30 });
  const fc = forecast(build(specs), rule, T0 + 2 * H);
  assert.equal(fc.status, "no-trend");
  assert.ok(fc.reasons.includes("interval"));
  assert.equal(forecast(build(specs.slice(0, 2)), rule, T0).status, "insufficient");
});
