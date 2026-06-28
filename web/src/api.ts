// Thin client for the backend. All Document paths are relative to DOCS_DIR.

export interface DocPayload {
  path: string;
  dir: string;
  text: string;
}

export interface StrokePoint {
  x: number;
  y: number;
}

export type Tool = "pen" | "highlighter" | "eraser";

export interface Stroke {
  tool: Tool;
  color: string;
  width: number;
  points: StrokePoint[];
}

export interface InkDoc {
  version: number;
  strokes: Stroke[];
  // logical page dimensions the strokes were authored against
  pageWidth?: number;
  pageHeight?: number;
}

export async function listFiles(): Promise<{ docsDir: string; files: string[] }> {
  const r = await fetch("/api/files");
  if (!r.ok) throw new Error("failed to list files");
  return r.json();
}

export async function loadDoc(path: string): Promise<DocPayload> {
  const r = await fetch(`/api/doc?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error("failed to load document");
  return r.json();
}

export async function loadInk(path: string): Promise<InkDoc> {
  const r = await fetch(`/api/ink?path=${encodeURIComponent(path)}`);
  if (!r.ok) return { version: 1, strokes: [] };
  return r.json();
}

export async function saveInk(path: string, ink: InkDoc): Promise<void> {
  await fetch(`/api/ink?path=${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ink),
  });
}
