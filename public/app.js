import { EMPTY_STATE, RULES, applyOp, computeStats, normalizeState } from "/state.mjs";

const API = "/api/state";
const POLL_MS = 3000;

const $ = (id) => document.getElementById(id);
const el = {
  sync: $("sync"), syncText: $("syncText"),
  status: $("status"), statusTitle: $("statusTitle"), statusDetail: $("statusDetail"),
  avgInterval: $("avgInterval"), avgIntervalSub: $("avgIntervalSub"),
  avgDuration: $("avgDuration"), avgDurationSub: $("avgDurationSub"),
  big: $("big"), bigLabel: $("bigLabel"), bigTimer: $("bigTimer"), bigHint: $("bigHint"),
  sinceLast: $("sinceLast"), undo: $("undo"),
  count: $("count"), list: $("list"), empty: $("empty"), clear: $("clear"), rule: $("rule"),
  dialog: $("editDialog"), form: $("editForm"), editStart: $("editStart"), editEnd: $("editEnd"), editCancel: $("editCancel"),
};

let state = { ...EMPTY_STATE };
let pending = 0;
let lastListKey = "";
let editingId = null;

// ---------- formatting ----------
const pad = (n) => String(n).padStart(2, "0");
function fmtDuration(ms) {
  if (ms == null) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
function fmtGap(ms) {
  if (ms == null) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m ${pad(s % 60)}s`;
}
function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(s % 60)}s ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}
function toLocalInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

// ---------- sync ----------
function setSync(mode, text) {
  el.sync.dataset.state = mode;
  el.syncText.textContent = text;
}

function adopt(next) {
  state = normalizeState(next);
  render();
}

async function pull() {
  if (pending > 0) return; // our own write is in flight; it returns fresh state
  try {
    const res = await fetch(`${API}?v=${state.version}`, { cache: "no-store" });
    if (res.status === 204) {
      setSync("ok", "Synced");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    adopt(await res.json());
    setSync("ok", "Synced");
  } catch (err) {
    setSync("error", "Offline, retrying…");
  }
}

async function send(op) {
  // Optimistic: apply locally right away so the button responds instantly.
  const { state: optimistic, changed } = applyOp(state, op, Date.now());
  if (!changed) return;
  state = optimistic;
  render();

  pending++;
  setSync("busy", "Saving…");
  try {
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(op),
      });
      if (res.ok) break;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
    if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
    adopt(await res.json());
    setSync("ok", "Synced");
  } catch (err) {
    setSync("error", "Couldn't save, will re-sync…");
    setTimeout(pull, 1500);
  } finally {
    pending--;
  }
}

// ---------- rendering ----------
const LEVEL_TEXT = {
  none: ["No contractions yet", "Tap the big button when one starts."],
  lapsed: ["Pattern has paused", "Over 30 minutes since the last one. Keep timing if they return."],
  early: ["Early labor", "Not yet at the {rule} pattern. Rest, hydrate, keep timing."],
  forming: ["Pattern forming", "Recent contractions fit {rule}. Keep timing to see if it holds."],
  close: ["Getting close", "{rule} has held for {span}. Get bags ready and call your provider."],
  go: ["Time to go to the hospital", "{rule} has held for {span}. Call your provider and head in."],
};

function render() {
  const now = Date.now();
  const st = computeStats(state, now);

  // Status banner
  const [title, detail] = LEVEL_TEXT[st.level] || LEVEL_TEXT.none;
  el.status.dataset.level = st.level;
  el.statusTitle.textContent = title;
  el.statusDetail.textContent = detail
    .replace("{rule}", st.rule.label)
    .replace("{span}", fmtGap(st.streakSpan).replace(/ 0?0s$/, ""));
  document.querySelector('meta[name="theme-color"]').setAttribute(
    "content",
    getComputedStyle(el.status).backgroundColor,
  );

  // Averages
  el.avgInterval.textContent = fmtGap(st.avgInterval);
  el.avgIntervalSub.textContent = st.intervalsUsed
    ? `start to start · last ${st.intervalsUsed}`
    : "start to start";
  el.avgDuration.textContent = fmtDuration(st.avgDuration);
  el.avgDurationSub.textContent = st.durationsUsed ? `last ${st.durationsUsed}` : "needs one finished";

  // Big button
  if (st.open) {
    el.big.dataset.state = "open";
    el.bigLabel.textContent = "Contraction ended";
    el.bigTimer.textContent = fmtDuration(now - st.open.start);
    el.bigHint.textContent = "Tap when it stops";
  } else {
    el.big.dataset.state = "idle";
    el.bigLabel.textContent = "Contraction started";
    el.bigTimer.textContent = "";
    el.bigHint.textContent = "Tap when one begins";
  }

  // Under the button
  if (st.last && !st.open) {
    el.sinceLast.textContent = `Last one started ${fmtAgo(now - st.last.start)}`;
  } else if (st.open && st.count > 1) {
    const prev = state.contractions[state.contractions.length - 2];
    el.sinceLast.textContent = `${fmtGap(st.open.start - prev.start)} since the previous one`;
  } else {
    el.sinceLast.textContent = "";
  }
  el.undo.hidden = st.count === 0;
  el.clear.hidden = st.count === 0;

  // Rule
  if (el.rule.value !== state.rule) el.rule.value = state.rule;

  // History (newest first). Re-render only when the list itself changes.
  el.count.textContent = st.count ? `(${st.count})` : "";
  el.empty.hidden = st.count > 0;
  const key = state.contractions.map((c) => `${c.id}:${c.start}:${c.end}`).join("|");
  if (key !== lastListKey) {
    lastListKey = key;
    el.list.replaceChildren(
      ...[...state.contractions].reverse().map((c, i, arr) => {
        const prev = arr[i + 1];
        const li = document.createElement("li");
        li.dataset.id = c.id;
        const when = document.createElement("span");
        when.className = "when";
        when.textContent = fmtClock(c.start);
        const gap = document.createElement("span");
        gap.className = "gap";
        gap.textContent = prev ? `+${fmtGap(c.start - prev.start)}` : "first";
        const dur = document.createElement("span");
        dur.className = "dur" + (c.end == null ? " open" : "");
        dur.textContent = c.end == null ? "…" : fmtDuration(c.end - c.start);
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "edit";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => openEdit(c.id));
        li.append(when, gap, dur, edit);
        return li;
      }),
    );
  }
}

// ---------- edit dialog ----------
function openEdit(id) {
  const c = state.contractions.find((x) => x.id === id);
  if (!c) return;
  editingId = id;
  el.editStart.value = toLocalInput(c.start);
  el.editEnd.value = c.end == null ? "" : toLocalInput(c.end);
  el.dialog.showModal();
}

el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const start = new Date(el.editStart.value).getTime();
  const end = el.editEnd.value ? new Date(el.editEnd.value).getTime() : null;
  if (!Number.isFinite(start)) return;
  el.dialog.close();
  send({ type: "update", id: editingId, start, end });
});
el.editCancel.addEventListener("click", () => el.dialog.close());

// Delete from inside the dialog.
const del = document.createElement("button");
del.type = "button";
del.className = "btn danger";
del.textContent = "Delete";
del.addEventListener("click", () => {
  el.dialog.close();
  send({ type: "delete", id: editingId });
});
el.form.querySelector(".dialog-actions").prepend(del);

// ---------- controls ----------
el.big.addEventListener("click", () => {
  const open = state.contractions.find((c) => c.end == null);
  if (open) send({ type: "end", at: Date.now() });
  else send({ type: "start", id: uid(), at: Date.now() });
});

el.undo.addEventListener("click", () => {
  const last = state.contractions[state.contractions.length - 1];
  if (!last) return;
  if (confirm("Remove the most recent contraction?")) send({ type: "delete", id: last.id });
});

el.clear.addEventListener("click", () => {
  if (confirm("Clear ALL contractions for both of you? This cannot be undone.")) send({ type: "clear" });
});

el.rule.addEventListener("change", () => {
  if (RULES[el.rule.value]) send({ type: "rule", rule: el.rule.value });
});

// ---------- loops ----------
setInterval(render, 250);
setInterval(pull, POLL_MS);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && pull());
window.addEventListener("focus", pull);
window.addEventListener("online", pull);
pull();
render();
