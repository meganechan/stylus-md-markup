// Export — flatten Backdrop + Ink Overlay into baked Tiles (and optional PNG).
//
// Client-side raster (ADR-0001/0003). We rasterise the page DOM (#preview, which
// holds either rendered markdown or the Source Image) with html2canvas, composite
// the ink canvas on top, then slice vertically into Tiles whose long edge is
// ≤ TILE_MAX so a vision model reads each un-downscaled (ADR-0003, pm1: 1500px).

import html2canvas from "html2canvas";
import type { Viewport } from "./viewport";

export const TILE_MAX = 1500; // px — both rendered width and max tile height

// Render the full page (Backdrop + ink) to a single composite canvas at a width
// of TILE_MAX. Pan/zoom transform is reset during capture.
async function renderComposite(
  previewEl: HTMLElement,
  inkCanvas: HTMLCanvasElement,
  viewport: Viewport,
): Promise<HTMLCanvasElement> {
  const saved = { scale: viewport.scale, tx: viewport.tx, ty: viewport.ty };
  viewport.scale = 1;
  viewport.tx = 0;
  viewport.ty = 0;
  viewport.apply();
  try {
    const logicalW = previewEl.offsetWidth || TILE_MAX;
    const scale = TILE_MAX / logicalW; // output width == TILE_MAX
    const rendered = await html2canvas(previewEl, {
      backgroundColor: "#ffffff",
      scale,
      useCORS: true,
      logging: false,
    });
    const out = document.createElement("canvas");
    out.width = rendered.width;
    out.height = rendered.height;
    const ctx = out.getContext("2d")!;
    ctx.drawImage(rendered, 0, 0);
    ctx.drawImage(inkCanvas, 0, 0, inkCanvas.width, inkCanvas.height, 0, 0, out.width, out.height);
    return out;
  } finally {
    viewport.scale = saved.scale;
    viewport.tx = saved.tx;
    viewport.ty = saved.ty;
    viewport.apply();
  }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
}

// Slice the composite into vertical Tiles, each ≤ TILE_MAX tall.
export async function bakeTiles(
  previewEl: HTMLElement,
  inkCanvas: HTMLCanvasElement,
  viewport: Viewport,
): Promise<Blob[]> {
  const full = await renderComposite(previewEl, inkCanvas, viewport);
  const tiles: Blob[] = [];
  const count = Math.max(1, Math.ceil(full.height / TILE_MAX));
  for (let i = 0; i < count; i++) {
    const srcY = i * TILE_MAX;
    const sliceH = Math.min(TILE_MAX, full.height - srcY);
    if (sliceH <= 0) break;
    const tile = document.createElement("canvas");
    tile.width = full.width;
    tile.height = sliceH;
    tile.getContext("2d")!.drawImage(full, 0, srcY, full.width, sliceH, 0, 0, full.width, sliceH);
    tiles.push(await toBlob(tile));
  }
  return tiles;
}

// Single flattened PNG (optional download convenience).
export async function exportMarkupImage(
  previewEl: HTMLElement,
  inkCanvas: HTMLCanvasElement,
  viewport: Viewport,
): Promise<Blob> {
  return toBlob(await renderComposite(previewEl, inkCanvas, viewport));
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
