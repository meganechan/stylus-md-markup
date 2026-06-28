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
import type { Context } from "hono";
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

// Post-back to te-kb (ADR-0006). The write token lives ONLY here (server env),
// never in the frontend. If unset, publishing is skipped silently.
const TEKB_PASTE_TOKEN = process.env.TEKB_PASTE_TOKEN ?? "";
const TEKB_BASE_URL = (process.env.TEKB_BASE_URL ?? "https://api.kb.notscam.space").replace(/\/$/, "");
// Public origin of THIS service, used to build absolute tile/edit URLs in the paste.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? "https://ink.notscam.space").replace(/\/$/, "");
// TTL for published pastes (te-kb contract: explicit, clamped [1,2160]). Markup is
// a review artifact we want to keep ~30d. Tunable via env without rebuild.
const POSTBACK_TTL_HOURS = Number(process.env.POSTBACK_TTL_HOURS ?? 720);
// te-kb paste content cap (contract): 1MB. We guard before sending.
const PASTE_CONTENT_CAP = 1024 * 1024;
// Save KB appends a ref into the source paste. "once" = one ref per job (skip
// re-append on repeat saves — the ref links to /j/id which already shows latest
// tiles). "always" = append every save (visible edit history). Tunable via env.
const POSTBACK_APPEND_MODE = process.env.POSTBACK_APPEND_MODE === "always" ? "always" : "once";

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

interface PasteRef {
  slug: string;
  url: string;
  publishedAt: string;
  expiresAt?: string;
}
interface AppendRef {
  slug: string; // source paste slug we appended a ref into
  url: string; // source paste url
  appendedAt: string;
  expiresAt?: string; // te-kb extends TTL on append
}
interface JobManifest {
  id: string;
  type: "md" | "image";
  createdAt: string;
  updatedAt: string;
  tileCount: number;
  hasMd: boolean;
  backdropRef?: string; // md: original ?doc= path or ?src= url (resolve images / source slug)
  pageWidth?: number;
  pageHeight?: number;
  pastes?: PasteRef[]; // new pastes created (fallback path) — appended (Nothing-is-Deleted)
  appendedTo?: AppendRef; // the source paste this job's ref was appended into (1-ref-per-job)
  appends?: AppendRef[]; // full append history (Nothing-is-Deleted)
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
    pastes: m.pastes ?? [],
    lastPaste: m.pastes && m.pastes.length ? m.pastes[m.pastes.length - 1] : null,
    appendedTo: m.appendedTo ?? null, // source paste this job's ref lives in (if any)
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

// Count strokes in a job's overlay (for the "N marks" label in the paste).
async function countStrokes(dir: string): Promise<number> {
  try {
    const s = JSON.parse(await readFile(join(dir, "strokes.json"), "utf8"));
    return Array.isArray(s.strokes) ? s.strokes.length : 0;
  } catch {
    return 0;
  }
}
function firstHeading(md: string): string | null {
  const m = md.match(/^#{1,6}\s+(.+)$/m);
  return m ? m[1].trim().slice(0, 120) : null;
}

// Build the markdown body of the te-kb paste from a job (md text + Tiles + edit link).
function buildPasteMarkdown(m: JobManifest, mdText: string | null, strokeCount: number): string {
  const tileUrls = Array.from(
    { length: m.tileCount },
    (_, i) => `${PUBLIC_BASE_URL}/api/jobs/${m.id}/tiles/${i + 1}`,
  );
  const tilesMd = tileUrls.map((u) => `![](${u})`).join("\n\n");
  const editLink = `[ดู/แก้ต่อใน Stylus](${PUBLIC_BASE_URL}/?job=${m.id})`;
  const markHeader = `✍️ Markup (${strokeCount} รอยมาร์ก)`;
  if (m.hasMd && mdText !== null) {
    return `${mdText}\n\n---\n\n${markHeader}\n\n${tilesMd}\n\n${editLink}\n`;
  }
  return `# ${markHeader}\n\n${tilesMd}\n\n${editLink}\n`;
}

// Authenticated POST to te-kb (Bearer token + 10s timeout).
function tekbPost(url: string, body: unknown): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TEKB_PASTE_TOKEN}` },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer));
}

// Extract the source paste slug from a job's backdropRef, iff it is a te-kb
// paste URL (https://api.kb.notscam.space/p/<slug>). Query (?raw=1) is ignored.
function extractTekbSlug(ref?: string): string | null {
  if (!ref) return null;
  try {
    const u = new URL(ref);
    if (u.hostname !== "api.kb.notscam.space") return null;
    const m = u.pathname.match(/^\/p\/([A-Za-z0-9]{8,32})$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Format a UTC ISO timestamp as Asia/Bangkok (UTC+7) "YYYY-MM-DD HH:mm".
function fmtBangkok(iso: string): string {
  try {
    return new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" }).slice(0, 16);
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

// The ref block appended into the source paste: dated link to view (/j/id, tiles)
// and edit (/?job=id, strokes).
function buildRefBlock(m: JobManifest): string {
  const view = `${PUBLIC_BASE_URL}/j/${m.id}`;
  const edit = `${PUBLIC_BASE_URL}/?job=${m.id}`;
  return `\n\n---\n✏️ Markup (${fmtBangkok(m.createdAt)}): [ดู](${view}) · [แก้ไข](${edit})`;
}

// Fallback path (no source paste, or source expired): create a NEW te-kb paste
// with the full markup content. Returns the Hono response.
async function createNewPaste(c: Context, m: JobManifest, dir: string, id: string) {
  const strokeCount = await countStrokes(dir);
  let mdText: string | null = null;
  if (m.hasMd) {
    try {
      mdText = await readFile(join(dir, "md.txt"), "utf8");
    } catch {
      mdText = null;
    }
  }
  const content = buildPasteMarkdown(m, mdText, strokeCount);
  if (Buffer.byteLength(content, "utf8") > PASTE_CONTENT_CAP) {
    return c.json({ published: false, error: "content exceeds te-kb 1MB cap" }, 413);
  }
  const title = ((mdText && firstHeading(mdText)) || `Stylus Markup ${id}`).slice(0, 200);
  let res: Response;
  try {
    res = await tekbPost(`${TEKB_BASE_URL}/paste`, { content, title, ttl_hours: POSTBACK_TTL_HOURS });
  } catch (e) {
    return c.json({ published: false, error: "te-kb unreachable: " + (e as Error).message }, 502);
  }
  if (!res.ok) return c.json({ published: false, error: `te-kb responded ${res.status}` }, 502);
  const data = (await res.json().catch(() => ({}))) as {
    slug?: string;
    url?: string;
    expires_at?: string;
  };
  const url = data.url ?? (data.slug ? `${TEKB_BASE_URL}/p/${data.slug}` : null);
  if (!url) return c.json({ published: false, error: "te-kb response missing url/slug" }, 502);
  const ref: PasteRef = {
    slug: data.slug ?? "",
    url,
    publishedAt: new Date().toISOString(),
    expiresAt: data.expires_at,
  };
  m.pastes = [...(m.pastes ?? []), ref];
  await writeFile(join(dir, "job.json"), JSON.stringify(m, null, 2), "utf8");
  console.log(`published(new) job ${id} -> ${url}`);
  return c.json({ published: true, mode: "new", url, slug: ref.slug, expiresAt: data.expires_at });
}

// POST /api/jobs/:id/publish — Save KB post-back (ADR-0006). Append a dated ref
// into the SOURCE paste (slug from ?src) so the markup shows under the original;
// fall back to creating a new paste when there is no source (image/local) or the
// source paste has expired. Server-side only — the token never reaches the browser.
//   - no token            -> { published:false, reason:"no-token" } (200)
//   - te-kb failure        -> { published:false, error } (502); the local job is intact
app.post("/api/jobs/:id/publish", async (c) => {
  const id = c.req.param("id");
  const m = await loadManifest(id);
  if (!m) return c.json({ error: "not found" }, 404);
  const dir = jobDir(id)!;

  if (!TEKB_PASTE_TOKEN) return c.json({ published: false, reason: "no-token" });

  const sourceSlug = extractTekbSlug(m.backdropRef);

  // No source paste (image upload / local ?doc) → create a new paste.
  if (!sourceSlug) return createNewPaste(c, m, dir, id);

  // 1-ref-per-job: if this job already appended to this source, skip — the ref
  // points to /j/id which already serves the latest tiles. (Flip via env to
  // "always" for visible edit history.)
  if (POSTBACK_APPEND_MODE === "once" && m.appendedTo?.slug === sourceSlug) {
    return c.json({ published: true, mode: "append", url: m.appendedTo.url, slug: sourceSlug, skipped: true });
  }

  const refBlock = buildRefBlock(m);
  let res: Response;
  try {
    res = await tekbPost(`${TEKB_BASE_URL}/paste/${sourceSlug}/append`, { content: refBlock });
  } catch (e) {
    return c.json({ published: false, error: "te-kb unreachable: " + (e as Error).message }, 502);
  }
  // source paste gone/expired → fall back to a fresh paste (append-only API 404s)
  if (res.status === 404) return createNewPaste(c, m, dir, id);
  if (!res.ok) return c.json({ published: false, error: `te-kb append responded ${res.status}` }, 502);

  // 200 { slug, url, expires_at, images } — prefer te-kb's own url (contract)
  const data = (await res.json().catch(() => ({}))) as { url?: string; expires_at?: string };
  const pasteUrl = data.url ?? `${TEKB_BASE_URL}/p/${sourceSlug}`;
  const ref: AppendRef = {
    slug: sourceSlug,
    url: pasteUrl,
    appendedAt: new Date().toISOString(),
    expiresAt: data.expires_at,
  };
  m.appendedTo = ref;
  m.appends = [...(m.appends ?? []), ref]; // history (Nothing-is-Deleted)
  await writeFile(join(dir, "job.json"), JSON.stringify(m, null, 2), "utf8");
  console.log(`appended job ${id} ref -> ${pasteUrl} (slug ${sourceSlug})`);
  return c.json({ published: true, mode: "append", url: pasteUrl, slug: sourceSlug, expiresAt: data.expires_at });
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
console.log(
  `  post-back = ${TEKB_PASTE_TOKEN ? "ON" : "OFF (no TEKB_PASTE_TOKEN — publish skipped)"}` +
    ` → ${TEKB_BASE_URL} · public ${PUBLIC_BASE_URL} · append=${POSTBACK_APPEND_MODE} · ttl=${POSTBACK_TTL_HOURS}h`,
);

export default {
  port: PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
