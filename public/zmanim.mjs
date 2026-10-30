// Sunset / nightfall for a fixed location, plus the 20 Cheshvan countdown phases.
// Pure functions, no I/O. Solar times use the standard sunrise-equation
// algorithm (Almanac for Computers), accurate to about a minute.

export const CROWN_HEIGHTS = { lat: 40.6694, lon: -73.9422 };

// 20 Cheshvan 5787 falls on Saturday 2026-10-31 (daytime). The Hebrew day
// begins the evening before, at sunset on 2026-10-30.
export const TARGET = { label: "20 Cheshvan", dayDate: "2026-10-31" };

const SUNSET_ZENITH = 90.833; // geometric horizon + refraction
const TZEIS_ZENITH = 98.5; // sun 8.5° below the horizon (nightfall)

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const norm = (x, m) => ((x % m) + m) % m;

// NOAA solar position (Meeus). Returns declination (deg) and equation of time (minutes).
function solar(msUTC) {
  const T = (msUTC / 86400e3 + 2440587.5 - 2451545) / 36525;
  const L0 = norm(280.46646 + T * (36000.76983 + 0.0003032 * T), 360);
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T) +
    Math.sin(rad(3 * M)) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - 0.001813 * T))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const eot =
    4 *
    deg(
      y * Math.sin(2 * rad(L0)) -
        2 * e * Math.sin(rad(M)) +
        4 * e * y * Math.sin(rad(M)) * Math.cos(2 * rad(L0)) -
        0.5 * y * y * Math.sin(4 * rad(L0)) -
        1.25 * e * e * Math.sin(2 * rad(M)),
    );
  return { decl, eot };
}

/** Time (as a Date) at which the sun reaches `zenith` while setting on civil date "YYYY-MM-DD". */
export function sunSetting(dateStr, zenith, { lat, lon } = CROWN_HEIGHTS) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const midnight = Date.UTC(y, m - 1, d);
  // Evaluate at local solar noon, then refine once at the estimated sunset.
  let guess = midnight + (720 - 4 * lon) * 60e3;
  let result = null;
  for (let i = 0; i < 2; i++) {
    const { decl, eot } = solar(guess);
    const cosHA =
      Math.cos(rad(zenith)) / (Math.cos(rad(lat)) * Math.cos(rad(decl))) -
      Math.tan(rad(lat)) * Math.tan(rad(decl));
    if (cosHA < -1 || cosHA > 1) return null; // sun never reaches this zenith today
    const ha = deg(Math.acos(cosHA));
    const minutes = 720 - 4 * lon - eot + 4 * ha;
    result = midnight + minutes * 60e3;
    guess = result;
  }
  return new Date(result);
}

export function sunset(dateStr, loc) {
  return sunSetting(dateStr, SUNSET_ZENITH, loc);
}
export function tzeis(dateStr, loc) {
  return sunSetting(dateStr, TZEIS_ZENITH, loc);
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Countdown phase for the target Hebrew day.
 *  { phase: "sunset", until, caption }   counting down to sunset the evening before
 *  { phase: "tzeis",  until, caption }   between sunset and nightfall
 *  { phase: "day",    until, caption }   it is the target day (ends at next nightfall)
 *  { phase: "past" }                     hide the block
 */
export function countdown(now = Date.now(), target = TARGET, loc = CROWN_HEIGHTS) {
  const eve = shiftDate(target.dayDate, -1);
  const eveSunset = sunset(eve, loc).getTime();
  const eveTzeis = tzeis(eve, loc).getTime();
  const dayTzeis = tzeis(target.dayDate, loc).getTime();
  if (now < eveSunset) return { phase: "sunset", until: eveSunset, caption: `until sunset · ${target.label} begins` };
  if (now < eveTzeis) return { phase: "tzeis", until: eveTzeis, caption: `until tzeis · ${target.label}` };
  if (now < dayTzeis) return { phase: "day", until: dayTzeis, caption: `It's ${target.label}` };
  return { phase: "past" };
}

/** "H:MM" with minutes rounded up, so it reads 0:01 until the moment arrives. */
export function fmtHM(ms) {
  const mins = Math.max(0, Math.ceil(ms / 60e3));
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
}
