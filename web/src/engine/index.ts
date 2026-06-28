// Ink engine — UI- and backend-agnostic core shared by every surface (the markup
// tool and the review desk): the vector stroke model, the annotation canvas, the
// pan/zoom viewport, and flatten/tile export.
//
// The engine annotates a *backdrop* but does not produce one — backdrops come from
// a separate "backdrop provider" (e.g. the markdown renderer; later image/ui), so
// the same engine can mark up anything.

export type { Tool, StrokePoint, Stroke, InkDoc } from "./types";
export { AnnotationEngine } from "./annotation";
export { Viewport } from "./viewport";
export { bakeTiles, exportMarkupImage, downloadBlob, TILE_MAX } from "./exporter";
