import { memo } from 'react'
import logo from '@shared/logo.json'

// Тот же рисунок, что и в иконке приложения (scripts/make-icon.mjs): квадрат 240×240,
// «пиксель» геймпада 12 единиц, геймпад по центру с небольшим сдвигом вниз.
const VIEW = 240
const CELL = 12
const COLS = logo.grid[0].length
const ROWS = logo.grid.length
const OX = (VIEW - COLS * CELL) / 2
const OY = (VIEW - ROWS * CELL) / 2 + 4

/** Горизонтальные отрезки одного цвета: меньше элементов в SVG, чем по прямоугольнику на пиксель. */
function runs(ch: string): { x: number; y: number; w: number }[] {
  const out: { x: number; y: number; w: number }[] = []
  logo.grid.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      if (row[x] !== ch) {
        x++
        continue
      }
      const from = x
      while (row[x] === ch) x++
      out.push({ x: from, y, w: x - from })
    }
  })
  return out
}

const BODY = runs('#')
const ACCENT = runs('o')

/** Логотип Streamly: пиксельный геймпад на светло-фиолетовом скруглённом квадрате. */
export const PixelLogo = memo(function PixelLogo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox={`0 0 ${VIEW} ${VIEW}`} shapeRendering="crispEdges" aria-hidden="true">
      <rect width={VIEW} height={VIEW} rx={56} fill={logo.colors.background} shapeRendering="geometricPrecision" />
      {BODY.map((r) => (
        <rect key={`b${r.x}-${r.y}`} x={OX + r.x * CELL} y={OY + r.y * CELL} width={r.w * CELL} height={CELL} fill={logo.colors.body} />
      ))}
      {ACCENT.map((r) => (
        <rect key={`a${r.x}-${r.y}`} x={OX + r.x * CELL} y={OY + r.y * CELL} width={r.w * CELL} height={CELL} fill={logo.colors.accent} />
      ))}
    </svg>
  )
})
