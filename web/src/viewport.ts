// Viewport — pan/zoom of the fixed-width #page via a CSS transform.
//
// The page is laid out at a fixed logical width (so stroke coordinates are
// device-independent) and the whole page (Preview + ink canvas together) is
// translated/scaled as one. Screen pointers are mapped back into page-content
// coordinates by inverting this transform, so strokes land where the pen is.

export class Viewport {
  scale = 1;
  tx = 0;
  ty = 0;
  minScale = 0.2;
  maxScale = 5;

  constructor(
    private viewportEl: HTMLElement,
    private pageEl: HTMLElement,
  ) {
    this.apply();
  }

  apply() {
    this.pageEl.style.transformOrigin = "0 0";
    this.pageEl.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
  }

  // Map a screen (clientX/Y) point to page-content logical coordinates.
  toContent(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.viewportEl.getBoundingClientRect();
    const vx = clientX - rect.left;
    const vy = clientY - rect.top;
    return { x: (vx - this.tx) / this.scale, y: (vy - this.ty) / this.scale };
  }

  // Anchor a content point under a viewport point (used by pinch/pan).
  private anchor(contentX: number, contentY: number, viewportX: number, viewportY: number) {
    this.tx = viewportX - contentX * this.scale;
    this.ty = viewportY - contentY * this.scale;
  }

  panBy(dx: number, dy: number) {
    this.tx += dx;
    this.ty += dy;
    this.apply();
  }

  // Pinch: keep `content` fixed under the gesture midpoint while scaling.
  pinch(content: { x: number; y: number }, midpointViewport: { x: number; y: number }, nextScale: number) {
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, nextScale));
    this.anchor(content.x, content.y, midpointViewport.x, midpointViewport.y);
    this.apply();
  }

  // Wheel/trackpad zoom anchored at the cursor (desktop convenience).
  zoomAt(clientX: number, clientY: number, factor: number) {
    const before = this.toContent(clientX, clientY);
    const rect = this.viewportEl.getBoundingClientRect();
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));
    this.anchor(before.x, before.y, clientX - rect.left, clientY - rect.top);
    this.apply();
  }

  reset(fitWidth?: number, containerWidth?: number) {
    this.scale = 1;
    if (fitWidth && containerWidth && fitWidth > containerWidth) {
      this.scale = Math.max(this.minScale, containerWidth / fitWidth);
    }
    // center horizontally with a little top margin
    const w = (fitWidth ?? 0) * this.scale;
    this.tx = containerWidth ? Math.max(0, (containerWidth - w) / 2) : 0;
    this.ty = 16;
    this.apply();
  }

  viewportPoint(clientX: number, clientY: number) {
    const rect = this.viewportEl.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }
}
