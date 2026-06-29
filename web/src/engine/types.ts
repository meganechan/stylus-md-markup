// Ink engine types — the vector stroke model shared by every surface that uses
// the engine (the markup tool and the review desk). UI- and backend-agnostic.

export type Tool = "pen" | "highlighter" | "eraser";

export interface StrokePoint {
  x: number;
  y: number;
}

export interface Stroke {
  tool: Tool;
  color: string;
  width: number;
  points: StrokePoint[];
}

// A complete ink overlay: vector strokes authored against a logical page.
export interface InkDoc {
  version: number;
  strokes: Stroke[];
  pageWidth?: number;
  pageHeight?: number;
}
