// Export — flatten Preview + Annotation into a single PNG Markup Image.
//
// Client-side only (ADR-0001: deliverable is a flattened raster, never edited md).
// We rasterise the Preview DOM with html2canvas, then composite the ink canvas
// on top at the same scale. The pan/zoom transform is reset during capture so
// the full page is rendered at its natural logical size.

import html2canvas from "html2canvas";
import type { Viewport } from "./viewport";

const OUT_SCALE = 2; // crisp export

export async function exportMarkupImage(
  previewEl: HTMLElement,
  inkCanvas: HTMLCanvasElement,
  viewport: Viewport,
): Promise<Blob> {
  // Reset transform so html2canvas captures the untransformed page.
  const saved = { scale: viewport.scale, tx: viewport.tx, ty: viewport.ty };
  viewport.scale = 1;
  viewport.tx = 0;
  viewport.ty = 0;
  viewport.apply();

  try {
    const rendered = await html2canvas(previewEl, {
      backgroundColor: "#ffffff",
      scale: OUT_SCALE,
      useCORS: true,
      logging: false,
    });

    const out = document.createElement("canvas");
    out.width = rendered.width;
    out.height = rendered.height;
    const ctx = out.getContext("2d")!;
    ctx.drawImage(rendered, 0, 0);
    // ink canvas backing store -> stretch to the rendered size (same logical page)
    ctx.drawImage(inkCanvas, 0, 0, inkCanvas.width, inkCanvas.height, 0, 0, out.width, out.height);

    return await new Promise<Blob>((resolve, reject) => {
      out.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
    });
  } finally {
    viewport.scale = saved.scale;
    viewport.tx = saved.tx;
    viewport.ty = saved.ty;
    viewport.apply();
  }
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

// Use the native share sheet when available (mobile), else fall back to download.
export async function shareOrDownload(blob: Blob, filename: string) {
  const file = new File([blob], filename, { type: "image/png" });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.canShare && nav.canShare({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch {
      /* user cancelled or share failed -> fall back */
    }
  }
  downloadBlob(blob, filename);
}
