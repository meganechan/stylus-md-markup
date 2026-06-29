import "github-markdown-css/github-markdown-light.css";
import "highlight.js/styles/github.css";
import "../style.css";
import "./desk.css";

import { renderMarkdown } from "../markdown";
import { AnnotationEngine, Viewport, attachInkPointer } from "../engine";
import type { InkDoc } from "../engine";

// --- types (maw review contract) -------------------------------------------
interface RoundHistory {
  roundNo: number;
  outcome: string;
  feedback?: { comment?: string; ink?: InkDoc };
  decidedAt: string;
}
interface ReviewEnvelope {
  reviewId: string;
  threadId: string;
  roundNo: number;
  title: string;
  asker: string;
  contextNote: string;
  md: string;
  contentType?: string;
  createdAt: string;
  expiresAt: string;
  status: string;
  history?: RoundHistory[];
}

// --- dom -------------------------------------------------------------------
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const reviewEl = $("#review");
const noticeEl = $("#notice");

const engine = new AnnotationEngine($<HTMLCanvasElement>("#ink"));
const viewport = new Viewport($("#viewport"), $("#page"));
attachInkPointer($("#viewport"), engine, viewport);

function showNotice(msg: string, title = "🗂️ Review Desk") {
  reviewEl.hidden = true;
  $("#notice-title").textContent = title;
  $("#notice-msg").innerHTML = msg;
  noticeEl.hidden = false;
}

async function api(path: string, init?: RequestInit) {
  return fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
}

function deadlineText(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "⏰ หมดอายุ";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 1 ? `⏳ เหลือ ~${h}ชม` : `⏳ เหลือ ~${m}น`;
}

// --- open one review (by token) --------------------------------------------
async function sizePage() {
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  const w = $("#preview").offsetWidth;
  const h = $("#preview").scrollHeight;
  $("#page").style.height = `${h}px`;
  engine.setPageSize(w, h);
}

async function openReview(token: string) {
  noticeEl.hidden = true;
  reviewEl.hidden = false;
  let env: ReviewEnvelope;
  try {
    const r = await api(`/api/review/${encodeURIComponent(token)}`);
    if (r.status === 404 || r.status === 410) {
      showNotice("ลิงก์รีวิวนี้ไม่พบหรือหมดอายุแล้ว", "🔗 ลิงก์ใช้ไม่ได้");
      return;
    }
    if (!r.ok) throw new Error(`${r.status}`);
    env = await r.json();
  } catch (e) {
    showNotice("เปิดรีวิวไม่สำเร็จ: " + (e as Error).message, "⚠️ ผิดพลาด");
    return;
  }

  $("#r-title").textContent = env.title || "(ไม่มีหัวข้อ)";
  $("#r-asker").textContent = env.asker ?? "";
  $("#r-round").textContent = String(env.roundNo ?? 1);
  $("#r-deadline").textContent = deadlineText(env.expiresAt);
  $("#r-context").textContent = env.contextNote ?? "";

  const hist = env.history ?? [];
  const histEl = $("#r-history");
  if (hist.length) {
    histEl.hidden = false;
    $("#r-history-list").innerHTML = "";
    for (const h of hist) {
      const li = document.createElement("li");
      const c = h.feedback?.comment;
      const inkMark = h.feedback?.ink?.strokes?.length ? " ✏️" : "";
      li.textContent = `รอบ ${h.roundNo}: ${h.outcome}${c ? " — " + c : ""}${inkMark}`;
      $("#r-history-list").appendChild(li);
    }
  } else {
    histEl.hidden = true;
  }

  // backdrop — only markdown renders in v0 (contentType seam)
  const unsupported = $("#r-unsupported");
  const ct = env.contentType ?? "markdown";
  if (ct === "markdown") {
    unsupported.hidden = true;
    $("#preview").innerHTML = renderMarkdown(env.md ?? "", "");
    await sizePage();
    engine.loadStrokes([]);
    viewport.reset($("#page").offsetWidth, $("#viewport").clientWidth);
  } else {
    unsupported.hidden = false;
    unsupported.textContent = `เนื้อหาชนิด "${ct}" ยังไม่รองรับการแสดงผล (ให้ความเห็นแบบ comment ได้)`;
    $("#preview").innerHTML = "";
  }

  $<HTMLTextAreaElement>("#comment").value = "";
  currentToken = token;
  syncToolbar();
}

// --- decision --------------------------------------------------------------
let currentToken: string | null = null;
let deciding = false;

async function decide(outcome: "approve" | "reject" | "return") {
  if (!currentToken || deciding) return;
  const comment = $<HTMLTextAreaElement>("#comment").value.trim();
  const strokes = engine.getStrokes();

  // Return must carry feedback — else the Asker is sent back without knowing what
  // to fix. Approve/Reject may be empty.
  if (outcome === "return" && !comment && strokes.length === 0) {
    alert("Return ต้องมี comment หรือ ปากกา — บอก Asker ว่าให้แก้อะไร");
    return;
  }
  // Approve/Reject are terminal + single-use — confirm to avoid an irreversible misclick.
  if (outcome === "approve" || outcome === "reject") {
    const label = outcome === "approve" ? "Approve ✅" : "Reject ⛔";
    if (!confirm(`ยืนยัน ${label}? — เป็น decision สุดท้าย แก้ไม่ได้`)) return;
  }

  deciding = true;
  const feedback: { comment?: string; ink?: InkDoc } = {};
  if (comment) feedback.comment = comment;
  if (strokes.length) {
    const { width, height } = engine.pageSize();
    feedback.ink = { version: 1, strokes, pageWidth: width, pageHeight: height };
  }
  try {
    const r = await api(`/api/review/${encodeURIComponent(currentToken)}/decision`, {
      method: "POST",
      body: JSON.stringify({ outcome, feedback: Object.keys(feedback).length ? feedback : undefined }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      alert(`ส่ง Decision ไม่สำเร็จ (${r.status}): ${e.error ?? ""}`);
      return;
    }
    // token-only: no inbox to return to — show a terminal confirmation.
    const word = outcome === "approve" ? "Approve ✅" : outcome === "reject" ? "Reject ⛔" : "Return ↩️";
    currentToken = null;
    showNotice(`ส่ง <b>${word}</b> ให้ผู้ขอแล้ว — ปิดหน้านี้ได้`, "✅ เสร็จสิ้น");
  } catch (e) {
    alert("ส่ง Decision ไม่สำเร็จ: " + (e as Error).message);
  } finally {
    deciding = false;
  }
}
for (const btn of document.querySelectorAll<HTMLButtonElement>(".decide")) {
  btn.addEventListener("click", () => void decide(btn.dataset.outcome as "approve" | "reject" | "return"));
}

// --- pen toolbar (compact, reuses the engine) ------------------------------
const COLORS = ["#111827", "#e11d48", "#2563eb"];
function syncToolbar() {
  $("#dt-pen")?.classList.toggle("active", engine.tool === "pen");
  $("#dt-hi")?.classList.toggle("active", engine.tool === "highlighter");
  $("#dt-er")?.classList.toggle("active", engine.tool === "eraser");
  for (const sw of document.querySelectorAll<HTMLElement>("#desk-toolbar .swatch")) {
    sw.classList.toggle("sel", sw.dataset.color === engine.color);
  }
  const u = $<HTMLButtonElement>("#dt-undo");
  const r = $<HTMLButtonElement>("#dt-redo");
  if (u) u.disabled = !engine.canUndo();
  if (r) r.disabled = !engine.canRedo();
}
function tbtn(label: string, title: string, onClick: () => void, id?: string) {
  const b = document.createElement("button");
  b.className = "tool-btn";
  b.textContent = label;
  b.title = title;
  if (id) b.id = id;
  b.addEventListener("click", onClick);
  return b;
}
function buildToolbar() {
  const tb = $("#desk-toolbar");
  tb.innerHTML = "";
  const tools = document.createElement("div");
  tools.className = "tgroup";
  tools.append(
    tbtn("✏️", "ปากกา", () => ((engine.tool = "pen"), syncToolbar()), "dt-pen"),
    tbtn("🖍️", "ไฮไลต์", () => ((engine.tool = "highlighter"), syncToolbar()), "dt-hi"),
    tbtn("🩹", "ยางลบ", () => ((engine.tool = "eraser"), syncToolbar()), "dt-er"),
  );
  const colors = document.createElement("div");
  colors.className = "tgroup";
  for (const c of COLORS) {
    const sw = document.createElement("button");
    sw.className = "swatch";
    sw.style.background = c;
    sw.dataset.color = c;
    sw.addEventListener("click", () => {
      engine.color = c;
      if (engine.tool === "eraser") engine.tool = "pen";
      syncToolbar();
    });
    colors.appendChild(sw);
  }
  const edit = document.createElement("div");
  edit.className = "tgroup";
  edit.append(
    tbtn("↶", "undo", () => engine.undo(), "dt-undo"),
    tbtn("↷", "redo", () => engine.redo(), "dt-redo"),
    tbtn("⊕", "พอดีจอ", () => viewport.reset($("#page").offsetWidth, $("#viewport").clientWidth)),
  );
  tb.append(tools, colors, edit);
  syncToolbar();
}
engine.onChange = () => syncToolbar();

// --- router (token-only) ----------------------------------------------------
function route() {
  const m = location.pathname.match(/^\/r\/([^/]+)$/);
  if (m) {
    void openReview(decodeURIComponent(m[1]));
  } else {
    showNotice("เปิด review จากลิงก์ของคุณ (<code>/r/&lt;token&gt;</code>)");
  }
}
window.addEventListener("popstate", route);

// --- boot ------------------------------------------------------------------
buildToolbar();
route();
