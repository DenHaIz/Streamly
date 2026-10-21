import type { StreamSettings } from '@shared/types'

export type Preset = 'economy' | 'balanced' | 'high'

/** Готовые наборы качества: в настройках и в меню Alt+F2. */
export const PRESETS: Record<Preset, Pick<StreamSettings, 'resolution' | 'fps' | 'bitrateKbps'>> = {
  economy: { resolution: '720', fps: 30, bitrateKbps: 5000 },
  balanced: { resolution: 'auto', fps: 60, bitrateKbps: 0 },
  high: { resolution: 'auto', fps: 60, bitrateKbps: 40000 }
}

export function currentPreset(st: Pick<StreamSettings, 'resolution' | 'fps' | 'bitrateKbps'>): Preset | 'custom' {
  const hit = (Object.keys(PRESETS) as Preset[]).find((k) => {
    const p = PRESETS[k]
    return p.resolution === st.resolution && p.fps === st.fps && p.bitrateKbps === st.bitrateKbps
  })
  return hit ?? 'custom'
}
