import type { QualityProfile } from './types'

export type Preset = 'economy' | 'balanced' | 'high'

/**
 * Готовые наборы качества (настройки и меню Alt+F2). Подобраны под хост с NVIDIA RTX 40/50:
 * кодировщик без труда тянет 60–120 FPS, поэтому даже «Экономно» остаётся 60 FPS, а экономит
 * разрешение и битрейт. Частота в любом случае не выше монитора хоста и экрана игрока.
 */
export const PRESETS: Record<Preset, QualityProfile> = {
  economy: { resolution: '720', fps: 60, bitrateKbps: 6000 },
  balanced: { resolution: 'auto', fps: 60, bitrateKbps: 0 },
  high: { resolution: 'auto', fps: 120, bitrateKbps: 50000 }
}

/** Наборы версий 0.1–0.2: при обновлении настроек они переводятся в новые. */
export const LEGACY_PRESETS: Partial<Record<Preset, QualityProfile>> = {
  economy: { resolution: '720', fps: 30, bitrateKbps: 5000 },
  high: { resolution: 'auto', fps: 60, bitrateKbps: 40000 }
}

export function currentPreset(st: QualityProfile): Preset | 'custom' {
  const hit = (Object.keys(PRESETS) as Preset[]).find((k) => {
    const p = PRESETS[k]
    return p.resolution === st.resolution && p.fps === st.fps && p.bitrateKbps === st.bitrateKbps
  })
  return hit ?? 'custom'
}

/** Старый набор → новый (остальное без изменений). */
export function migratePreset<T extends QualityProfile>(q: T): T {
  for (const [name, old] of Object.entries(LEGACY_PRESETS) as [Preset, QualityProfile][]) {
    if (old.resolution === q.resolution && old.fps === q.fps && old.bitrateKbps === q.bitrateKbps) return { ...q, ...PRESETS[name] }
  }
  return q
}

/**
 * «Авто» для потолка битрейта на игрока: 30 Мбит/с, пока игроков один-два, 20 — при трёх-четырёх
 * (исходящий канал хоста и FEC 30% делятся на всех).
 */
export function autoBitrateCap(players: number): number {
  return players <= 2 ? 30000 : 20000
}

export const AUTO_BITRATE_CAP_MAX = 30000
