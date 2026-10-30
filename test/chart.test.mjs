import { test } from "node:test";
import assert from "node:assert/strict";
import { fit, forecast, seriesFrom, describeForecast, trendModel } from "../public/chart.mjs";
import { RULES } from "../public/state.mjs";

const T0 = Date.parse("2026-10-30T10:00:00Z");
const M = 60e3, H = 3600e3;
const rule = RULES["511"];

function build(specs) {
  // specs: [{ at: ms offset from T0, dur: seconds }]
  return { rule: "511", contractions: specs.map((s, i) => ({ id: "c" + i, start: T0 + s.at, end: T0 + s.at + s.dur * 1000 })) };
}

test("fit recovers an exponential decay exactly", () => {
  // halves every 2 hours: rate = ln(0.5)/2 per hour
  const rate = Math.log(0.5) / 2;
  const pts = [0, 1, 2, 3].map((h) => ({ x: T0 + h * H, y: 10 * Math.exp(rate * h) }));
  const f = fit(pts);
  assert.ok(Math.abs(f.b - rate) < 1e-9);
  assert.ok(f.sigma < 1e-9);
  assert.ok(Math.abs(f.at(T0 + 2 * H) - 5) < 1e-9);
  assert.equal(fit([pts[0]]), null);
});

test("fit is robust: one wild outlier barely moves the line, and sigma is MAD-based", () => {
  const noise = [0.02, -0.03, 0.01, 0, -0.02, 0.03, -0.01];
  const pts = [0, 1, 2, 3, 4, 5, 6].map((h) => ({ x: T0 + h * H, y: 10 * Math.exp(-0.1 * h + noise[h]) }));
  pts[3] = { x: pts[3].x, y: 400 }; // a 400-minute "interval" (a night's sleep)
  const f = fit(pts);
  assert.ok(Math.abs(f.b + 0.1) < 0.03, `rate ${f.b}`);
  assert.ok(f.sigma < 0.1, `sigma ${f.sigma}`);
  assert.ok(f.bLo <= f.b && f.b <= f.bHi);
});

test("trendModel anchors at the recent level and windows the rate", () => {
  // 4 hours of 10-min intervals, then a sharp drop to 6 over the last hour.
  const pts = [];
  for (let m = 0; m <= 240; m += 10) pts.push({ x: T0 + m * M, y: 10 });
  for (let m = 246; m <= 300; m += 6) pts.push({ x: T0 + m * M, y: 6 });
  const now = T0 + 300 * M;
  const m = trendModel(pts, now);
  assert.equal(m.level, 6);
  assert.ok(m.windowStart >= now - 3 * H);
  assert.ok(m.b < 0);
  assert.ok(Math.abs(m.at(now) - 6) < 1e-9);
  assert.ok(m.crossing(5) > now);
});

test("series: intervals in minutes at the later start, durations in seconds", () => {
  const s = build([{ at: 0, dur: 30 }, { at: 10 * M, dur: 40 }]);
  const { intervals, durations } = seriesFrom(s);
  assert.deepEqual(intervals, [{ x: T0 + 10 * M, y: 10, id: "c1" }]);
  assert.equal(durations.length, 2);
  assert.equal(durations[1].y, 40);
});

test("forecast: a clean shortening trend gives a clear crossing time", () => {
  // Interval shrinks 1 min per contraction from 12m; durations already long.
  const specs = [];
  let at = 0;
  for (let i = 0; i < 6; i++) {
    specs.push({ at, dur: 70 });
    at += (12 - i) * M;
  }
  const s = build(specs);
  const now = T0 + at;
  const fc = forecast(s, rule, now);
  assert.equal(fc.status, "forecast");
  assert.equal(fc.confidence, "clear");
  assert.ok(fc.at > now && fc.at < now + 4 * H);
  assert.ok(fc.early <= fc.at && fc.at <= fc.late);
  assert.equal(fc.hospitalAt, fc.at + rule.span);
  assert.match(describeForecast(fc, rule), /At that pace/);
});

test("forecast: a noisy drift is reported with low confidence and an open-ended range", () => {
  const gaps = [10, 9, 12, 8, 11, 9, 10, 8]; // drifting down a little, but noisy
  const specs = [];
  let at = 0;
  for (let i = 0; i <= gaps.length; i++) {
    specs.push({ at, dur: 70 });
    if (i < gaps.length) at += gaps[i] * M;
  }
  const fc = forecast(build(specs), rule, T0 + at);
  assert.ok(["forecast", "no-trend"].includes(fc.status), fc.status);
  if (fc.status === "forecast") {
    assert.equal(fc.confidence, "low");
    assert.equal(fc.late, Infinity);
    assert.match(describeForecast(fc, rule), /still uncertain/);
  } else {
    assert.ok(fc.reasons.some((r) => r.why === "flat"));
    assert.match(describeForecast(fc, rule), /roughly flat/);
  }
});

test("forecast ignores earlier sessions and sub-10s mis-taps", () => {
  const specs = [{ at: -8 * H, dur: 40 }, { at: -8 * H + 5 * M, dur: 40 }, { at: -8 * H + 10 * M, dur: 40 }];
  for (let i = 0; i < 5; i++) specs.push({ at: i * 9 * M, dur: i === 2 ? 3 : 65 });
  const s = build(specs);
  const { intervals, durations, hiddenSessions, ignored } = seriesFrom(s);
  assert.equal(hiddenSessions, 3);
  assert.equal(ignored, 1);
  assert.equal(intervals.length, 4);
  assert.ok(intervals.every((p) => p.y === 9));
  assert.equal(durations.length, 4);
});

test("forecast: already at the pattern", () => {
  const specs = [];
  for (let i = 0; i < 6; i++) specs.push({ at: i * 4 * M, dur: 70 });
  const fc = forecast(build(specs), rule, T0 + 21 * M);
  assert.equal(fc.status, "met");
  assert.equal(fc.levels.interval, 4);
  assert.equal(fc.levels.duration, 70);
});

test("forecast: wrong-direction trend and too little data", () => {
  const specs = [];
  for (let i = 0; i < 5; i++) specs.push({ at: i * (8 + i) * M, dur: 30 });
  const fc = forecast(build(specs), rule, T0 + 2 * H);
  assert.equal(fc.status, "no-trend");
  assert.ok(fc.reasons.some((r) => r.label === "interval" && r.why === "wrong-way"));
  assert.equal(forecast(build(specs.slice(0, 2)), rule, T0).status, "insufficient");
});
