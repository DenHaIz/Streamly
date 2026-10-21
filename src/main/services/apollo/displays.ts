import type { HostDisplay } from '@shared/types'

const MARKER = 'Currently available display devices:'

/** Вырезает JSON-массив, начинающийся в позиции start (с учётом строк и вложенности). */
function sliceJsonArray(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '[') depth++
    else if (ch === ']' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

const num = (v: unknown): number => {
  if (typeof v === 'number') return v
  // libdisplaydevice: {"type":"double","value":59.94} или {"type":"rational","value":{"numerator":..,"denominator":..}}
  const o = v as { type?: string; value?: unknown } | undefined
  if (o?.type === 'double' && typeof o.value === 'number') return o.value
  const r = o?.value as { numerator?: number; denominator?: number } | undefined
  if (o?.type === 'rational' && r?.numerator && r.denominator) return r.numerator / r.denominator
  return 0
}

/**
 * Мониторы из лога Apollo: при запуске он пишет «Currently available display devices:» и JSON
 * (device_id, display_name, friendly_name, info). id нужен для настройки output_name.
 * Берётся последняя запись; неактивные мониторы (info: null) и виртуальные дисплеи SudoVDA пропускаются.
 */
export function parseDisplayDevices(log: string): HostDisplay[] {
  const at = log.lastIndexOf(MARKER)
  if (at < 0) return []
  const open = log.indexOf('[', at + MARKER.length)
  if (open < 0) return []
  const raw = sliceJsonArray(log, open)
  if (!raw) return []
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  const out: HostDisplay[] = []
  for (const d of list as Array<Record<string, unknown>>) {
    const id = typeof d?.device_id === 'string' ? d.device_id : ''
    const info = d?.info as Record<string, unknown> | null | undefined
    if (!/^\{[0-9a-fA-F-]{36}\}$/.test(id) || !info) continue
    const name = typeof d.friendly_name === 'string' && d.friendly_name.trim() ? d.friendly_name.trim().slice(0, 64) : ''
    if (/sudomaker|sudovda|virtual display/i.test(name)) continue
    const res = info.resolution as { width?: number; height?: number } | undefined
    out.push({
      id,
      name,
      displayName: typeof d.display_name === 'string' ? d.display_name.slice(0, 32) : '',
      primary: info.primary === true,
      width: Number(res?.width) || 0,
      height: Number(res?.height) || 0,
      fps: Math.round(num(info.refresh_rate))
    })
  }
  return out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.displayName.localeCompare(b.displayName))
}
