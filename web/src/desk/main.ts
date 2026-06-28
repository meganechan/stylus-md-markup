import "github-markdown-css/github-markdown-light.css";
import "highlight.js/styles/github.css";
import "../style.css";
import "./desk.css";

import { renderMarkdown } from "../markdown";
import { AnnotationEngine, Viewport, attachInkPointer } from "../engine";
import type { InkDoc } from "../engine";

// --- types (maw review contract) -------------------------------------------
interface ReviewSummary {
  reviewId: string;
  threadId: string;
  roundNo: number;
  title: string;
  asker: string;
  contextNote: string;
  createdAt: string;
  expiresAt: string;
  token: string; // capability to open this Round
}
interface RoundHistory {
  roundNo: number;
  outcome: string;
  comment?: string;
  decidedAt: string;
}
interface ReviewEnvelope extends ReviewSummary {
  md: string;
  contentType?: string;
  status: string;
  history?: RoundHistory[];
}

// --- dom -------------------------------------------------------------------
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const loginEl = $("#login");
const deskEl = $("#desk");
const inboxEl = $("#inbox");
const reviewEl = $("#review");
const listEl = $<HTMLUListElement>("#inbox-list");

const engine = new AnnotationEngine($<HTMLCanvasElement>("#ink"));
const viewport = new Viewport($("#viewport"), $("#page"));
attachInkPointer($("#viewport"), engine, viewport);

// --- tiny api client -------------------------------------------------------
async function api(path: string, init?: RequestInit) {
  return fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
}

// --- auth ------------------------------------------------------------------
async function ensureAuthed(): Promise<boolean> {
  try {
    const s = await (await api("/api/session")).json();
    return !!s.authed;
  } catch {
    return false;
  }
}
function showLogin() {
  loginEl.hidden = false;
  deskEl.hidden = true;
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  err.hidden = true;
  const passphrase = $<HTMLInputElement>("#passphrase").value;
  const r = await api("/api/login", { method: "POST", body: JSON.stringify({ passphrase }) });
  if (r.ok) {
    loginEl.hidden = true;
    deskEl.hidden = false;
    void route();
  } else {
    err.textContent = "passphrase ไม่ถูกต้อง";
    err.hidden = false;
  }
});

// --- deadline formatting ---------------------------------------------------
function deadlineText(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "⏰ หมดอายุ";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 1 ? `⏳ เหลือ ~${h}ชม` : `⏳ เหลือ ~${m}น`;
}

// --- inbox -----------------------------------------------------------------
const pending = new Map<string, ReviewSummary>(); // keyed by reviewId

function renderInbox() {
  listEl.innerHTML = "";
  const items = [...pending.values()].sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  $("#inbox-count").textContent = String(items.length);
  $("#inbox-empty").hidden = items.length > 0;
  for (const it of items) {
    const li = document.createElement("li");
    li.className = "inbox-item";
    li.innerHTML =
      `<a href="/r/${encodeURIComponent(it.token)}"><span class="it-title"></span>` +
      `<span class="it-sub"></span></a>`;
    li.querySelector(".it-title")!.textContent = it.title || "(ไม่มีหัวข้อ)";
    li.querySelector(".it-sub")!.textContent =
      `${it.asker} · รอบ ${it.roundNo} · ${deadlineText(it.expiresAt)}`;
    listEl.appendChild(li);
  }
}

async function loadPending() {
  try {
    const arr = (await (await api("/api/pending")).json()) as ReviewSummary[];
    pending.clear();
    if (Array.isArray(arr)) for (const s of arr) pending.set(s.reviewId, s);
    renderInbox();
  } catch {
    /* leave existing list */
  }
}

let es: EventSource | null = null;
function connectStream() {
  es?.close();
  es = new EventSource("/api/stream");
  const conn = $("#conn");
  es.onopen = () => {
    conn.classList.add("live");
    void loadPending(); // re-snapshot on (re)connect — never miss an item
  };
  es.onerror = () => conn.classList.remove("live"); // EventSource auto-reconnects
  es.addEventListener("review.created", (e) => {
    const s = JSON.parse((e as MessageEvent).data) as ReviewSummary;
    pending.set(s.reviewId, s);
    renderInbox();
  });
  const drop = (e: Event) => {
    const s = JSON.parse((e as MessageEvent).data) as ReviewSummary;
    pending.delete(s.reviewId);
    renderInbox();
  };
  es.addEventListener("review.decided", drop);
  es.addEventListener("review.expired", drop);
}

// --- review view -----------------------------------------------------------
async function sizePage() {
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  const w = $("#preview").offsetWidth;
  const h = $("#preview").scrollHeight;
  $("#page").style.height = `${h}px`;
  engine.setPageSize(w, h);
}

async function openReview(token: string) {
  inboxEl.hidden = true;
  reviewEl.hidden = false;
  let env: ReviewEnvelope;
  try {
    const r = await api(`/api/review/${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(`${r.status}`);
    env = await r.json();
  } catch (e) {
    $("#r-title").textContent = "เปิดรีวิวไม่สำเร็จ: " + (e as Error).message;
    return;
  }

  $("#r-title").textContent = env.title || "(ไม่มีหัวข้อ)";
  $("#r-asker").textContent = env.asker ?? "";
  $("#r-round").textContent = String(env.roundNo ?? 1);
  $("#r-deadline").textContent = deadlineText(env.expiresAt);
  $("#r-context").textContent = env.contextNote ?? "";

  // Round history
  const hist = env.history ?? [];
  const histEl = $("#r-history");
  if (hist.length) {
    histEl.hidden = false;
    $("#r-history-list").innerHTML = "";
    for (const h of hist) {
      const li = document.createElement("li");
      li.textContent = `รอบ ${h.roundNo}: ${h.outcome}${h.comment ? " — " + h.comment : ""}`;
      $("#r-history-list").appendChild(li);
    }
  } else {
    histEl.hidden = true;
  }

  // backdrop — only markdown is renderable in v0 (contentType seam)
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
  deciding = true;
  const comment = $<HTMLTextAreaElement>("#comment").value.trim();
  const strokes = engine.getStrokes();
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
    // success → back to inbox (the item drops via SSE review.decided too)
    location.href = "/review";
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

// --- router ----------------------------------------------------------------
async function route() {
  const m = location.pathname.match(/^\/r\/([^/]+)$/);
  if (m) {
    inboxEl.hidden = true;
    reviewEl.hidden = false;
    await openReview(decodeURIComponent(m[1]));
  } else {
    reviewEl.hidden = true;
    inboxEl.hidden = false;
    await loadPending();
    if (!es) connectStream();
  }
}
window.addEventListener("popstate", () => void route());
// intercept in-app links for SPA nav
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  const href = a.getAttribute("href") ?? "";
  if (href.startsWith("/r/") || href === "/review") {
    e.preventDefault();
    history.pushState(null, "", href);
    void route();
  }
});

// --- boot ------------------------------------------------------------------
buildToolbar();
(async () => {
  if (await ensureAuthed()) {
    deskEl.hidden = false;
    await route();
  } else {
    showLogin();
  }
})();
