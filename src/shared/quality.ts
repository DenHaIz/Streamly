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
 * «Авто» для потолка битрейта на игрока. Одному — 20 Мбит/с, как в 0.1, которая работала через Radmin
 * без обрывов (в 0.2–0.5 было 30, и вместе с FEC 30% поток вырос с ~24 до ~39 Мбит/с — обрывы и рывки).
 * Исходящий канал хоста общий, поэтому с каждым игроком потолок ниже: всего ~20–40 Мбит/с.
 */
export function autoBitrateCap(players: number): number {
  return players <= 1 ? 20000 : players === 2 ? 15000 : players === 3 ? 12000 : 10000
}

export const AUTO_BITRATE_CAP_MAX = 20000
