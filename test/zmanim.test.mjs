import { test } from "node:test";
import assert from "node:assert/strict";
import { countdown, fmtHM, sunset, tzeis, TARGET } from "../public/zmanim.mjs";

const ny = (d) => d.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const M = 60e3;

test("Crown Heights sunset and nightfall on the eve of 20 Cheshvan", () => {
  assert.equal(ny(sunset("2026-10-30")), "5:54 PM");
  assert.equal(ny(tzeis("2026-10-30")), "6:36 PM");
  assert.ok(tzeis("2026-10-30") - sunset("2026-10-30") > 35 * M);
});

test("solstice and equinox sanity", () => {
  assert.equal(ny(sunset("2026-06-21")), "8:30 PM");
  assert.equal(ny(sunset("2026-12-21")), "4:31 PM");
  assert.equal(ny(sunset("2026-03-20")), "7:07 PM");
});

test("countdown phases around 20 Cheshvan", () => {
  const eveSunset = sunset("2026-10-30").getTime();
  const eveTzeis = tzeis("2026-10-30").getTime();
  const dayTzeis = tzeis(TARGET.dayDate).getTime();

  let c = countdown(eveSunset - 90 * M);
  assert.equal(c.phase, "sunset");
  assert.equal(c.until, eveSunset);
  assert.equal(fmtHM(c.until - (eveSunset - 90 * M)), "1:30");

  c = countdown(eveSunset + 1);
  assert.equal(c.phase, "tzeis");
  assert.equal(c.until, eveTzeis);

  c = countdown(eveTzeis + 1);
  assert.equal(c.phase, "day");
  assert.equal(c.until, dayTzeis);

  assert.equal(countdown(dayTzeis + 1).phase, "past");
  assert.equal(countdown(Date.parse("2026-11-05T12:00:00Z")).phase, "past");
});

test("fmtHM rounds minutes up and never goes negative", () => {
  assert.equal(fmtHM(17 * 60 * M + 13 * M + 1), "17:14");
  assert.equal(fmtHM(30e3), "0:01");
  assert.equal(fmtHM(0), "0:00");
  assert.equal(fmtHM(-5000), "0:00");
});
