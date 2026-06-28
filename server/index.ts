// Stylus MD Markup — backend (Bun + Hono)
//
// Three jobs:
//   1. List the .md Documents found in the mounted DOCS_DIR (read-only source).
//   2. Serve the raw Document text + any local images it references (static mount).
//   3. Persist in-progress Annotation strokes as a Sidecar (<doc>.md.ink.json) beside
//      the Document. We NEVER write to the .md itself.
//
// The built frontend (web/dist) is served from /, so a single container + single port
// hosts the whole tool.

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { resolve, join, relative, sep, dirname } from "node:path";
import { readdir, readFile, writeFile, stat, mkdir } from "node:fs/promises";

const DOCS_DIR = resolve(process.env.DOCS_DIR ?? "./docs-sample");
const WEB_DIR = resolve(process.env.WEB_DIR ?? "./web/dist");
const PORT = Number(process.env.PORT ?? 8080);

const app = new Hono();

// --- path safety -----------------------------------------------------------
// Every client-supplied path is resolved inside DOCS_DIR and rejected if it
// escapes the mount (path traversal guard).
function safeDocPath(rel: string): string | null {
  if (!rel) return null;
  const abs = resolve(DOCS_DIR, rel);
  const within = abs === DOCS_DIR || abs.startsWith(DOCS_DIR + sep);
  return within ? abs : null;
}

// --- recursively collect .md files ----------------------------------------
async function listMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(current, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        out.push(relative(DOCS_DIR, full).split(sep).join("/"));
      }
    }
  }
  await walk(dir);
  out.sort();
  return out;
}

// GET /api/files — list of Documents (relative paths) in the mount.
app.get("/api/files", async (c) => {
  const files = await listMarkdown(DOCS_DIR);
  return c.json({ docsDir: DOCS_DIR, files });
});

// GET /api/doc?path=... — raw markdown text of one Document.
app.get("/api/doc", async (c) => {
  const rel = c.req.query("path") ?? "";
  const abs = safeDocPath(rel);
  if (!abs) return c.json({ error: "bad path" }, 400);
  try {
    const text = await readFile(abs, "utf8");
    return c.json({ path: rel, dir: dirname(rel), text });
  } catch {
    return c.json({ error: "not found" }, 404);
  }
});

// GET /api/ink?path=... — the Sidecar for a Document (strokes), or empty.
app.get("/api/ink", async (c) => {
  const rel = c.req.query("path") ?? "";
  const abs = safeDocPath(rel);
  if (!abs) return c.json({ error: "bad path" }, 400);
  const sidecar = abs + ".ink.json";
  try {
    const text = await readFile(sidecar, "utf8");
    return c.json(JSON.parse(text));
  } catch {
    return c.json({ version: 1, strokes: [] });
  }
});

// PUT /api/ink?path=... — save the Sidecar. Writes <doc>.md.ink.json, never the .md.
app.put("/api/ink", async (c) => {
  const rel = c.req.query("path") ?? "";
  const abs = safeDocPath(rel);
  if (!abs) return c.json({ error: "bad path" }, 400);
  if (!abs.toLowerCase().endsWith(".md")) {
    return c.json({ error: "ink path must target a .md document" }, 400);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad json" }, 400);
  }
  const sidecar = abs + ".ink.json";
  await mkdir(dirname(sidecar), { recursive: true });
  await writeFile(sidecar, JSON.stringify(body), "utf8");
  return c.json({ ok: true });
});

// GET /static/* — serve DOCS_DIR so local images referenced by a Document load.
app.get("/static/*", async (c) => {
  const rel = decodeURIComponent(c.req.path.replace(/^\/static\//, ""));
  const abs = safeDocPath(rel);
  if (!abs) return c.json({ error: "bad path" }, 400);
  try {
    const info = await stat(abs);
    if (!info.isFile()) return c.json({ error: "not found" }, 404);
  } catch {
    return c.json({ error: "not found" }, 404);
  }
  return new Response(Bun.file(abs));
});

// --- serve built frontend --------------------------------------------------
app.use("/assets/*", serveStatic({ root: relative(process.cwd(), WEB_DIR) || "." }));
app.get("/", serveStatic({ path: join(relative(process.cwd(), WEB_DIR) || ".", "index.html") }));
app.get("*", serveStatic({ path: join(relative(process.cwd(), WEB_DIR) || ".", "index.html") }));

console.log(`stylus-md-markup serving on http://0.0.0.0:${PORT}`);
console.log(`  DOCS_DIR = ${DOCS_DIR}`);
console.log(`  WEB_DIR  = ${WEB_DIR}`);

export default {
  port: PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
