// Stylus Markup Service — backend (Bun + Hono)
//
// v2: an editor that annotates a Backdrop (rendered markdown OR an uploaded
// Source Image) and stores the result as a Markup Job that consumers pull.
//
// Responsibilities:
//   1. Serve a markdown Backdrop's raw text + its local images (DOCS_DIR, :ro).
//   2. Store/serve Markup Jobs in a separate writable JOBS_DIR (read-only
//      principle preserved — the Backdrop source is never mutated; ADR-0002/0005).
//   3. Serve the built editor frontend (single port).
//
// A Markup Job lives at JOBS_DIR/<id>/:
//   job.json            manifest (type, timestamps, tileCount, hasMd)
//   strokes.json        vector Ink Overlay (source of truth, re-editable)
//   md.txt              raw markdown (md backdrops only)
//   backdrop.png        uploaded Source Image (image backdrops only)
//   tiles/tile-1.png..  baked Markup Image slices (≤ tile long-edge)

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { resolve, join, relative, sep, dirname } from "node:path";
import { readFile, writeFile, stat, mkdir, readdir, unlink } from "node:fs/promises";

const DOCS_DIR = resolve(process.env.DOCS_DIR ?? "./docs-sample");
// Markup Jobs live in their OWN writable store — never inside DOCS_DIR. This lets
// the Backdrop mount be :ro so the tool cannot touch the author's source (ADR-0002).
const JOBS_DIR = resolve(process.env.JOBS_DIR ?? "./jobs-data");
const WEB_DIR = resolve(process.env.WEB_DIR ?? "./web/dist");
const PORT = Number(process.env.PORT ?? 8080);
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD ?? 10 * 1024 * 1024); // 10MB

const app = new Hono();

// --- path safety -----------------------------------------------------------
function safeJoin(base: string, rel: string): string | null {
  if (!rel) return null;
  const abs = resolve(base, rel);
  const within = abs === base || abs.startsWith(base + sep);
  return within ? abs : null;
}
function safeDocPath(rel: string): string | null {
  return safeJoin(DOCS_DIR, rel);
}
// Job ids are server-generated; validate strictly to keep them safe as dir names.
const JOB_ID_RE = /^[a-z0-9]{6,16}$/;
function jobDir(id: string): string | null {
  if (!JOB_ID_RE.test(id)) return null;
  return join(JOBS_DIR, id);
}
function newJobId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

// Validate an upload is really an image by magic bytes — don't trust extension.
function sniffImage(buf: Uint8Array): boolean {
  const b = buf;
  if (b.length < 12) return false;
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true;
  // WebP: "RIFF"...."WEBP"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Backdrop intake — markdown text + its local images (read-only DOCS_DIR)
// ---------------------------------------------------------------------------

// GET /api/doc?path=... — raw markdown for a markdown Backdrop opened via ?doc=.
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

// NOTE: external markdown (?src=, te-kb edit button) is fetched CLIENT-SIDE.
// te-kb serves CORS '*' so the browser fetches the raw paste directly, host-
// validated in the editor (api.kb.notscam.space) — no server proxy, so this
// backend never makes outbound requests (smaller SSRF surface). See web/src/api.ts.

// GET /static/* — serve DOCS_DIR so a markdown Backdrop's local images load.
app.get("/static/*", async (c) => {
  const rel = decodeURIComponent(c.req.path.replace(/^\/static\//, ""));
  const abs = safeDocPath(rel);
  if (!abs) return c.json({ error: "bad path" }, 400);
  try {
    if (!(await stat(abs)).isFile()) return c.json({ error: "not found" }, 404);
  } catch {
    return c.json({ error: "not found" }, 404);
  }
  return new Response(Bun.file(abs));
});

// ---------------------------------------------------------------------------
// Markup Jobs
// ---------------------------------------------------------------------------

interface JobManifest {
  id: string;
  type: "md" | "image";
  createdAt: string;
  updatedAt: string;
  tileCount: number;
  hasMd: boolean;
  backdropRef?: string; // md: original ?doc= path (to resolve local images on reopen)
  pageWidth?: number;
  pageHeight?: number;
}

function manifestToApi(m: JobManifest) {
  const base = `/api/jobs/${m.id}`;
  return {
    id: m.id,
    type: m.type,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    backdropRef: m.backdropRef ?? null,
    mdTextUrl: m.hasMd ? `${base}/md` : null,
    backdropUrl: m.type === "image" ? `${base}/backdrop` : null,
    tiles: Array.from({ length: m.tileCount }, (_, i) => `${base}/tiles/${i + 1}`),
    strokesUrl: `${base}/strokes`,
    resultUrl: `/j/${m.id}`,
  };
}

// POST /api/jobs — create or update (reopen) a Markup Job. multipart/form-data:
//   meta    (json)  { type, mdText?, jobId? (update in place), pageWidth?, pageHeight? }
//   strokes (json)  vector Ink Overlay
//   backdrop(file)  Source Image (image type only)
//   tile    (files) baked Markup Image slices, in order (repeated field)
app.post("/api/jobs", async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "expected multipart/form-data" }, 400);
  }

  let meta: {
    type?: string;
    mdText?: string;
    jobId?: string;
    backdropRef?: string;
    pageWidth?: number;
    pageHeight?: number;
  };
  try {
    meta = JSON.parse(String(form.get("meta") ?? "{}"));
  } catch {
    return c.json({ error: "bad meta json" }, 400);
  }
  const type = meta.type === "image" ? "image" : meta.type === "md" ? "md" : null;
  if (!type) return c.json({ error: "meta.type must be 'md' or 'image'" }, 400);

  // reopen-update keeps the same id (vector strokes stay editable, ADR-0003)
  let id = meta.jobId ?? "";
  if (id) {
    if (!jobDir(id)) return c.json({ error: "bad jobId" }, 400);
  } else {
    id = newJobId();
  }
  const dir = jobDir(id)!;
  await mkdir(join(dir, "tiles"), { recursive: true });

  // strokes (source of truth). Validate first.
  const strokesRaw = String(form.get("strokes") ?? "");
  try {
    JSON.parse(strokesRaw || "{}");
  } catch {
    return c.json({ error: "bad strokes json" }, 400);
  }
  // Nothing-is-Deleted: archive the previous strokes before overwriting (per pm1).
  const strokesPath = join(dir, "strokes.json");
  try {
    const prevStrokes = await readFile(strokesPath, "utf8");
    const histDir = join(dir, "strokes.history");
    await mkdir(histDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await writeFile(join(histDir, `${ts}.json`), prevStrokes, "utf8");
  } catch {
    /* no prior strokes — first save */
  }
  await writeFile(strokesPath, strokesRaw || '{"version":1,"strokes":[]}', "utf8");

  // md text (md backdrops only — never reconstructed from strokes; ADR-0001)
  const hasMd = type === "md" && typeof meta.mdText === "string";
  if (hasMd) await writeFile(join(dir, "md.txt"), meta.mdText as string, "utf8");

  // source image backdrop (image type) — validate it's really an image (magic bytes)
  if (type === "image") {
    const f = form.get("backdrop");
    if (f instanceof File) {
      if (f.size > MAX_UPLOAD) return c.json({ error: "backdrop too large" }, 413);
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (!sniffImage(bytes)) return c.json({ error: "backdrop is not a valid image" }, 415);
      await writeFile(join(dir, "backdrop.png"), bytes);
    } else if (!meta.jobId) {
      return c.json({ error: "image job requires a backdrop file" }, 400);
    }
  }

  // baked tiles — replace the previous set entirely (delete stale files first so a
  // shorter re-save doesn't leave orphans that GET /tiles/:n would still serve).
  const tilesDir = join(dir, "tiles");
  try {
    for (const name of await readdir(tilesDir)) {
      if (name.startsWith("tile-")) await unlink(join(tilesDir, name));
    }
  } catch {
    /* none yet */
  }
  const tiles = form.getAll("tile").filter((t): t is File => t instanceof File);
  let n = 0;
  for (const t of tiles) {
    if (t.size > MAX_UPLOAD) return c.json({ error: "tile too large" }, 413);
    const bytes = new Uint8Array(await t.arrayBuffer());
    if (!sniffImage(bytes)) return c.json({ error: "tile is not a valid image" }, 415);
    n += 1;
    await writeFile(join(tilesDir, `tile-${n}.png`), bytes);
  }

  const now = new Date().toISOString();
  let createdAt = now;
  try {
    const prev = JSON.parse(await readFile(join(dir, "job.json"), "utf8")) as JobManifest;
    createdAt = prev.createdAt ?? now;
  } catch {
    /* new job */
  }
  const manifest: JobManifest = {
    id,
    type,
    createdAt,
    updatedAt: now,
    tileCount: n,
    hasMd,
    backdropRef: meta.backdropRef,
    pageWidth: meta.pageWidth,
    pageHeight: meta.pageHeight,
  };
  await writeFile(join(dir, "job.json"), JSON.stringify(manifest, null, 2), "utf8");

  return c.json(manifestToApi(manifest));
});

async function loadManifest(id: string): Promise<JobManifest | null> {
  const dir = jobDir(id);
  if (!dir) return null;
  try {
    return JSON.parse(await readFile(join(dir, "job.json"), "utf8")) as JobManifest;
  } catch {
    return null;
  }
}

// GET /api/jobs/:id — manifest (the pull contract).
app.get("/api/jobs/:id", async (c) => {
  const m = await loadManifest(c.req.param("id"));
  if (!m) return c.json({ error: "not found" }, 404);
  return c.json(manifestToApi(m));
});

// GET /api/jobs/:id/md — raw markdown text (404 for image jobs).
app.get("/api/jobs/:id/md", async (c) => {
  const dir = jobDir(c.req.param("id"));
  if (!dir) return c.json({ error: "bad id" }, 400);
  try {
    return new Response(await readFile(join(dir, "md.txt")), {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  } catch {
    return c.json({ error: "no md for this job" }, 404);
  }
});

// GET /api/jobs/:id/strokes — vector Ink Overlay (reopen + edit further).
app.get("/api/jobs/:id/strokes", async (c) => {
  const dir = jobDir(c.req.param("id"));
  if (!dir) return c.json({ error: "bad id" }, 400);
  try {
    return new Response(await readFile(join(dir, "strokes.json")), {
      headers: { "content-type": "application/json" },
    });
  } catch {
    return c.json({ version: 1, strokes: [] });
  }
});

// GET /api/jobs/:id/backdrop — uploaded Source Image (image jobs).
app.get("/api/jobs/:id/backdrop", async (c) => {
  const dir = jobDir(c.req.param("id"));
  if (!dir) return c.json({ error: "bad id" }, 400);
  const file = join(dir, "backdrop.png");
  try {
    if (!(await stat(file)).isFile()) throw new Error();
  } catch {
    return c.json({ error: "no backdrop" }, 404);
  }
  return new Response(Bun.file(file));
});

// GET /api/jobs/:id/tiles/:n — one baked Tile.
app.get("/api/jobs/:id/tiles/:n", async (c) => {
  const dir = jobDir(c.req.param("id"));
  if (!dir) return c.json({ error: "bad id" }, 400);
  const n = Number(c.req.param("n"));
  if (!Number.isInteger(n) || n < 1) return c.json({ error: "bad tile" }, 400);
  const file = join(dir, "tiles", `tile-${n}.png`);
  try {
    if (!(await stat(file)).isFile()) throw new Error();
  } catch {
    return c.json({ error: "no such tile" }, 404);
  }
  return new Response(Bun.file(file));
});

// GET /j/:id — minimal human-facing "result" page (tiles + md link) to paste/host.
app.get("/j/:id", async (c) => {
  const m = await loadManifest(c.req.param("id"));
  if (!m) return c.text("job not found", 404);
  const api = manifestToApi(m);
  const tileImgs = api.tiles.map((u) => `<img src="${u}" alt="tile" />`).join("\n");
  const mdLink = api.mdTextUrl
    ? `<p>Markdown text: <a href="${api.mdTextUrl}">${api.mdTextUrl}</a></p>`
    : `<p><em>Image backdrop — no markdown text.</em></p>`;
  const html = `<!doctype html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Markup Job ${m.id}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:840px;margin:24px auto;padding:0 16px;color:#111}
img{display:block;width:100%;border:1px solid #e5e7eb;margin:8px 0;border-radius:4px}
a{color:#2563eb}code{background:#f3f4f6;padding:1px 5px;border-radius:4px}</style></head>
<body>
<h1>Markup Job <code>${m.id}</code></h1>
<p>type: <b>${m.type}</b> · tiles: <b>${m.tileCount}</b> · updated: ${m.updatedAt}</p>
${mdLink}
<p>Reopen in editor: <a href="/?job=${m.id}">/?job=${m.id}</a> · Manifest: <a href="/api/jobs/${m.id}">/api/jobs/${m.id}</a></p>
<h2>Tiles</h2>
${tileImgs || "<p>(no tiles)</p>"}
</body></html>`;
  return c.html(html);
});

// --- serve built frontend --------------------------------------------------
app.use("/assets/*", serveStatic({ root: relative(process.cwd(), WEB_DIR) || "." }));
app.get("/", serveStatic({ path: join(relative(process.cwd(), WEB_DIR) || ".", "index.html") }));
app.get("*", serveStatic({ path: join(relative(process.cwd(), WEB_DIR) || ".", "index.html") }));

await mkdir(JOBS_DIR, { recursive: true }).catch(() => {});

console.log(`stylus-markup-service serving on http://0.0.0.0:${PORT}`);
console.log(`  DOCS_DIR = ${DOCS_DIR} (read-only backdrop source)`);
console.log(`  JOBS_DIR = ${JOBS_DIR} (markup jobs)`);
console.log(`  WEB_DIR  = ${WEB_DIR}`);

export default {
  port: PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
