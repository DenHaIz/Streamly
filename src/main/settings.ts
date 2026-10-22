import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { sanitizeNickname } from '@shared/protocol'
import { DEFAULT_HOTKEYS, DEFAULT_SETTINGS, SETTINGS_SCHEMA, type DeepPartial, type EncoderCustom, type HotkeySettings, type QualityProfile, type Settings } from '@shared/types'
import { migratePreset } from '@shared/quality'
import { isAccelerator } from '@shared/hotkeys'
import { deepMerge, JsonFile, type Cipher } from './store'
import type { InputPerms } from '@shared/perms'

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T =>
  list.includes(v as T) ? (v as T) : fallback
export const FPS_OPTIONS = [30, 60, 90, 120, 144, 165, 240]
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

function normalizePerms(p: Partial<InputPerms> | undefined, fb: InputPerms): InputPerms {
  return { keyboard: bool(p?.keyboard, fb.keyboard), mouse: bool(p?.mouse, fb.mouse), gamepad: bool(p?.gamepad, fb.gamepad) }
}

const RESOLUTIONS = ['auto', '720', '1080', '1440', '4K'] as const

/** Качество одного хоста: те же ограничения, что у общих настроек. Неверное — null. */
function normalizeProfile(p: Partial<QualityProfile> | null | undefined): QualityProfile | null {
  if (!p || typeof p !== 'object') return null
  return {
    resolution: oneOf(p.resolution, RESOLUTIONS, 'auto'),
    fps: FPS_OPTIONS.includes(Number(p.fps)) ? Number(p.fps) : 60,
    bitrateKbps: p.bitrateKbps === 0 ? 0 : clampInt(p.bitrateKbps, 500, 150000, 0)
  }
}

function normalizeHostQuality(v: unknown): Record<string, QualityProfile> {
  const out: Record<string, QualityProfile> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [addr, p] of Object.entries(v as Record<string, unknown>).slice(0, 16)) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) continue
    const prof = normalizeProfile(p as Partial<QualityProfile>)
    if (prof) out[addr] = prof
  }
  return out
}

function normalizeEncoder(c: Partial<EncoderCustom> | undefined): EncoderCustom {
  const d = DEFAULT_SETTINGS.host.encoderCustom
  return {
    nvPreset: clampInt(c?.nvPreset, 1, 7, d.nvPreset),
    nvTwoPass: oneOf(c?.nvTwoPass, ['disabled', 'quarter_res', 'full_res'] as const, d.nvTwoPass),
    nvSpatialAq: bool(c?.nvSpatialAq, d.nvSpatialAq),
    amdUsage: oneOf(c?.amdUsage, ['ultralowlatency', 'lowlatency', 'lowlatency_high_quality'] as const, d.amdUsage),
    amdQuality: oneOf(c?.amdQuality, ['speed', 'balanced', 'quality'] as const, d.amdQuality),
    amdRc: oneOf(c?.amdRc, ['vbr_latency', 'cbr', 'vbr_peak'] as const, d.amdRc),
    amdPreanalysis: bool(c?.amdPreanalysis, d.amdPreanalysis),
    amdVbaq: bool(c?.amdVbaq, d.amdVbaq),
    qsvPreset: oneOf(c?.qsvPreset, ['veryfast', 'faster', 'fast', 'medium', 'slow'] as const, d.qsvPreset),
    swPreset: oneOf(c?.swPreset, ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast'] as const, d.swPreset),
    swThreads: clampInt(c?.swThreads, 1, 32, d.swThreads)
  }
}

export { isAccelerator }

function normalizeHotkeys(h: Partial<HotkeySettings> | undefined): HotkeySettings {
  const out = { ...DEFAULT_HOTKEYS }
  for (const k of Object.keys(DEFAULT_HOTKEYS) as (keyof HotkeySettings)[]) {
    if (isAccelerator(h?.[k])) out[k] = h![k]!
  }
  // Одно сочетание на два действия не назначаем: повтор выключается.
  const seen = new Set<string>()
  for (const k of Object.keys(out) as (keyof HotkeySettings)[]) {
    if (!out[k]) continue
    if (seen.has(out[k])) out[k] = ''
    else seen.add(out[k])
  }
  return out
}

export const isDisplayId = (v: unknown): v is string => typeof v === 'string' && /^\{[0-9a-fA-F-]{36}\}$/.test(v)

/** Приводит настройки к допустимым значениям (данные приходят из renderer и с диска). */
export function normalizeSettings(s: Settings): Settings {
  const d = DEFAULT_SETTINGS
  const st = s.stream
  // Версия 1: эксклюзивный полный экран мешал меню Alt+F2, виртуальный монитор был переключателем.
  const v1 = !(Number(s.schema) >= 2)
  const displayMode = v1 && st?.displayMode === 'fullscreen' ? 'borderless' : st?.displayMode
  const legacyVirtual = (s.host as { useVirtualDisplay?: unknown } | undefined)?.useVirtualDisplay === true
  // Версия 2: наборы качества и потолок битрейта переведены под хост с RTX 40/50.
  const v2 = !(Number(s.schema) >= 3)
  const quality = v2 && st ? migratePreset({ resolution: st.resolution, fps: st.fps, bitrateKbps: st.bitrateKbps }) : st
  const hostQualityIn = v2 && s.hostQuality && typeof s.hostQuality === 'object'
    ? Object.fromEntries(Object.entries(s.hostQuality).map(([k, q]) => [k, q && typeof q === 'object' ? migratePreset(q) : q]))
    : s.hostQuality
  const maxBitrateIn = v2 && s.host?.maxBitrateKbps === 20000 ? -1 : s.host?.maxBitrateKbps
  // Версия 3: «высокая» защита от потерь стояла по умолчанию и вместе с потолком 30 Мбит/с перегружала канал.
  // Её не выбирали сами (настройка в дополнительных), поэтому возвращаем обычную.
  const v3 = !(Number(s.schema) >= 4)
  const lossIn = v3 && s.host?.lossProtection === 'high' ? 'normal' : s.host?.lossProtection
  const display = typeof s.host?.display === 'string' ? s.host.display : legacyVirtual ? 'virtual' : d.host.display
  return {
    schema: SETTINGS_SCHEMA,
    onboarded: bool(s.onboarded, false),
    language: oneOf(s.language, ['ru', 'en'] as const, 'ru'),
    theme: oneOf(s.theme, ['system', 'light', 'dark'] as const, 'system'),
    nickname: sanitizeNickname(String(s.nickname ?? '')),
    deviceId: typeof s.deviceId === 'string' && /^[0-9a-f-]{36}$/.test(s.deviceId) ? s.deviceId : randomUUID(),
    autostart: bool(s.autostart, false),
    closeToTray: bool(s.closeToTray, d.closeToTray),
    stream: {
      resolution: oneOf(quality?.resolution, ['auto', '720', '1080', '1440', '4K'] as const, d.stream.resolution),
      fps: FPS_OPTIONS.includes(Number(quality?.fps)) ? Number(quality!.fps) : d.stream.fps,
      bitrateKbps: quality?.bitrateKbps === 0 ? 0 : clampInt(quality?.bitrateKbps, 500, 150000, 0),
      codec: oneOf(st?.codec, ['auto', 'H.264', 'HEVC', 'AV1'] as const, d.stream.codec),
      displayMode: oneOf(displayMode, ['fullscreen', 'borderless', 'windowed'] as const, d.stream.displayMode),
      vsync: bool(st?.vsync, d.stream.vsync),
      framePacing: bool(st?.framePacing, d.stream.framePacing),
      perfOverlay: bool(st?.perfOverlay, d.stream.perfOverlay),
      packetSize: st?.packetSize === 0 ? 0 : clampInt(st?.packetSize, 1024, 1500, 0),
      captureSystemKeys: oneOf(st?.captureSystemKeys, ['never', 'fullscreen', 'always'] as const, d.stream.captureSystemKeys),
      absoluteMouse: bool(st?.absoluteMouse, d.stream.absoluteMouse),
      volume: clampInt(st?.volume, 0, 100, d.stream.volume),
      muteHostChat: bool(st?.muteHostChat, d.stream.muteHostChat),
      autoQuality: bool(st?.autoQuality, d.stream.autoQuality),
      hdr: bool(st?.hdr, d.stream.hdr),
      yuv444: bool(st?.yuv444, d.stream.yuv444),
      singleGamepad: bool(st?.singleGamepad, d.stream.singleGamepad)
    },
    host: {
      maxPlayers: clampInt(s.host?.maxPlayers, 1, 4, d.host.maxPlayers),
      defaultPerms: normalizePerms(s.host?.defaultPerms, d.host.defaultPerms),
      // id монитора в Apollo — GUID в фигурных скобках.
      display: display === 'primary' || display === 'virtual' || isDisplayId(display) ? display : d.host.display,
      virtualOnly: bool(s.host?.virtualOnly, d.host.virtualOnly),
      maxBitrateKbps: maxBitrateIn === 0 || maxBitrateIn === -1 ? maxBitrateIn : clampInt(maxBitrateIn, 2000, 150000, d.host.maxBitrateKbps),
      keepHostAudio: bool(s.host?.keepHostAudio, d.host.keepHostAudio),
      chatRouting: bool(s.host?.chatRouting, d.host.chatRouting),
      lossProtection: oneOf(lossIn, ['normal', 'high'] as const, d.host.lossProtection),
      encoderPreset: oneOf(s.host?.encoderPreset, ['latency', 'balanced', 'quality', 'custom'] as const, d.host.encoderPreset),
      encoderCustom: normalizeEncoder(s.host?.encoderCustom),
      notifyRequests: bool(s.host?.notifyRequests, d.host.notifyRequests),
      autoStartHosting: bool(s.host?.autoStartHosting, d.host.autoStartHosting),
      inviteAutoAdmit: bool(s.host?.inviteAutoAdmit, d.host.inviteAutoAdmit),
      requestSound: bool(s.host?.requestSound, d.host.requestSound),
      gameNotify: bool(s.host?.gameNotify, d.host.gameNotify)
    },
    hostQuality: normalizeHostQuality(hostQualityIn),
    updates: {
      auto: bool(s.updates?.auto, d.updates.auto),
      skipped: typeof s.updates?.skipped === 'string' && /^[\w.+-]{0,32}$/.test(s.updates.skipped) ? s.updates.skipped : ''
    },
    showAdvanced: bool(s.showAdvanced, d.showAdvanced),
    hotkeys: normalizeHotkeys(s.hotkeys),
    recentHosts: Array.isArray(s.recentHosts)
      ? s.recentHosts
          .filter((h) => h && typeof h.address === 'string' && /^[\d.]+$/.test(h.address))
          .slice(0, 8)
          .map((h) => ({ address: h.address, name: sanitizeNickname(String(h.name ?? h.address)), lastUsed: Number(h.lastUsed) || 0 }))
      : []
  }
}

export class SettingsService extends EventEmitter {
  private readonly file: JsonFile<Settings>

  constructor(dir: string, systemLocale: string) {
    super()
    this.file = new JsonFile<Settings>(join(dir, 'settings.json'), () => ({
      ...structuredClone(DEFAULT_SETTINGS),
      language: systemLocale.toLowerCase().startsWith('ru') ? 'ru' : 'en',
      nickname: sanitizeNickname(hostname()),
      deviceId: randomUUID()
    }))
    this.file.set(normalizeSettings(this.file.get()))
  }

  get(): Settings {
    return this.file.get()
  }

  /**
   * Частичное обновление. hostQuality — словарь по адресам: новые адреса добавляются,
   * null удаляет запись (deepMerge сам новые ключи не добавляет).
   */
  update(patch: DeepPartial<Settings>): Settings {
    const cur = this.file.get()
    const { hostQuality, ...rest } = patch as DeepPartial<Settings> & { hostQuality?: Record<string, Partial<QualityProfile> | null> }
    const merged = deepMerge(cur, rest)
    if (hostQuality && typeof hostQuality === 'object') {
      const hq: Record<string, unknown> = { ...cur.hostQuality }
      for (const [addr, p] of Object.entries(hostQuality)) {
        if (p === null) delete hq[addr]
        else hq[addr] = { ...(cur.hostQuality[addr] ?? {}), ...p }
      }
      merged.hostQuality = hq as Record<string, QualityProfile>
    }
    const next = normalizeSettings(merged)
    this.file.set(next)
    this.emit('change', next)
    return next
  }

  rememberHost(address: string, name: string): void {
    const rest = this.get().recentHosts.filter((h) => h.address !== address)
    this.update({ recentHosts: [{ address, name, lastUsed: Date.now() }, ...rest].slice(0, 8) })
  }
}

// ---------- Секреты ----------

export interface TrustedFriend {
  deviceId: string
  nickname: string
  /** SHA-256 от токена доверия; сам токен хранится только у друга. */
  tokenHash?: string
  apolloUuid?: string
  apolloName?: string
  perms: InputPerms
  trusted: boolean
  addedAt: number
  lastSeen?: number
}

export interface Secrets {
  apollo?: { username: string; password: string }
  /** Известные хосту друзья (по deviceId). */
  friends: Record<string, TrustedFriend>
  /** Токены доверия, выданные нам хостами (по адресу хоста). */
  hostTokens: Record<string, string>
}

export class SecretsService {
  private readonly file: JsonFile<Secrets>

  constructor(dir: string, cipher?: Cipher) {
    this.file = new JsonFile<Secrets>(join(dir, cipher ? 'secrets.bin' : 'secrets.json'), () => ({ friends: {}, hostTokens: {} }), cipher)
    // Форма данных с диска не гарантирована: словари обязаны быть объектами.
    const s = this.file.get()
    const isDict = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v)
    if (!isDict(s.friends) || !isDict(s.hostTokens)) {
      this.file.set({ ...s, friends: isDict(s.friends) ? s.friends : {}, hostTokens: isDict(s.hostTokens) ? s.hostTokens : {} })
    }
  }

  get(): Secrets {
    return this.file.get()
  }

  update(fn: (s: Secrets) => void): Secrets {
    return this.file.update(fn)
  }
}

