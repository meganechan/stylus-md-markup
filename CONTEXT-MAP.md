# Context Map — one repo, two surfaces, one engine

This repo hosts **two app surfaces** that share a single **ink engine** (ADR-0002).
Each surface deploys as its own coolify app from the same image, holding only its
own secret.

```
            ┌─────────────────────────── web/src/engine/ ───────────────────────────┐
            │  ink core (UI- & backend-agnostic): types · AnnotationEngine ·         │
            │  Viewport (pan/zoom) · pointer routing · exporter (flatten/tiles)      │
            └───────────────▲───────────────────────────────────▲───────────────────┘
                            │ annotates a backdrop              │
        ┌───────────────────┴────────────┐      ┌───────────────┴────────────────────┐
        │  Stylus Markup  (surface 1)     │      │  Review Desk  (surface 2)           │
        │  `/`  (index.html)              │      │  `/review` + `/r/:token` (review…)  │
        │  markdown/image backdrop →      │      │  read-only md backdrop + ink overlay │
        │  annotate → tiles → te-kb       │      │  + comment → Decision → maw          │
        │  secret: TEKB_PASTE_TOKEN       │      │  secret: MAW_REVIEW_DESK_SECRET      │
        │  host: ink.notscam.space        │      │  host: review.notscam.space          │
        └─────────────────────────────────┘      └──────────────────────────────────────┘
```

## Shared vocabulary — the Engine

- **Stroke / InkDoc** — vector pen marks in logical page coordinates (DPR- and
  zoom-independent). The only thing the engine persists.
- **AnnotationEngine** — the `<canvas>` overlay: pen / highlighter / stroke-eraser,
  undo/redo, draw/flatten.
- **Viewport** — pan/zoom transform of the fixed-width page; maps screen↔content.
- **Backdrop provider** — produces the thing being annotated. NOT part of the
  engine (the engine annotates a backdrop, doesn't make one). Today the only
  provider is the **markdown renderer** (`web/src/markdown.ts`); image / `ui`
  providers can be added without touching the engine.

## Domain 1 — Stylus Markup (`docs` / ADR-0001, 0003–0006 in pm1-oracle)

Review a markdown/image by hand → annotate → bake **Tiles** → store a **Markup
Job** → post a ref back to **te-kb**. Source is read-only. LIVE: ink.notscam.space.
Terminology: Backdrop · Markup Job · Tile · Sidecar. See README.

## Domain 2 — Review Desk (ADR-0002 below)

A human-in-the-loop **approval gate**. An **Asker** (AI/Oracle) submits a markdown
**ReviewRequest** via maw; the desk shows it **read-only** with a **pen/ink
overlay** + typed **comment**; the human (**Reviewer**) issues a **Decision**
(Approve / Reject / Return). The desk **never edits** the md — the Asker owns and
revises it across **Rounds** (linked by **ThreadId**). The desk backend holds the
maw secret and proxies the review plane (browser never touches maw directly).
Domain truth: `eq3-oracle/ψ/writing/review-desk/` (CONTEXT, maw-endpoint-contract).

## ADRs in this repo

- `docs/adr/0002-desk-comments-never-edits.md` — desk gives feedback (comment +
  pen), never edits; folds into this repo to reuse the ink engine.

(The Stylus-side ADRs 0001/0003–0006 live in `pm1-oracle/docs/adr/`.)
