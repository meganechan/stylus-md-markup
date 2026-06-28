# Stylus Markup Service

> วาดรีวิวด้วยลายมือบน **Backdrop** (markdown หรือรูป) → เก็บเป็น **Markup Job** บน server → consumer (คน · Claude · te-kb) มา pull.
> ต้นฉบับ Backdrop **read-only** · strokes เป็น vector (แก้ต่อได้) · baked tiles ≤1500px ให้ vision อ่านคม · ไม่มี OCR.
> v2 ของ POC `stylus-md-markup`. ศัพท์/เหตุผล: `CONTEXT.md` + ADR-0001..0005 (pm1-oracle).

## Spine

```
Backdrop (render md  |  upload รูป  |  ดึง md จาก te-kb ?src)
  → Stylus editor วาด Ink Overlay (vector strokes, ไม่พึ่ง pressure)
  → Save = สร้าง Markup Job: { strokes + backdrop + md text? + baked tiles }
  → consumer pull:  คน/Claude = tiles + md-text link · te-kb = host tiles + ลิงก์ md
```

## Editor (no sidebar) — เปิด Backdrop ทีละตัว

| เปิดด้วย | ความหมาย |
|----------|----------|
| `?doc=<path>` | markdown จาก mount (DOCS_DIR, read-only) |
| `?src=<raw-md-url>` | markdown ภายนอกจาก te-kb (ปุ่ม edit) — fetch client-side, host allowlist `api.kb.notscam.space`, ใส่ `?raw=1`, จัดการ 410/404 |
| `?job=<id>` | เปิด Markup Job เดิม — strokes กลับมาแก้ต่อได้ |
| ไม่มี param | หน้า intake → อัปโหลดรูปเป็น Source Image |

## Stack

- **Frontend**: Vite + vanilla TS · `markdown-it` + `highlight.js` + `github-markdown-css` · `html2canvas`
- **Backend**: Bun + Hono — job store + static serve, single port `0.0.0.0`
- **Container**: single Dockerfile, bind-mount `DOCS_DIR` (`:ro`) + `JOBS_DIR`

## API

| Method | Path | หน้าที่ |
|--------|------|---------|
| GET | `/api/doc?path=` | raw md ของ Backdrop (md จาก mount) |
| GET | `/static/*` | serve DOCS_DIR (รูป local ใน md) |
| POST | `/api/jobs` | สร้าง/อัปเดต Markup Job (multipart: `meta`,`strokes`,`backdrop?`,`tile`×n) |
| GET | `/api/jobs/:id` | manifest: `{type, mdTextUrl, backdropUrl, tiles[], strokesUrl, resultUrl, backdropRef}` |
| GET | `/api/jobs/:id/md` | raw md text (404 ถ้าเป็น image job) |
| GET | `/api/jobs/:id/strokes` | vector Ink Overlay (เปิดแก้ต่อ) |
| GET | `/api/jobs/:id/backdrop` | Source Image (image job) |
| GET | `/api/jobs/:id/tiles/:n` | baked Tile png |
| POST | `/api/jobs/:id/publish` | post-back: สร้าง paste ใน te-kb (md+tiles+edit link) คืน url (ADR-0006) |
| GET | `/j/:id` | หน้า result สรุป (tiles + ลิงก์ md) ให้คนเปิด/แปะ |

**Output reps (ADR-0003)**: (i) vector strokes = ความจริง · (ii) baked tiles ≤1500px (long-edge) · (iii) md text เก็บ server.

**Storage**: Job อยู่ใน `JOBS_DIR/<id>/` (`job.json`,`strokes.json`,`md.txt`,`backdrop.png`,`tiles/`). อัปเดต job = id เดิม (link นิ่ง) + archive strokes เดิมไว้ `strokes.history/` (Nothing-is-Deleted). Backdrop source ไม่ถูก mutate.

**Env**: `DOCS_DIR` (md backdrop, :ro) · `JOBS_DIR` (job store, default `./jobs-data`) · `PORT` (8080) · `MAX_UPLOAD` (10MB).

**Post-back to te-kb (ADR-0006)** — Save → publish ผลเป็น paste ใน te-kb (โชว์ markup ใน KB). เป็น **server-side** ล้วน; token อยู่ env เท่านั้น ไม่โผล่ frontend.
- `TEKB_PASTE_TOKEN` — paste-only token (ไม่ตั้ง → publish ถูก skip เงียบ, job local ยังเซฟปกติ)
- `TEKB_BASE_URL` (default `https://api.kb.notscam.space`) · `PUBLIC_BASE_URL` (default `https://ink.notscam.space`, ใช้ทำ absolute tile/edit url)
- `POSTBACK_TTL_HOURS` (default `720` = 30d; te-kb clamp [1,2160])
- paste content = md text + baked tiles (`![](abs-url)`) + ลิงก์ `?job=` แก้ต่อ · guard content ≤1MB · ทุก publish = paste ใหม่ (immutable) เก็บ `pastes[]` ใน job (Nothing-is-Deleted)

## Run — Docker

```bash
docker compose up --build
# หรือชี้ docs ของคุณเอง + host port:  DOCS_HOST=/path/to/docs HOST_PORT=8095 docker compose up --build
```
เปิด `http://<host-ip>:<port>/` จากมือถือ/แท็บเล็ต.

## Run — Dev (hot reload)

```bash
bun install
DOCS_DIR=./docs-sample JOBS_DIR=./jobs-data bun run dev:server   # :8080
cd web && bun install && bun run dev                            # :5173 (proxy /api,/static)
```

## เครื่องมือ (Standard pen toolset)

ปากกา · สี ดำ/แดง/น้ำเงิน · ไฮไลต์ · ยางลบ (stroke-level) · ปรับหนา · undo/redo · ล้าง ·
✋ นิ้ว วาด/เลื่อน · ⊕ พอดีจอ · ⬇️ PNG · 📤 KB (save + ลง te-kb) · 💾 Save Job.
Pan/zoom = 2 นิ้ว (ใช้ได้ขณะปากกาวาด) · desktop ⌘/Ctrl+scroll = zoom · ⌘/Ctrl+S = save.

## Acceptance v2 (mapping)

| # | ข้อ | ที่อยู่ |
|---|-----|--------|
| 1 | editor ไม่มี sidebar; backdrop จาก md param + upload รูป | `main.ts` boot · intake |
| 2 | วาด markup ได้ (เหมือน POC) | `annotation.ts` |
| 3 | Save → job มี strokes + md text + baked tiles ≤1500px | `exporter.ts bakeTiles` · `POST /api/jobs` |
| 4 | `GET /api/jobs/:id` คืน tiles + urls ครบ | `server manifestToApi` |
| 5 | เปิด job เดิม → แก้เส้นต่อได้ | `openJob` · `/strokes` |
| 6 | ต้นฉบับ backdrop ไม่ mutate | docs :ro · job store แยก |
| 7 | image UI (ไม่มี md) → tiles อย่างเดียว | image job · `/md` = 404 |
| + | te-kb edit: `?src` external md (allowlist + 410/404) | `api.ts fetchExternalMd` |

## Out of scope (worker1)

te-kb consumption (utils-pm) · monkut/Discord push (phase 2, ADR-0004) · te-kb live overlay engine.

---
🤖 build โดย worker1 จาก tony → worker1-oracle
