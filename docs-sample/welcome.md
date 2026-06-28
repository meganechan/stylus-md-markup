# Stylus MD Markup — ตัวอย่างเอกสาร

> เอกสารนี้ถูก **mount แบบ read-only** — เครื่องมือไม่แก้ไฟล์ต้นฉบับ
> เขียนรีวิวทับด้วยปากกา แล้ว Export เป็นรูปส่งกลับให้คนเขียนแก้เอง

## วิธีใช้

1. เลือกไฟล์ `.md` จากแถบซ้าย
2. เขียน/ไฮไลต์/ขีดฆ่า ทับ Preview ด้วยปากกาหรือนิ้ว
3. กด **Export PNG** เพื่อได้ Markup Image

## รองรับ Markdown

- **ตัวหนา**, *ตัวเอียง*, ~~ขีดฆ่า~~, `inline code`
- ลิงก์: [Oracle](https://example.com)
- รายการซ้อน:
  1. ขั้นที่หนึ่ง
  2. ขั้นที่สอง
     - ย่อย ก
     - ย่อย ข

## ตาราง

| ฟีเจอร์ | สถานะ | หมายเหตุ |
|---------|:-----:|----------|
| Render เอง (markdown-it) | ✅ | heading/list/table/code |
| ปากกา + สี | ✅ | ดำ/แดง/น้ำเงิน |
| ยางลบ + undo/redo | ✅ | stroke-level |
| ไฮไลต์ | ✅ | translucent |
| Export PNG | ✅ | html2canvas client-side |
| Sidecar autosave | ✅ | `<file>.md.ink.json` |

## โค้ด

```typescript
function greet(name: string): string {
  return `สวัสดี, ${name}!`;
}
console.log(greet("worker1"));
```

```python
def fib(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```

## Blockquote

> "กระจกไม่แกล้งเป็นคน" — a mirror doesn't pretend to be a person.
>
> Oracle render เอกสารให้สวย แล้วให้คุณเขียนทับด้วยลายมือ.

---

ลองเขียนทับบรรทัดนี้ดู → ✍️ ____________________
