// Local stand-in for Netlify: serves public/ and emulates /api/state in memory.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_STATE, applyOp } from "../public/state.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
let state = { ...EMPTY_STATE };
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/state") {
    if (req.method === "GET") {
      if (Number(url.searchParams.get("v")) === state.version && state.version > 0) return res.writeHead(204).end();
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state));
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    state = applyOp(state, JSON.parse(body), Date.now()).state;
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state));
  }
  const file = path.join(root, url.pathname === "/" ? "index.html" : url.pathname);
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" }).end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
});
const port = Number(process.env.PORT) || 8788;
server.listen(port, () => console.log(`dev server on http://localhost:${port}`));
