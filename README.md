# Stylus MD Markup

> รีวิวเอกสาร markdown ด้วยลายมือ — render `.md` สวย → เขียนปากกาทับ → export เป็นรูป (PNG) ส่งกลับ.
> **ต้นฉบับ `.md` ไม่ถูกแก้** (read-only). ไม่มี OCR, ไม่เขียนกลับเข้า md. (ดู `CONTEXT`/ADR ใน pm1-oracle)

POC ตาม spec `stylus-md-markup-spec.md v0.1`.

## Workflow

```
.md (mount, read-only) → render Preview (markdown-it, หน้ากว้างคงที่ 800px)
   → เขียน/ไฮไลต์/ลบ ทับ (Annotation canvas overlay, Pointer Events, ไม่พึ่ง pressure)
   → flatten ฝั่ง client (html2canvas) → Markup Image (PNG) → download/share
strokes autosave เป็น sidecar  <file>.md.ink.json  ข้างไฟล์ (เปิดใหม่/ re-export ได้)
```

## Stack

- **Frontend**: Vite + vanilla TS · `markdown-it` + `highlight.js` + `github-markdown-css` · `html2canvas`
- **Backend**: Bun + Hono — static serve + 3 endpoint
- **Container**: single Dockerfile, 1 port, listen `0.0.0.0`, bind-mount `DOCS_DIR`

## API

| Method | Path | หน้าที่ |
|--------|------|---------|
| GET | `/api/files` | list `.md` ใน mount (recursive) |
| GET | `/api/doc?path=` | raw markdown ของ Document |
| GET | `/api/ink?path=` | โหลด Sidecar strokes |
| PUT | `/api/ink?path=` | บันทึก Sidecar (`<file>.md.ink.json`) |
| GET | `/static/*` | serve ไฟล์ใน mount (รูป local ใน md) |

## Run — Docker (วิธีหลักของ POC)

```bash
# review เอกสารตัวอย่างที่แถมมา
docker compose up --build

# หรือชี้ไปโฟลเดอร์ .md ของคุณเอง
DOCS_HOST=/path/to/your/docs docker compose up --build
```

เปิด `http://<host-ip>:8080` จาก iPhone / Galaxy Z Fold (เครื่องเดียวกัน LAN).

### Docker (ไม่ใช้ compose)

```bash
docker build -t stylus-md-markup .
docker run --rm -p 8080:8080 -v /path/to/docs:/docs stylus-md-markup
```

## Run — Dev (hot reload)

```bash
# 1) backend (Bun) — serve API + sample docs
bun install
DOCS_DIR=./docs-sample bun run dev:server      # :8080

# 2) frontend (Vite) — อีก terminal
cd web && bun install && bun run dev            # :5173 (proxy /api,/static -> :8080)
```

เปิด `http://localhost:5173`.

## เครื่องมือปากกา (Standard toolset)

ปากกา · สี ดำ/แดง/น้ำเงิน · ไฮไลต์ · ยางลบ (stroke-level) · ปรับความหนา · undo/redo · ล้างทั้งหมด ·
ปุ่ม ✋ สลับ “นิ้ว = วาด / นิ้ว = เลื่อน” · ⊕ พอดีจอ · Export PNG.

**Pan/zoom**: สองนิ้ว = เลื่อน+ซูม (ใช้ได้แม้ปากกากำลังวาด). บน desktop: ⌘/Ctrl + scroll = ซูม.
ปากกา (pointerType=pen) วาดเสมอ — แยกจากนิ้วด้วย Pointer Events.

## POC acceptance (mapping)

| # | ข้อ | ที่อยู่ในโค้ด |
|---|-----|--------------|
| 1 | list `.md` จาก mount | `server` `/api/files` · `main.ts refreshFiles` |
| 2 | render สวย (heading/table/code/รูป) | `markdown.ts` |
| 3 | เขียนปากกา (≥2 สี, ลบ, undo, ไฮไลต์, ปรับหนา) | `annotation.ts` · toolbar |
| 4 | pan/zoom นิ้ว ขณะปากกาวาด | `viewport.ts` · pointer routing ใน `main.ts` |
| 5 | Export PNG รวม preview + รอยเขียน | `exporter.ts` |
| 6 | เปิดใหม่ strokes กลับมา | sidecar `/api/ink` · autosave |
| 7 | ต้นฉบับ `.md` ไม่ถูกแตะ | server เขียนเฉพาะ `*.md.ink.json` |

## Out of scope (POC)

Embedded Ink เขียนกลับเข้า md · OCR ลายมือ→text · multi-user/auth · pressure/tilt · shape/text/sticky ·
integrate เข้าระบบ te-kb (เฟสถัดไป).

---
🤖 build โดย worker1 จาก tony → worker1-oracle
