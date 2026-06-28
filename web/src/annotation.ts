// Annotation engine — strokes laid over the Preview on a <canvas>.
//
// Strokes are stored as vectors in *logical page coordinates* (the fixed-width
// page space, independent of pan/zoom and device DPR), so the same Sidecar
// re-exports identically on any screen. We never store pixels here.
//
// Tools: pen (opaque), highlighter (wide + translucent), eraser (stroke-level).
// Undo/redo is snapshot-based — simple and predictable for a POC.

import type { Stroke, StrokePoint, Tool } from "./api";

export class AnnotationEngine {
  private ctx: CanvasRenderingContext2D;
  private dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
  private w = 0; // logical page width
  private h = 0; // logical page height

  private strokes: Stroke[] = [];
  private undoStack: Stroke[][] = [];
  private redoStack: Stroke[][] = [];

  private active: Stroke | null = null;
  private erasedDuringDrag = false;

  tool: Tool = "pen";
  color = "#e11d48"; // review red by default
  penWidth = 2; // fine default for small handwritten corrections; user can thicken
  highlighterWidth = 18;
  eraserRadius = 14;

  onChange: () => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
  }

  setPageSize(wLogical: number, hLogical: number) {
    this.w = wLogical;
    this.h = hLogical;
    this.canvas.style.width = `${wLogical}px`;
    this.canvas.style.height = `${hLogical}px`;
    this.canvas.width = Math.round(wLogical * this.dpr);
    this.canvas.height = Math.round(hLogical * this.dpr);
    this.redraw();
  }

  pageSize() {
    return { width: this.w, height: this.h };
  }

  loadStrokes(strokes: Stroke[]) {
    this.strokes = strokes.map((s) => ({ ...s, points: s.points.slice() }));
    this.undoStack = [];
    this.redoStack = [];
    this.redraw();
  }

  getStrokes(): Stroke[] {
    return this.strokes;
  }

  hasContent() {
    return this.strokes.length > 0;
  }

  private snapshot(): Stroke[] {
    return this.strokes.map((s) => ({ ...s, points: s.points.slice() }));
  }

  private pushUndo() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  // --- drawing lifecycle ---------------------------------------------------
  begin(x: number, y: number) {
    if (this.tool === "eraser") {
      this.erasedDuringDrag = false;
      this.eraseAt(x, y, /*isDragStart*/ true);
      return;
    }
    this.pushUndo();
    const isHi = this.tool === "highlighter";
    this.active = {
      tool: this.tool,
      color: isHi ? "#fde047" : this.color,
      width: isHi ? this.highlighterWidth : this.penWidth,
      points: [{ x, y }],
    };
  }

  extend(x: number, y: number) {
    if (this.tool === "eraser") {
      this.eraseAt(x, y, false);
      return;
    }
    if (!this.active) return;
    const pts = this.active.points;
    const last = pts[pts.length - 1];
    // skip sub-pixel jitter
    if (Math.hypot(x - last.x, y - last.y) < 0.6) return;
    pts.push({ x, y });
    this.drawStroke(this.active);
  }

  // Drop an in-progress stroke without committing it (e.g. a pinch interrupted
  // a single-finger draw). Undo the snapshot we pushed in begin().
  cancelActive() {
    if (!this.active) return;
    this.active = null;
    if (this.undoStack.length) this.undoStack.pop();
    this.redraw();
  }

  end() {
    if (this.tool === "eraser") {
      if (this.erasedDuringDrag) this.onChange();
      return;
    }
    if (!this.active) return;
    if (this.active.points.length === 1) {
      // a dot — duplicate the point so it renders as a round mark
      this.active.points.push({ ...this.active.points[0] });
    }
    this.strokes.push(this.active);
    this.active = null;
    this.redraw();
    this.onChange();
  }

  // --- eraser (stroke-level hit test) --------------------------------------
  private eraseAt(x: number, y: number, isDragStart: boolean) {
    const r = this.eraserRadius;
    const keep: Stroke[] = [];
    let removed = false;
    for (const s of this.strokes) {
      if (this.strokeNearPoint(s, x, y, r + s.width / 2)) {
        removed = true;
        continue;
      }
      keep.push(s);
    }
    if (removed) {
      if (isDragStart || !this.erasedDuringDrag) this.pushUndo();
      this.strokes = keep;
      this.erasedDuringDrag = true;
      this.redraw();
    }
  }

  private strokeNearPoint(s: Stroke, x: number, y: number, threshold: number): boolean {
    const pts = s.points;
    for (let i = 0; i < pts.length - 1; i++) {
      if (this.distToSegment(x, y, pts[i], pts[i + 1]) <= threshold) return true;
    }
    if (pts.length === 1) {
      return Math.hypot(x - pts[0].x, y - pts[0].y) <= threshold;
    }
    return false;
  }

  private distToSegment(px: number, py: number, a: StrokePoint, b: StrokePoint): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - a.x, py - a.y);
    let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  // --- undo / redo ---------------------------------------------------------
  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.strokes = this.undoStack.pop()!;
    this.active = null;
    this.redraw();
    this.onChange();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.strokes = this.redoStack.pop()!;
    this.active = null;
    this.redraw();
    this.onChange();
  }

  clear() {
    if (!this.strokes.length) return;
    this.pushUndo();
    this.strokes = [];
    this.redraw();
    this.onChange();
  }

  canUndo() {
    return this.undoStack.length > 0;
  }
  canRedo() {
    return this.redoStack.length > 0;
  }

  // --- rendering -----------------------------------------------------------
  redraw() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    for (const s of this.strokes) this.drawStroke(s, /*full*/ true);
  }

  private drawStroke(s: Stroke, full = false) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.globalAlpha = s.tool === "highlighter" ? 0.4 : 1;

    const pts = s.points;
    if (pts.length < 2) {
      if (pts.length === 1) {
        ctx.globalAlpha = s.tool === "highlighter" ? 0.4 : 1;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, s.width / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return;
    }

    ctx.beginPath();
    if (full) {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    } else {
      // incremental: just the last segment
      const n = pts.length;
      ctx.moveTo(pts[n - 2].x, pts[n - 2].y);
      ctx.lineTo(pts[n - 1].x, pts[n - 1].y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
