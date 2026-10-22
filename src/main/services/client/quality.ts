import type { QualityProfile, Resolution, StreamSettings } from '@shared/types'

/** Доля замеренного канала под видео: остальное — избыточные пакеты (FEC до 30%), звук и запас на всплески. */
const CHANNEL_SHARE = 0.6
const MIN_BITRATE = 2500
const RES_ORDER: Resolution[] = ['720', '1080', '1440', '4K', 'auto']

/** Меньшее из двух разрешений («авто» считается самым большим: экран клиента). */
function lowerRes(a: Resolution, b: Resolution): Resolution {
  return RES_ORDER.indexOf(a) <= RES_ORDER.indexOf(b) ? a : b
}

/** Разрешение, которое разумно вытянуть на таком битрейте (Moonlight по умолчанию: 1080p60 ≈ 20 Мбит/с). */
function resolutionFor(bitrateKbps: number): Resolution {
  if (bitrateKbps < 6000) return '720'
  if (bitrateKbps < 15000) return '1080'
  return 'auto'
}

/**
 * Автоподбор качества по замеру канала от хоста: битрейт — 60% замера (но не выше потолка хоста),
 * разрешение и частота — по битрейту, не выше того, что игрок выбрал сам.
 */
export function autoProfile(speedMbps: number, base: Pick<StreamSettings, 'resolution' | 'fps'>, capKbps: number): QualityProfile {
  const cap = capKbps > 0 ? capKbps : 80000
  const budget = Math.round((speedMbps * 1000 * CHANNEL_SHARE) / 500) * 500
  const bitrateKbps = Math.max(MIN_BITRATE, Math.min(budget, cap))
  return profileFor(bitrateKbps, base)
}

function profileFor(bitrateKbps: number, base: Pick<StreamSettings, 'resolution' | 'fps'>): QualityProfile {
  return {
    resolution: lowerRes(base.resolution, resolutionFor(bitrateKbps)),
    fps: bitrateKbps < 4000 ? Math.min(base.fps, 30) : base.fps,
    bitrateKbps
  }
}

/** На ступень ниже (битрейт ×0,7) после устойчивой плохой связи. null — ниже уже некуда. */
export function lowerProfile(p: QualityProfile, base: Pick<StreamSettings, 'resolution' | 'fps'>): QualityProfile | null {
  if (p.bitrateKbps > 0 && p.bitrateKbps <= MIN_BITRATE) return null
  const from = p.bitrateKbps > 0 ? p.bitrateKbps : 20000
  return profileFor(Math.max(MIN_BITRATE, Math.round((from * 0.7) / 500) * 500), base)
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}

/**
 * Похоже ли на ретранслятор Radmin: прямое соединение внутри страны обычно даёт 5–40 мс.
 * Высокая задержка или медленный канал при средней задержке — повод проверить тип соединения в Radmin.
 */
export function relaySuspect(rtts: number[], speedMbps?: number): boolean {
  if (rtts.length < 3) return false
  const m = median(rtts)
  return m >= 80 || (speedMbps !== undefined && speedMbps < 10 && m >= 35)
}
