// Reusable ink pointer routing: pen draws, two fingers pinch/pan, single finger
// draws (fingerMode "draw") or pans ("scroll"). Routing is by pointerType, no
// pressure — the same model the markup tool proved. Attaches to a viewport element
// driving an AnnotationEngine over a Viewport transform.

import type { AnnotationEngine } from "./annotation";
import type { Viewport } from "./viewport";

export interface InkPointerControl {
  getFingerMode(): "draw" | "scroll";
  setFingerMode(m: "draw" | "scroll"): void;
  detach(): void;
}

interface Pt {
  x: number;
  y: number;
  type: string;
}
interface Gesture {
  ids: [number, number];
  startDist: number;
  startScale: number;
  content0: { x: number; y: number };
}

export function attachInkPointer(
  viewportEl: HTMLElement,
  engine: AnnotationEngine,
  viewport: Viewport,
  opts: { enabled?: () => boolean } = {},
): InkPointerControl {
  const enabled = opts.enabled ?? (() => true);
  let fingerMode: "draw" | "scroll" = "draw";
  const pointers = new Map<number, Pt>();
  let drawPointerId: number | null = null;
  let panPointerId: number | null = null;
  let panLast = { x: 0, y: 0 };
  let gesture: Gesture | null = null;

  const touchIds = () =>
    [...pointers.entries()].filter(([, p]) => p.type === "touch").map(([id]) => id);

  function startDraw(id: number, x: number, y: number) {
    drawPointerId = id;
    const c = viewport.toContent(x, y);
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

  function onDown(e: PointerEvent) {
    if (!enabled()) return;
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
  }
  function onMove(e: PointerEvent) {
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
  }
  function onUp(e: PointerEvent) {
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
  function onWheel(e: WheelEvent) {
    if (!enabled()) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      viewport.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    } else {
      viewport.panBy(-e.deltaX, -e.deltaY);
    }
  }

  viewportEl.addEventListener("pointerdown", onDown);
  viewportEl.addEventListener("pointermove", onMove);
  viewportEl.addEventListener("pointerup", onUp);
  viewportEl.addEventListener("pointercancel", onUp);
  viewportEl.addEventListener("wheel", onWheel, { passive: false });

  return {
    getFingerMode: () => fingerMode,
    setFingerMode: (m) => (fingerMode = m),
    detach() {
      viewportEl.removeEventListener("pointerdown", onDown);
      viewportEl.removeEventListener("pointermove", onMove);
      viewportEl.removeEventListener("pointerup", onUp);
      viewportEl.removeEventListener("pointercancel", onUp);
      viewportEl.removeEventListener("wheel", onWheel);
    },
  };
}
