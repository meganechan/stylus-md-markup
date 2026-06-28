import "github-markdown-css/github-markdown-light.css";
import "highlight.js/styles/github.css";
import "./style.css";

import { listFiles, loadDoc, loadInk, saveInk } from "./api";
import type { InkDoc } from "./api";
import { renderMarkdown } from "./markdown";
import { AnnotationEngine } from "./annotation";
import { Viewport } from "./viewport";
import { exportMarkupImage, shareOrDownload } from "./exporter";

// --- elements --------------------------------------------------------------
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const fileListEl = $<HTMLUListElement>("#file-list");
const docsDirEl = $<HTMLElement>("#docs-dir");
const previewEl = $<HTMLElement>("#preview");
const inkCanvas = $<HTMLCanvasElement>("#ink");
const pageEl = $<HTMLElement>("#page");
const viewportEl = $<HTMLElement>("#viewport");
const toolbarEl = $<HTMLElement>("#toolbar");
const emptyHint = $<HTMLElement>("#empty-hint");

const engine = new AnnotationEngine(inkCanvas);
const viewport = new Viewport(viewportEl, pageEl);

let currentPath: string | null = null;
let fingerMode: "draw" | "scroll" = "draw";
let saveTimer: number | undefined;

// --- file list -------------------------------------------------------------
async function refreshFiles() {
  const { docsDir, files } = await listFiles();
  docsDirEl.textContent = docsDir;
  fileListEl.innerHTML = "";
  if (!files.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "ไม่พบไฟล์ .md ใน mount";
    fileListEl.appendChild(li);
    return;
  }
  for (const f of files) {
    const li = document.createElement("li");
    li.textContent = f;
    li.dataset.path = f;
    if (f === currentPath) li.classList.add("active");
    li.addEventListener("click", () => openDoc(f));
    fileListEl.appendChild(li);
  }
}

// --- open a document -------------------------------------------------------
async function openDoc(path: string) {
  // flush any pending save for the previous doc first
  await flushSave();
  currentPath = path;
  emptyHint.style.display = "none";

  const doc = await loadDoc(path);
  previewEl.innerHTML = renderMarkdown(doc.text, doc.dir);

  // size the page once layout settles, then load strokes
  await sizePage();
  const ink = await loadInk(path);
  engine.loadStrokes(ink.strokes ?? []);

  // fit page into the viewport width
  viewport.reset(pageEl.offsetWidth, viewportEl.clientWidth);

  for (const li of fileListEl.querySelectorAll("li")) {
    li.classList.toggle("active", (li as HTMLElement).dataset.path === path);
  }
  watchImages();
}

// Measure the preview and resize the ink canvas to match (logical page space).
async function sizePage() {
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  const w = previewEl.offsetWidth;
  const h = previewEl.scrollHeight;
  pageEl.style.height = `${h}px`;
  engine.setPageSize(w, h);
}

// Images can change page height after they load — re-measure when they do.
function watchImages() {
  const imgs = previewEl.querySelectorAll("img");
  imgs.forEach((img) => {
    if (!img.complete) {
      img.addEventListener("load", () => void sizePage(), { once: true });
      img.addEventListener("error", () => void sizePage(), { once: true });
    }
  });
}

// --- autosave (sidecar) ----------------------------------------------------
function scheduleSave() {
  if (!currentPath) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flushSave(), 700);
}

async function flushSave() {
  window.clearTimeout(saveTimer);
  if (!currentPath) return;
  const { width, height } = engine.pageSize();
  const ink: InkDoc = {
    version: 1,
    strokes: engine.getStrokes(),
    pageWidth: width,
    pageHeight: height,
  };
  await saveInk(currentPath, ink);
}

engine.onChange = () => {
  scheduleSave();
  syncToolbarState();
};

// --- pointer routing -------------------------------------------------------
// Pen/mouse always draws. Touch: 2 fingers = pinch/pan; 1 finger draws
// (fingerMode 'draw') or pans (fingerMode 'scroll'). A pen can draw while two
// fingers navigate, because routing is by pointerType, not a global mode.
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
  // abandon an in-progress single-finger draw when a pinch begins
  if (drawPointerId !== null && pointers.get(drawPointerId)?.type === "touch") {
    engine.cancelActive();
    drawPointerId = null;
  }
  const pa = pointers.get(a)!;
  const pb = pointers.get(b)!;
  const midClientX = (pa.x + pb.x) / 2;
  const midClientY = (pa.y + pb.y) / 2;
  gesture = {
    ids: [a, b],
    startDist: Math.hypot(pa.x - pb.x, pa.y - pb.y),
    startScale: viewport.scale,
    content0: viewport.toContent(midClientX, midClientY),
  };
}

function updateGesture() {
  if (!gesture) return;
  const pa = pointers.get(gesture.ids[0]);
  const pb = pointers.get(gesture.ids[1]);
  if (!pa || !pb) return;
  const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y);
  const midClientX = (pa.x + pb.x) / 2;
  const midClientY = (pa.y + pb.y) / 2;
  const nextScale = gesture.startScale * (dist / gesture.startDist);
  viewport.pinch(gesture.content0, viewport.viewportPoint(midClientX, midClientY), nextScale);
}

viewportEl.addEventListener("pointerdown", (e) => {
  if (!currentPath) return;
  // Stop the browser from starting a native text selection on the Preview DOM
  // underneath the overlay while drawing/panning. This is a markup tool, not a
  // text copier — selection is disabled outright (see also user-select in CSS).
  e.preventDefault();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
  // Capture so we keep receiving move/up even if the finger leaves the element.
  // Guard: can throw NotFoundError (e.g. synthetic events) — must never abort routing.
  try {
    viewportEl.setPointerCapture(e.pointerId);
  } catch {
    /* capture is best-effort */
  }

  if (e.pointerType === "touch") {
    const tIds = touchIds();
    if (tIds.length >= 2 && !gesture) {
      startGesture(tIds[0], tIds[1]);
    } else if (tIds.length === 1) {
      if (fingerMode === "draw") {
        startDraw(e.pointerId, e.clientX, e.clientY);
      } else {
        panPointerId = e.pointerId;
        panLast = { x: e.clientX, y: e.clientY };
      }
    }
  } else {
    // pen / mouse
    startDraw(e.pointerId, e.clientX, e.clientY);
  }
});

viewportEl.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  e.preventDefault(); // suppress native selection/scroll while a pointer is active
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
    if (viewportEl.hasPointerCapture(e.pointerId)) {
      viewportEl.releasePointerCapture(e.pointerId);
    }
  } catch {
    /* best-effort */
  }
  if (e.pointerId === drawPointerId) {
    engine.end();
    drawPointerId = null;
  }
  if (gesture && (e.pointerId === gesture.ids[0] || e.pointerId === gesture.ids[1])) {
    gesture = null;
  }
  if (e.pointerId === panPointerId) {
    panPointerId = null;
  }
  pointers.delete(e.pointerId);
}
viewportEl.addEventListener("pointerup", endPointer);
viewportEl.addEventListener("pointercancel", endPointer);

// desktop trackpad / wheel zoom (ctrl/⌘+wheel) and scroll-pan
viewportEl.addEventListener(
  "wheel",
  (e) => {
    if (!currentPath) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      viewport.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    } else {
      viewport.panBy(-e.deltaX, -e.deltaY);
    }
  },
  { passive: false },
);

// --- toolbar ---------------------------------------------------------------
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
  const penBtn = button("✏️", "ปากกา", () => setTool("pen"), "tool-pen");
  const hiBtn = button("🖍️", "ไฮไลต์", () => setTool("highlighter"), "tool-hi");
  const erBtn = button("🩹", "ยางลบ", () => setTool("eraser"), "tool-eraser");
  tools.append(penBtn, hiBtn, erBtn);

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
  widthInput.id = "width-range";
  widthInput.addEventListener("input", () => {
    engine.penWidth = Number(widthInput.value);
  });
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
  const exportBtn = button("⬇️ Export PNG", "บันทึกเป็นรูป", doExport, "btn-export");
  exportBtn.classList.add("primary");
  right.append(exportBtn);

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
}

// --- export ----------------------------------------------------------------
async function doExport() {
  if (!currentPath) return;
  const btn = $<HTMLButtonElement>("#btn-export");
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "กำลังสร้าง…";
  try {
    await flushSave();
    const blob = await exportMarkupImage(previewEl, inkCanvas, viewport);
    const base = currentPath.split("/").pop()!.replace(/\.md$/i, "");
    await shareOrDownload(blob, `${base}.markup.png`);
  } catch (err) {
    alert("Export ล้มเหลว: " + (err as Error).message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// keep page sized as preview reflows (late images, fonts)
const ro = new ResizeObserver(() => {
  if (!currentPath) return;
  const w = previewEl.offsetWidth;
  const h = previewEl.scrollHeight;
  if (w && h && (w !== engine.pageSize().width || h !== engine.pageSize().height)) {
    pageEl.style.height = `${h}px`;
    engine.setPageSize(w, h);
  }
});
ro.observe(previewEl);

window.addEventListener("beforeunload", () => void flushSave());

// keyboard: undo/redo on desktop
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) engine.redo();
    else engine.undo();
  }
});

$("#reload-files").addEventListener("click", () => void refreshFiles());

// --- boot ------------------------------------------------------------------
buildToolbar();
void refreshFiles();
