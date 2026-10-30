import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_STATE, applyOp, computeStats, normalizeState } from "../public/state.mjs";

const T0 = Date.parse("2026-10-30T10:00:00Z");
const M = 60e3;

function run(ops, now) {
  let s = { ...EMPTY_STATE };
  for (const op of ops) s = applyOp(s, op, now ?? op.at ?? Date.now()).state;
  return s;
}

test("start then end records one contraction", () => {
  const s = run([
    { type: "start", id: "a", at: T0 },
    { type: "end", at: T0 + 50e3 },
  ]);
  assert.equal(s.contractions.length, 1);
  assert.deepEqual(s.contractions[0], { id: "a", start: T0, end: T0 + 50e3 });
  assert.equal(s.version, 2);
});

test("duplicate start ids and near-simultaneous starts are ignored", () => {
  const s = run([
    { type: "start", id: "a", at: T0 },
    { type: "start", id: "a", at: T0 + 1000 },
    { type: "start", id: "b", at: T0 + 5000 },
  ]);
  assert.equal(s.contractions.length, 1);
  assert.equal(s.version, 1);
});

test("a stale open contraction is closed when a new one starts", () => {
  const s = run([
    { type: "start", id: "a", at: T0 },
    { type: "start", id: "b", at: T0 + 4 * M },
  ]);
  assert.equal(s.contractions.length, 2);
  assert.equal(s.contractions[0].end, T0 + 4 * M);
  assert.equal(s.contractions[1].end, null);
});

test("end without an open contraction is a no-op", () => {
  const { changed } = applyOp({ ...EMPTY_STATE }, { type: "end", at: T0 }, T0);
  assert.equal(changed, false);
});

test("update, delete, clear, rule", () => {
  let s = run([
    { type: "start", id: "a", at: T0 },
    { type: "end", at: T0 + 30e3 },
  ]);
  s = applyOp(s, { type: "update", id: "a", start: T0 + 5e3, end: T0 + 70e3 }, T0 + 2 * M).state;
  assert.deepEqual(s.contractions[0], { id: "a", start: T0 + 5e3, end: T0 + 70e3 });
  s = applyOp(s, { type: "update", id: "a", end: T0 }, T0 + 2 * M).state; // end before start clamps
  assert.equal(s.contractions[0].end, s.contractions[0].start);
  s = applyOp(s, { type: "rule", rule: "411" }, T0).state;
  assert.equal(s.rule, "411");
  assert.equal(applyOp(s, { type: "rule", rule: "999" }, T0).changed, false);
  s = applyOp(s, { type: "delete", id: "a" }, T0).state;
  assert.equal(s.contractions.length, 0);
  s = run([{ type: "start", id: "z", at: T0 }]);
  s = applyOp(s, { type: "clear" }, T0).state;
  assert.equal(s.contractions.length, 0);
});

test("future timestamps are clamped to now", () => {
  const s = applyOp({ ...EMPTY_STATE }, { type: "start", id: "a", at: T0 + 60 * M }, T0).state;
  assert.equal(s.contractions[0].start, T0);
});

test("normalizeState drops junk", () => {
  const s = normalizeState({ version: "x", rule: "nope", contractions: [{ id: 1 }, { id: "ok", start: 5, end: "y" }, null] });
  assert.deepEqual(s, { version: 0, updatedAt: null, rule: "511", contractions: [{ id: "ok", start: 5, end: null }] });
});

function pattern({ count, gap, dur, endAt }) {
  const list = [];
  for (let i = 0; i < count; i++) {
    const start = endAt - (count - 1 - i) * gap;
    list.push({ id: "c" + i, start, end: start + dur });
  }
  return { ...EMPTY_STATE, contractions: list };
}

test("stats: rolling averages use the last 5", () => {
  const s = pattern({ count: 8, gap: 6 * M, dur: 45e3, endAt: T0 });
  const st = computeStats(s, T0 + M);
  assert.equal(st.avgInterval, 6 * M);
  assert.equal(st.avgDuration, 45e3);
  assert.equal(st.intervalsUsed, 5);
  assert.equal(st.level, "early");
});

test("stats: 5-1-1 held for an hour => go", () => {
  const s = pattern({ count: 13, gap: 5 * M, dur: 65e3, endAt: T0 }); // spans 60 min
  assert.equal(computeStats(s, T0 + M).level, "go");
  const half = pattern({ count: 7, gap: 5 * M, dur: 65e3, endAt: T0 }); // spans 30 min
  assert.equal(computeStats(half, T0 + M).level, "close");
  const few = pattern({ count: 3, gap: 5 * M, dur: 65e3, endAt: T0 });
  assert.equal(computeStats(few, T0 + M).level, "forming");
});

test("stats: 4-1-1 rule is stricter", () => {
  const s = { ...pattern({ count: 13, gap: 5 * M, dur: 65e3, endAt: T0 }), rule: "411" };
  assert.equal(computeStats(s, T0 + M).level, "early");
  const s4 = { ...pattern({ count: 16, gap: 4 * M, dur: 65e3, endAt: T0 }), rule: "411" };
  assert.equal(computeStats(s4, T0 + M).level, "go");
});

test("stats: lapsed after 30 quiet minutes, none when empty", () => {
  const s = pattern({ count: 13, gap: 5 * M, dur: 65e3, endAt: T0 });
  assert.equal(computeStats(s, T0 + 31 * M).level, "lapsed");
  assert.equal(computeStats({ ...EMPTY_STATE }, T0).level, "none");
});

test("stats: an open contraction counts toward intervals but not durations", () => {
  const s = pattern({ count: 4, gap: 5 * M, dur: 65e3, endAt: T0 });
  s.contractions.push({ id: "open", start: T0 + 5 * M, end: null });
  const st = computeStats(s, T0 + 5 * M + 10e3);
  assert.equal(st.open.id, "open");
  assert.equal(st.intervalsUsed, 4);
  assert.equal(st.durationsUsed, 4);
});
