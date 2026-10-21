import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { sanitizeNickname } from '@shared/protocol'
import { DEFAULT_SETTINGS, type DeepPartial, type Settings } from '@shared/types'
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

/** Приводит настройки к допустимым значениям (данные приходят из renderer и с диска). */
export function normalizeSettings(s: Settings): Settings {
  const d = DEFAULT_SETTINGS
  const st = s.stream
  return {
    onboarded: bool(s.onboarded, false),
    language: oneOf(s.language, ['ru', 'en'] as const, 'ru'),
    theme: oneOf(s.theme, ['system', 'light', 'dark'] as const, 'system'),
    nickname: sanitizeNickname(String(s.nickname ?? '')),
    deviceId: typeof s.deviceId === 'string' && /^[0-9a-f-]{36}$/.test(s.deviceId) ? s.deviceId : randomUUID(),
    autostart: bool(s.autostart, false),
    stream: {
      resolution: oneOf(st?.resolution, ['auto', '720', '1080', '1440', '4K'] as const, d.stream.resolution),
      fps: FPS_OPTIONS.includes(Number(st?.fps)) ? Number(st.fps) : d.stream.fps,
      bitrateKbps: st?.bitrateKbps === 0 ? 0 : clampInt(st?.bitrateKbps, 500, 150000, 0),
      codec: oneOf(st?.codec, ['auto', 'H.264', 'HEVC', 'AV1'] as const, d.stream.codec),
      displayMode: oneOf(st?.displayMode, ['fullscreen', 'borderless', 'windowed'] as const, d.stream.displayMode),
      vsync: bool(st?.vsync, d.stream.vsync),
      framePacing: bool(st?.framePacing, d.stream.framePacing),
      perfOverlay: bool(st?.perfOverlay, d.stream.perfOverlay),
      packetSize: st?.packetSize === 0 ? 0 : clampInt(st?.packetSize, 1024, 1500, 0),
      captureSystemKeys: oneOf(st?.captureSystemKeys, ['never', 'fullscreen', 'always'] as const, d.stream.captureSystemKeys),
      audioOnHost: bool(st?.audioOnHost, d.stream.audioOnHost),
      absoluteMouse: bool(st?.absoluteMouse, d.stream.absoluteMouse)
    },
    host: {
      maxPlayers: clampInt(s.host?.maxPlayers, 1, 4, d.host.maxPlayers),
      defaultPerms: normalizePerms(s.host?.defaultPerms, d.host.defaultPerms),
      useVirtualDisplay: bool(s.host?.useVirtualDisplay, d.host.useVirtualDisplay)
    },
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

  update(patch: DeepPartial<Settings>): Settings {
    const next = normalizeSettings(deepMerge(this.file.get(), patch))
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
  }

  get(): Secrets {
    return this.file.get()
  }

  update(fn: (s: Secrets) => void): Secrets {
    return this.file.update(fn)
  }
}

