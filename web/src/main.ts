import "github-markdown-css/github-markdown-light.css";
import "highlight.js/styles/github.css";
import "./style.css";

import { loadDoc, fetchExternalMd, loadJob, loadJobStrokes, loadJobMd, saveJob, publishJob } from "./api";
import type { JobManifest } from "./api";
import { renderMarkdown } from "./markdown";
import { AnnotationEngine } from "./annotation";
import { Viewport } from "./viewport";
import { bakeTiles, exportMarkupImage, downloadBlob } from "./exporter";

// --- elements --------------------------------------------------------------
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const previewEl = $<HTMLElement>("#preview");
const inkCanvas = $<HTMLCanvasElement>("#ink");
const pageEl = $<HTMLElement>("#page");
const viewportEl = $<HTMLElement>("#viewport");
const toolbarEl = $<HTMLElement>("#toolbar");
const intakeEl = $<HTMLElement>("#intake");
const imageInput = $<HTMLInputElement>("#image-input");
const resultBanner = $<HTMLElement>("#result-banner");
const resultText = $<HTMLElement>("#result-text");

const engine = new AnnotationEngine(inkCanvas);
const viewport = new Viewport(viewportEl, pageEl);

// --- editor state ----------------------------------------------------------
let backdropType: "md" | "image" | null = null;
let currentJobId: string | null = null; // set once saved / reopened
let currentMdText: string | null = null; // md backdrop source text
let currentBackdropRef: string | null = null; // md original ?doc= path
let currentBackdropBlob: Blob | null = null; // image backdrop bytes (for first save)
let dirty = false;

// ---------------------------------------------------------------------------
// Backdrop loading
// ---------------------------------------------------------------------------
async function openMdDoc(path: string) {
  const doc = await loadDoc(path);
  backdropType = "md";
  currentMdText = doc.text;
  currentBackdropRef = path;
  currentJobId = null;
  previewEl.innerHTML = renderMarkdown(doc.text, doc.dir);
  await afterBackdropLoaded([]);
}

// Set an image Backdrop via setAttribute (not innerHTML) so a URL is never
// parsed as HTML — robust even if a future source supplies an external URL.
function setImageBackdrop(url: string) {
  previewEl.replaceChildren();
  const img = document.createElement("img");
  img.id = "backdrop-img";
  img.alt = "backdrop";
  img.setAttribute("src", url);
  previewEl.appendChild(img);
}

// External markdown Backdrop (te-kb edit button → ?src=<raw-md-url>).
async function openMdFromUrl(url: string) {
  const text = await fetchExternalMd(url);
  backdropType = "md";
  currentMdText = text;
  currentBackdropRef = url; // provenance; external md uses absolute image URLs
  currentJobId = null;
  previewEl.innerHTML = renderMarkdown(text, "");
  await afterBackdropLoaded([]);
}

async function openImageFile(file: File) {
  backdropType = "image";
  currentBackdropBlob = file;
  currentJobId = null;
  currentMdText = null;
  setImageBackdrop(URL.createObjectURL(file));
  await afterBackdropLoaded([]);
}

async function openJob(id: string) {
  const job: JobManifest = await loadJob(id);
  currentJobId = id;
  backdropType = job.type;
  currentBackdropRef = job.backdropRef;
  if (job.type === "md") {
    currentMdText = await loadJobMd(id);
    const dir = job.backdropRef ? job.backdropRef.split("/").slice(0, -1).join("/") : "";
    previewEl.innerHTML = renderMarkdown(currentMdText, dir);
  } else {
    currentMdText = null;
    setImageBackdrop(job.backdropUrl ?? `/api/jobs/${id}/backdrop`);
  }
  const ink = await loadJobStrokes(id);
  await afterBackdropLoaded(ink.strokes ?? []);
  // surface a prior te-kb publish (appended ref, or a fallback new paste)
  const prior = job.appendedTo ?? job.lastPaste;
  if (prior) {
    resultText.innerHTML = `📚 job นี้ลง KB แล้ว: <a href="${prior.url}" target="_blank">${prior.url}</a>`;
    resultBanner.hidden = false;
  }
}

async function afterBackdropLoaded(strokes: Parameters<typeof engine.loadStrokes>[0]) {
  intakeEl.style.display = "none";
  await sizePage();
  engine.loadStrokes(strokes);
  viewport.reset(pageEl.offsetWidth, viewportEl.clientWidth);
  watchImages();
  dirty = false;
  syncToolbarState();
}

// Size the page to the rendered Backdrop, and the ink canvas to match.
async function sizePage() {
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  const w = previewEl.offsetWidth;
  const h = previewEl.scrollHeight;
  pageEl.style.height = `${h}px`;
  engine.setPageSize(w, h);
}

// Images (md-local or the Source Image) change height once loaded — re-measure.
function watchImages() {
  previewEl.querySelectorAll("img").forEach((img) => {
    if (!img.complete) {
      img.addEventListener("load", () => void sizePage(), { once: true });
      img.addEventListener("error", () => void sizePage(), { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Save KB — the single save action: persist the Markup Job (bake tiles) then
// post-back to te-kb (append a ref to the source paste, or create a new paste).
// PNG download is the only other action. (No separate local-only save.)
// ---------------------------------------------------------------------------

// Persist the job (bake tiles + POST). Returns the manifest, or null on failure.
async function saveCurrentJob(): Promise<JobManifest | null> {
  if (!backdropType) return null;
  const tiles = await bakeTiles(previewEl, inkCanvas, viewport);
  const { width, height } = engine.pageSize();
  const manifest = await saveJob({
    type: backdropType,
    jobId: currentJobId ?? undefined,
    mdText: backdropType === "md" ? currentMdText ?? "" : undefined,
    backdropRef: currentBackdropRef ?? undefined,
    pageWidth: width,
    pageHeight: height,
    strokes: { version: 1, strokes: engine.getStrokes(), pageWidth: width, pageHeight: height },
    backdrop: backdropType === "image" && !currentJobId ? currentBackdropBlob ?? undefined : undefined,
    tiles,
  });
  currentJobId = manifest.id;
  history.replaceState(null, "", `/?job=${manifest.id}`);
  dirty = false;
  return manifest;
}

async function doSaveKB() {
  if (!backdropType) return;
  const btn = $<HTMLButtonElement>("#btn-savekb");
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "กำลังบันทึก…";
  try {
    const manifest = await saveCurrentJob();
    if (!manifest) return;
    // post-back: append a ref to the source paste, or create a new paste
    const res = await publishJob(manifest.id);
    if (res.published && res.url) {
      const where = res.mode === "append" ? "เพิ่มใน paste เดิม" : "paste ใหม่";
      resultText.innerHTML = `✅ บันทึกเข้า KB (${where}): <a href="${res.url}" target="_blank">${res.url}</a>`;
    } else if (res.reason === "no-token") {
      resultText.innerHTML = `ℹ️ บันทึก job แล้ว (เซิร์ฟเวอร์นี้ยังไม่ได้ตั้งค่า post-back KB)`;
    } else {
      resultText.innerHTML = `⚠️ บันทึก job แล้ว แต่ลง KB ไม่สำเร็จ: ${res.error ?? "unknown"}`;
    }
    resultBanner.hidden = false;
  } catch (err) {
    resultText.innerHTML = `⚠️ บันทึกล้มเหลว: ${(err as Error).message}`;
    resultBanner.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// ---------------------------------------------------------------------------
// Pointer routing — pen draws, 2 fingers pinch/pan, single-finger draw|scroll.
// (Identical model to the POC; routing by pointerType, no pressure.)
// ---------------------------------------------------------------------------
let fingerMode: "draw" | "scroll" = "draw";
interface Pt { x: number; y: number; type: string }
const pointers = new Map<number, Pt>();
let drawPointerId: number | null = null;
let panPointerId: number | null = null;
let panLast = { x: 0, y: 0 };
interface Gesture { ids: [number, number]; startDist: number; startScale: number; content0: { x: number; y: number } }
let gesture: Gesture | null = null;

function touchIds(): number[] {
  return [...pointers.entries()].filter(([, p]) => p.type === "touch").map(([id]) => id);
}
function startDraw(id: number, clientX: number, clientY: number) {
  drawPointerId = id;
  const c = viewport.toContent(clientX, clientY);
  engine.begin(c.x, c.y);
}
function startGesture(a: number, b: number) {
  if (drawPointerId !== null && pointers.get(drawPointerId)?.type === "touch") {
    engine.cancelActive();
    drawPointerId = null;
  }
  const pa = pointers.get(a)!;
  const pb = pointers.get(b)!;
  gesture = {
    ids: [a, b],
    startDist: Math.hypot(pa.x - pb.x, pa.y - pb.y),
    startScale: viewport.scale,
    content0: viewport.toContent((pa.x + pb.x) / 2, (pa.y + pb.y) / 2),
  };
}
function updateGesture() {
  if (!gesture) return;
  const pa = pointers.get(gesture.ids[0]);
  const pb = pointers.get(gesture.ids[1]);
  if (!pa || !pb) return;
  const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y);
  const nextScale = gesture.startScale * (dist / gesture.startDist);
  viewport.pinch(gesture.content0, viewport.viewportPoint((pa.x + pb.x) / 2, (pa.y + pb.y) / 2), nextScale);
}

viewportEl.addEventListener("pointerdown", (e) => {
  if (!backdropType) return;
  e.preventDefault();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
  try {
    viewportEl.setPointerCapture(e.pointerId);
  } catch {
    /* best-effort */
  }
  if (e.pointerType === "touch") {
    const tIds = touchIds();
    if (tIds.length >= 2 && !gesture) {
      startGesture(tIds[0], tIds[1]);
    } else if (tIds.length === 1) {
      if (fingerMode === "draw") startDraw(e.pointerId, e.clientX, e.clientY);
      else {
        panPointerId = e.pointerId;
        panLast = { x: e.clientX, y: e.clientY };
      }
    }
  } else {
    startDraw(e.pointerId, e.clientX, e.clientY);
  }
});

viewportEl.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  e.preventDefault();
  p.x = e.clientX;
  p.y = e.clientY;
  if (gesture && (e.pointerId === gesture.ids[0] || e.pointerId === gesture.ids[1])) {
    updateGesture();
  } else if (e.pointerId === drawPointerId) {
    const c = viewport.toContent(e.clientX, e.clientY);
    engine.extend(c.x, c.y);
  } else if (e.pointerId === panPointerId) {
    viewport.panBy(e.clientX - panLast.x, e.clientY - panLast.y);
    panLast = { x: e.clientX, y: e.clientY };
  }
});

function endPointer(e: PointerEvent) {
  try {
    if (viewportEl.hasPointerCapture(e.pointerId)) viewportEl.releasePointerCapture(e.pointerId);
  } catch {
    /* best-effort */
  }
  if (e.pointerId === drawPointerId) {
    engine.end();
    drawPointerId = null;
  }
  if (gesture && (e.pointerId === gesture.ids[0] || e.pointerId === gesture.ids[1])) gesture = null;
  if (e.pointerId === panPointerId) panPointerId = null;
  pointers.delete(e.pointerId);
}
viewportEl.addEventListener("pointerup", endPointer);
viewportEl.addEventListener("pointercancel", endPointer);

viewportEl.addEventListener(
  "wheel",
  (e) => {
    if (!backdropType) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      viewport.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    } else {
      viewport.panBy(-e.deltaX, -e.deltaY);
    }
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------
const COLORS = [
  { name: "ดำ", value: "#111827" },
  { name: "แดง", value: "#e11d48" },
  { name: "น้ำเงิน", value: "#2563eb" },
];

function button(label: string, title: string, onClick: () => void, id?: string) {
  const b = document.createElement("button");
  b.className = "tool-btn";
  b.textContent = label;
  b.title = title;
  if (id) b.id = id;
  b.addEventListener("click", onClick);
  return b;
}

function buildToolbar() {
  toolbarEl.innerHTML = "";

  const tools = document.createElement("div");
  tools.className = "tgroup";
  tools.append(
    button("✏️", "ปากกา", () => setTool("pen"), "tool-pen"),
    button("🖍️", "ไฮไลต์", () => setTool("highlighter"), "tool-hi"),
    button("🩹", "ยางลบ", () => setTool("eraser"), "tool-eraser"),
  );

  const colors = document.createElement("div");
  colors.className = "tgroup";
  for (const c of COLORS) {
    const sw = document.createElement("button");
    sw.className = "swatch";
    sw.style.background = c.value;
    sw.title = c.name;
    sw.dataset.color = c.value;
    sw.addEventListener("click", () => setColor(c.value));
    colors.appendChild(sw);
  }

  const widthGroup = document.createElement("div");
  widthGroup.className = "tgroup";
  const widthInput = document.createElement("input");
  widthInput.type = "range";
  widthInput.min = "1";
  widthInput.max = "16";
  widthInput.value = String(engine.penWidth);
  widthInput.title = "ความหนา";
  widthInput.addEventListener("input", () => (engine.penWidth = Number(widthInput.value)));
  widthGroup.append("หนา", widthInput);

  const edit = document.createElement("div");
  edit.className = "tgroup";
  edit.append(
    button("↶", "undo", () => engine.undo(), "btn-undo"),
    button("↷", "redo", () => engine.redo(), "btn-redo"),
    button("🗑️", "ล้างทั้งหมด", () => {
      if (engine.hasContent() && confirm("ล้าง annotation ทั้งหมด?")) engine.clear();
    }),
  );

  const nav = document.createElement("div");
  nav.className = "tgroup";
  nav.append(
    button("✋", "นิ้ว: วาด/เลื่อน", toggleFingerMode, "btn-finger"),
    button("⊕", "พอดีจอ", () => viewport.reset(pageEl.offsetWidth, viewportEl.clientWidth)),
  );

  const right = document.createElement("div");
  right.className = "tgroup right";
  right.append(
    button("⬇️ PNG", "ดาวน์โหลด PNG", doDownloadPng, "btn-png"),
    (() => {
      const b = button("💾 Save KB", "บันทึก + ลง te-kb", () => void doSaveKB(), "btn-savekb");
      b.classList.add("primary");
      return b;
    })(),
  );

  toolbarEl.append(tools, colors, widthGroup, edit, nav, right);
  syncToolbarState();
}

function setTool(t: "pen" | "highlighter" | "eraser") {
  engine.tool = t;
  syncToolbarState();
}
function setColor(v: string) {
  engine.color = v;
  if (engine.tool === "eraser") engine.tool = "pen";
  syncToolbarState();
}
function toggleFingerMode() {
  fingerMode = fingerMode === "draw" ? "scroll" : "draw";
  syncToolbarState();
}

function syncToolbarState() {
  $("#tool-pen")?.classList.toggle("active", engine.tool === "pen");
  $("#tool-hi")?.classList.toggle("active", engine.tool === "highlighter");
  $("#tool-eraser")?.classList.toggle("active", engine.tool === "eraser");
  for (const sw of document.querySelectorAll<HTMLElement>(".swatch")) {
    sw.classList.toggle("sel", sw.dataset.color === engine.color);
  }
  const undo = $<HTMLButtonElement>("#btn-undo");
  const redo = $<HTMLButtonElement>("#btn-redo");
  if (undo) undo.disabled = !engine.canUndo();
  if (redo) redo.disabled = !engine.canRedo();
  const finger = $("#btn-finger");
  if (finger) {
    finger.classList.toggle("active", fingerMode === "scroll");
    finger.textContent = fingerMode === "draw" ? "✋วาด" : "✋เลื่อน";
  }
  const hasBackdrop = !!backdropType;
  for (const id of ["btn-savekb", "btn-png"]) {
    const b = $<HTMLButtonElement>("#" + id);
    if (b) b.disabled = !hasBackdrop;
  }
}

async function doDownloadPng() {
  if (!backdropType) return;
  const blob = await exportMarkupImage(previewEl, inkCanvas, viewport);
  downloadBlob(blob, `${currentJobId ?? "markup"}.png`);
}

engine.onChange = () => {
  dirty = true;
  syncToolbarState();
};

// keep page sized as backdrop reflows
const ro = new ResizeObserver(() => {
  if (!backdropType) return;
  const w = previewEl.offsetWidth;
  const h = previewEl.scrollHeight;
  if (w && h && (w !== engine.pageSize().width || h !== engine.pageSize().height)) {
    pageEl.style.height = `${h}px`;
    engine.setPageSize(w, h);
  }
});
ro.observe(previewEl);

window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) engine.redo();
    else engine.undo();
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void doSaveKB();
  }
});

window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

imageInput.addEventListener("change", () => {
  const f = imageInput.files?.[0];
  if (f) void openImageFile(f);
});
$("#result-close").addEventListener("click", () => (resultBanner.hidden = true));

// ---------------------------------------------------------------------------
// Boot — route by URL params
// ---------------------------------------------------------------------------
buildToolbar();
(async () => {
  const params = new URLSearchParams(location.search);
  const job = params.get("job");
  const doc = params.get("doc");
  const src = params.get("src");
  try {
    if (job) await openJob(job);
    else if (src) await openMdFromUrl(src);
    else if (doc) await openMdDoc(doc);
    else intakeEl.style.display = "";
  } catch (err) {
    // Show the error in the intake card (polite, non-blocking) rather than alert().
    intakeEl.style.display = "";
    const e = $<HTMLElement>("#intake-error");
    e.textContent = "⚠️ " + (err as Error).message;
    e.hidden = false;
  }
})();
