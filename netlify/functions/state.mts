import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";
import { EMPTY_STATE, applyOp, normalizeState } from "../../public/state.mjs";

const STORE = "contractions";
const KEY = "state";

const store = () => getStore({ name: STORE, consistency: "strong" });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

async function load() {
  const entry = await store().getWithMetadata(KEY, { type: "json" });
  if (!entry) return { state: { ...EMPTY_STATE }, etag: null as string | null };
  return { state: normalizeState(entry.data), etag: entry.etag ?? null };
}

export default async (req: Request, _context: Context) => {
  if (req.method === "GET") {
    const { state } = await load();
    const known = Number(new URL(req.url).searchParams.get("v"));
    if (Number.isFinite(known) && known === state.version && known > 0) {
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    return json(state);
  }

  if (req.method === "POST") {
    let op: unknown;
    try {
      op = await req.json();
    } catch {
      return json({ error: "Body must be JSON" }, 400);
    }

    // Two phones can write at the same moment: re-read and retry on a stale etag.
    for (let attempt = 0; attempt < 6; attempt++) {
      const { state, etag } = await load();
      const { state: next, changed } = applyOp(state, op as any, Date.now());
      if (!changed) return json(state);

      const result = await store().setJSON(
        KEY,
        next,
        etag ? { onlyIfMatch: etag } : { onlyIfNew: true },
      );
      if (result.modified) return json(next);
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
    return json({ error: "Too many concurrent updates, please retry" }, 409);
  }

  return json({ error: "Method not allowed" }, 405);
};

export const config: Config = {
  path: "/api/state",
  method: ["GET", "POST"],
};
