// Shared between the browser (public/app.js) and the Netlify Function
// (netlify/functions/state.mts). Pure functions only: no I/O.

export const RULES = {
  "511": { label: "5-1-1", interval: 5 * 60e3, duration: 60e3, span: 60 * 60e3 },
  "411": { label: "4-1-1", interval: 4 * 60e3, duration: 60e3, span: 60 * 60e3 },
};

export const EMPTY_STATE = Object.freeze({
  version: 0,
  updatedAt: null,
  rule: "511",
  contractions: [],
});

const DAY = 24 * 60 * 60e3;
const DUPLICATE_START_WINDOW = 20e3; // two taps on "started" within 20s = same contraction

/** A quiet stretch longer than this (sleep, a lull) starts a new session. */
export const SESSION_GAP = 60 * 60e3;
/** Durations shorter than this are treated as mis-taps and left out of the stats. */
export const MIN_DURATION = 10e3;

/** The contractions since the last gap longer than SESSION_GAP, sorted by start. */
export function currentSession(contractions) {
  const list = [...contractions].sort((a, b) => a.start - b.start);
  let from = 0;
  for (let i = 1; i < list.length; i++) if (list[i].start - list[i - 1].start > SESSION_GAP) from = i;
  return list.slice(from);
}

export function isValidDuration(c) {
  return c.end != null && c.end - c.start >= MIN_DURATION;
}

function clampTime(at, now) {
  const t = Number(at);
  if (!Number.isFinite(t)) return now;
  if (t > now + 5 * 60e3) return now; // clock skew: never record the future
  if (t < now - DAY) return now - DAY;
  return Math.round(t);
}

function sortByStart(list) {
  return [...list].sort((a, b) => a.start - b.start);
}

export function openContraction(state) {
  return state.contractions.find((c) => c.end == null) || null;
}

/**
 * Apply one client operation to the shared state.
 * Returns { state, changed }. Never throws on bad input; ignores what it can't use.
 */
export function applyOp(state, op, now = Date.now()) {
  if (!op || typeof op !== "object") return { state, changed: false };
  let list = state.contractions;
  let rule = state.rule;
  let changed = false;

  switch (op.type) {
    case "start": {
      const at = clampTime(op.at, now);
      const id = typeof op.id === "string" && op.id.length <= 64 ? op.id : null;
      if (!id) break;
      if (list.some((c) => c.id === id)) break; // retry of a request we already applied
      const open = openContraction(state);
      if (open) {
        if (Math.abs(at - open.start) < DUPLICATE_START_WINDOW) break; // both partners tapped
        // Stale open contraction: close it where the new one begins.
        list = list.map((c) => (c.id === open.id ? { ...c, end: Math.max(c.start, at) } : c));
      }
      list = sortByStart([...list, { id, start: at, end: null }]);
      changed = true;
      break;
    }
    case "end": {
      const open = openContraction(state);
      if (!open) break;
      const at = Math.max(open.start, clampTime(op.at, now));
      list = list.map((c) => (c.id === open.id ? { ...c, end: at } : c));
      changed = true;
      break;
    }
    case "delete": {
      const next = list.filter((c) => c.id !== op.id);
      if (next.length !== list.length) {
        list = next;
        changed = true;
      }
      break;
    }
    case "update": {
      const idx = list.findIndex((c) => c.id === op.id);
      if (idx < 0) break;
      const cur = list[idx];
      const start = op.start == null ? cur.start : clampTime(op.start, now);
      let end = op.end === undefined ? cur.end : op.end === null ? null : clampTime(op.end, now);
      if (end != null && end < start) end = start;
      if (start === cur.start && end === cur.end) break;
      list = sortByStart(list.map((c, i) => (i === idx ? { ...c, start, end } : c)));
      changed = true;
      break;
    }
    case "clear": {
      if (list.length === 0) break;
      list = [];
      changed = true;
      break;
    }
    case "rule": {
      if (!RULES[op.rule] || op.rule === rule) break;
      rule = op.rule;
      changed = true;
      break;
    }
    default:
      break;
  }

  if (!changed) return { state, changed: false };
  return {
    changed: true,
    state: {
      version: (state.version || 0) + 1,
      updatedAt: new Date(now).toISOString(),
      rule,
      contractions: list,
    },
  };
}

export function normalizeState(raw) {
  if (!raw || typeof raw !== "object") return { ...EMPTY_STATE };
  const contractions = Array.isArray(raw.contractions)
    ? raw.contractions
        .filter((c) => c && typeof c.id === "string" && Number.isFinite(c.start))
        .map((c) => ({ id: c.id, start: c.start, end: Number.isFinite(c.end) ? c.end : null }))
    : [];
  return {
    version: Number.isFinite(raw.version) ? raw.version : 0,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    rule: RULES[raw.rule] ? raw.rule : "511",
    contractions: sortByStart(contractions),
  };
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Rolling averages and the "time to go" level.
 *
 * Levels:
 *  none    - nothing recorded
 *  lapsed  - last contraction more than 30 min ago (pattern has stopped)
 *  early   - contractions, but not yet at the rule's spacing/length
 *  forming - the last few contractions meet the rule (under 30 min so far)
 *  close   - the rule has held for 30+ minutes
 *  go      - the rule has held for the full hour: time to go
 */
export function computeStats(state, now = Date.now(), windowSize = 5) {
  const rule = RULES[state.rule] || RULES["511"];
  const everything = sortByStart(state.contractions);
  const open = everything.find((c) => c.end == null) || null;
  const last = everything[everything.length - 1] || null;
  // Averages and the streak only look at the current session, so a night's
  // sleep doesn't become a 7-hour "interval".
  const all = currentSession(everything);
  const completed = all.filter(isValidDuration);

  // Rolling average interval: start-to-start over the last `windowSize` gaps.
  const starts = all.map((c) => c.start);
  const intervals = [];
  for (let i = 1; i < starts.length; i++) intervals.push(starts[i] - starts[i - 1]);
  const avgInterval = avg(intervals.slice(-windowSize));

  // Rolling average duration over the last `windowSize` completed contractions.
  const durations = completed.map((c) => c.end - c.start);
  const avgDuration = avg(durations.slice(-windowSize));

  // Streak: longest run of recent contractions whose averages satisfy the rule.
  let streakSpan = 0;
  let streakCount = 0;
  let misses = 0;
  for (let k = 3; k <= all.length; k++) {
    const slice = all.slice(all.length - k);
    const gaps = [];
    for (let i = 1; i < slice.length; i++) gaps.push(slice[i].start - slice[i - 1].start);
    const durs = slice.filter(isValidDuration).map((c) => c.end - c.start);
    const ok =
      durs.length >= 2 && avg(gaps) <= rule.interval && avg(durs) >= rule.duration;
    if (ok) {
      streakCount = k;
      streakSpan = slice[slice.length - 1].start - slice[0].start;
      misses = 0;
    } else if (++misses >= 3) {
      break;
    }
  }

  let level = "none";
  if (last) {
    const sinceLast = now - last.start;
    if (!open && sinceLast > 30 * 60e3) level = "lapsed";
    else if (streakCount === 0) level = "early";
    else if (streakSpan >= rule.span) level = "go";
    else if (streakSpan >= rule.span / 2) level = "close";
    else level = "forming";
  }

  return {
    rule,
    count: everything.length,
    sessionCount: all.length,
    sessionStart: all.length ? all[0].start : null,
    open,
    last,
    avgInterval,
    avgDuration,
    intervalsUsed: Math.min(intervals.length, windowSize),
    durationsUsed: Math.min(durations.length, windowSize),
    streakSpan,
    streakCount,
    level,
  };
}
