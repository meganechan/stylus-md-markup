// Client for the Markup Service backend.

export type Tool = "pen" | "highlighter" | "eraser";

export interface StrokePoint {
  x: number;
  y: number;
}

export interface Stroke {
  tool: Tool;
  color: string;
  width: number;
  points: StrokePoint[];
}

export interface InkDoc {
  version: number;
  strokes: Stroke[];
  pageWidth?: number;
  pageHeight?: number;
}

export interface DocPayload {
  path: string;
  dir: string;
  text: string;
}

export interface PasteRef {
  slug: string;
  url: string;
  publishedAt: string;
  expiresAt?: string;
}
export interface JobManifest {
  id: string;
  type: "md" | "image";
  createdAt: string;
  updatedAt: string;
  backdropRef: string | null;
  mdTextUrl: string | null;
  backdropUrl: string | null;
  tiles: string[];
  strokesUrl: string;
  resultUrl: string;
  pastes: PasteRef[];
  lastPaste: PasteRef | null;
}

// Post-back: publish a saved job to te-kb as a paste (server-side). The token
// is server-only; this just triggers it. Returns the te-kb url or a skip/error.
export interface PublishResult {
  published: boolean;
  url?: string;
  slug?: string;
  reason?: string; // e.g. "no-token"
  error?: string;
}
export async function publishJob(id: string): Promise<PublishResult> {
  const r = await fetch(`/api/jobs/${encodeURIComponent(id)}/publish`, { method: "POST" });
  const data = await r.json().catch(() => ({ published: false, error: r.statusText }));
  return data as PublishResult;
}

// Raw markdown for a Backdrop opened via ?doc=<path> (read-only DOCS_DIR).
export async function loadDoc(path: string): Promise<DocPayload> {
  const r = await fetch(`/api/doc?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error("failed to load document");
  return r.json();
}

// External markdown Backdrop (te-kb edit button → ?src=<raw-md-url>).
// Fetched CLIENT-SIDE: te-kb serves CORS '*', so the browser pulls the raw paste
// directly. Host is allowlisted here before any request (keeps the editor from
// being abused to fetch arbitrary URLs). raw=1 forces text/plain.
const ALLOWED_SRC_HOSTS = ["api.kb.notscam.space"];

export async function fetchExternalMd(rawUrl: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("URL ไม่ถูกต้อง");
  }
  if (u.protocol !== "https:") throw new Error("รับเฉพาะ https");
  if (!ALLOWED_SRC_HOSTS.includes(u.hostname)) {
    throw new Error(`host ไม่อยู่ใน allowlist: ${u.hostname}`);
  }
  if (!u.searchParams.has("raw")) u.searchParams.set("raw", "1");

  let res: Response;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    res = await fetch(u.toString(), { signal: ctrl.signal });
    clearTimeout(timer);
  } catch {
    throw new Error("ดึง paste ไม่สำเร็จ (network/timeout)");
  }
  if (res.status === 410) throw new Error("paste หมดอายุแล้ว");
  if (res.status === 404) throw new Error("ไม่พบ paste");
  if (!res.ok) throw new Error(`ดึง paste ไม่สำเร็จ (${res.status})`);
  return res.text();
}

export async function loadJob(id: string): Promise<JobManifest> {
  const r = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error("job not found");
  return r.json();
}

export async function loadJobStrokes(id: string): Promise<InkDoc> {
  const r = await fetch(`/api/jobs/${encodeURIComponent(id)}/strokes`);
  if (!r.ok) return { version: 1, strokes: [] };
  return r.json();
}

export async function loadJobMd(id: string): Promise<string> {
  const r = await fetch(`/api/jobs/${encodeURIComponent(id)}/md`);
  if (!r.ok) throw new Error("no md for job");
  return r.text();
}

export interface SaveJobInput {
  type: "md" | "image";
  jobId?: string; // update in place (reopen)
  mdText?: string;
  backdropRef?: string;
  pageWidth: number;
  pageHeight: number;
  strokes: InkDoc;
  backdrop?: Blob; // image type: the Source Image
  tiles: Blob[]; // baked Markup Image slices, in order
}

// Create or update a Markup Job (multipart). Returns the manifest.
export async function saveJob(input: SaveJobInput): Promise<JobManifest> {
  const fd = new FormData();
  fd.set(
    "meta",
    JSON.stringify({
      type: input.type,
      jobId: input.jobId,
      mdText: input.mdText,
      backdropRef: input.backdropRef,
      pageWidth: input.pageWidth,
      pageHeight: input.pageHeight,
    }),
  );
  fd.set("strokes", JSON.stringify(input.strokes));
  if (input.backdrop) fd.set("backdrop", input.backdrop, "backdrop.png");
  input.tiles.forEach((t, i) => fd.append("tile", t, `tile-${i + 1}.png`));

  const r = await fetch("/api/jobs", { method: "POST", body: fd });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(e.error ?? "save failed");
  }
  return r.json();
}
