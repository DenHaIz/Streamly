// Рисует resources/icon.png (256×256): светло-фиолетовый скруглённый квадрат с пиксельным геймпадом.
// Пиксели геймпада и цвета — из src/shared/logo.json (тот же логотип в интерфейсе).
// Без зависимостей: пиксели считаются вручную, PNG собирается через zlib.
import { deflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const logo = JSON.parse(readFileSync(join(root, 'src', 'shared', 'logo.json'), 'utf8'))

const S = 256
const SS = 4 // сглаживание краёв скруглённого квадрата: 4×4 подвыборки на пиксель
const px = Buffer.alloc(S * S * 4)

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const BG = hex(logo.colors.background)
const BODY = hex(logo.colors.body)
const ACCENT = hex(logo.colors.accent)

const COLS = logo.grid[0].length
const ROWS = logo.grid.length
const CELL = 12 // размер «пикселя» геймпада
const OX = Math.round((S - COLS * CELL) / 2)
const OY = Math.round((S - ROWS * CELL) / 2) + 4 // чуть ниже центра: рукояти визуально «тяжелее»

function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

/** Цвет точки: [r,g,b,a] или null (прозрачно). */
function sample(x, y) {
  if (!roundRect(x, y, 8, 8, 248, 248, 56)) return null
  const col = Math.floor((x - OX) / CELL)
  const row = Math.floor((y - OY) / CELL)
  const ch = logo.grid[row]?.[col]
  if (ch === '#') return [...BODY, 255]
  if (ch === 'o') return [...ACCENT, 255]
  return [...BG, 255]
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)
        if (!c) continue
        r += c[0]
        g += c[1]
        b += c[2]
        a += 1
      }
    }
    const i = (y * S + x) * 4
    if (a) {
      px[i] = r / a
      px[i + 1] = g / a
      px[i + 2] = b / a
    }
    px[i + 3] = (a / (SS * SS)) * 255
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8 // глубина
ihdr[9] = 6 // RGBA
const raw = Buffer.alloc((S * 4 + 1) * S)
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'icon.png')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log(`icon → ${out}`)
