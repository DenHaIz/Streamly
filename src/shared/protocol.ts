// Протокол Streamly между клиентом и хостом: JSON-сообщения поверх WebSocket.
import type { InputPerms } from './perms'
import type { StreamPolicy } from './types'

export const PROTOCOL_VERSION = 1
export const SIGNALING_PORT = 47900
export const DISCOVERY_PORT = 47901
export const DISCOVERY_MAGIC = 'STREAMLY_DISCOVER_V1'
export const DISCOVERY_REPLY = 'STREAMLY_HOST_V1'
/** Имя приложения в Apollo, которое стримит рабочий стол. */
export const APOLLO_APP = 'Desktop'

export type ClientMessage =
  | { t: 'hello'; v: number; deviceId: string; nickname: string; appVersion: string; trustToken?: string }
  | { t: 'joinRequest' }
  | { t: 'pairRequest' }
  | { t: 'pairSpawned' }
  /** Клиент готов запустить стрим и ждёт своей очереди (Apollo держит только один ожидающий запуск). */
  | { t: 'launchRequest' }
  | { t: 'sessionStarted' }
  | { t: 'sessionEnded' }
  /** ts — время отправки у клиента, хост возвращает его в pong для замера задержки. */
  | { t: 'ping'; ts?: number }

export type HostMessage =
  | { t: 'hostInfo'; v: number; hostName: string; slotsUsed: number; maxSlots: number }
  /** needsPair: хост не знает этого клиента в Apollo, нужно сопряжение (хост — источник истины). */
  | { t: 'joinAccepted'; trustToken?: string; perms: InputPerms; needsPair: boolean; policy: StreamPolicy }
  | { t: 'joinDenied'; reason: 'denied' | 'full' | 'version' | 'busy' }
  | { t: 'pairBegin'; pin: string }
  /** Очередь дошла: можно запускать Moonlight. */
  | { t: 'launchGo' }
  /**
   * reason при ошибке: client_timeout — клиент не запустил Moonlight; no_request — Moonlight не достучался
   * до Apollo (файрвол или Apollo не отвечает на 47984/47989); apollo_error — Apollo принял PIN, но клиент не появился.
   */
  | { t: 'pairResult'; ok: boolean; reason?: PairFailReason }
  /** Хост видит (или перестал видеть) активный стрим этого клиента в Apollo. */
  | { t: 'sessionState'; streaming: boolean }
  | { t: 'permissionsChanged'; perms: InputPerms }
  | { t: 'kicked' }
  | { t: 'hostStopping' }
  | { t: 'pong'; ts?: number }

export type PairFailReason = 'client_timeout' | 'no_request' | 'apollo_error'

export interface DiscoveryReply {
  magic: typeof DISCOVERY_REPLY
  hostName: string
  slotsUsed: number
  maxSlots: number
  port: number
}

const CLIENT_TYPES = new Set(['hello', 'joinRequest', 'pairRequest', 'pairSpawned', 'launchRequest', 'sessionStarted', 'sessionEnded', 'ping'])
const HOST_TYPES = new Set([
  'hostInfo',
  'joinAccepted',
  'joinDenied',
  'pairBegin',
  'launchGo',
  'pairResult',
  'permissionsChanged',
  'kicked',
  'hostStopping',
  'sessionState',
  'pong'
])

const MAX_MESSAGE = 4096

function parse(raw: unknown, allowed: Set<string>): Record<string, unknown> | null {
  const text = typeof raw === 'string' ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : null
  if (text === null || text.length > MAX_MESSAGE) return null
  try {
    const obj = JSON.parse(text) as unknown
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    const t = (obj as { t?: unknown }).t
    if (typeof t !== 'string' || !allowed.has(t)) return null
    return obj as Record<string, unknown>
  } catch {
    return null
  }
}

const str = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
/** deviceId используется как ключ словаря: только UUID, чтобы исключить «__proto__» и подобное. */
export const isDeviceId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)

/** Разбирает и проверяет сообщение от клиента. Сообщения от друзей не доверенные: всё проверяем. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  const m = parse(raw, CLIENT_TYPES)
  if (!m) return null
  if (m.t === 'hello') {
    if (typeof m.v !== 'number' || !isDeviceId(m.deviceId) || !str(m.nickname, 32) || !str(m.appVersion, 32)) return null
    if (m.trustToken !== undefined && !str(m.trustToken, 128)) return null
  }
  return m as unknown as ClientMessage
}

const int = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const isPerms = (v: unknown): v is InputPerms =>
  !!v && typeof v === 'object' && ['keyboard', 'mouse', 'gamepad'].every((k) => typeof (v as Record<string, unknown>)[k] === 'boolean')
const isPolicy = (v: unknown): v is StreamPolicy => {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return (
    typeof p.hostAudio === 'boolean' &&
    int(p.maxBitrateKbps, 0, 500_000) &&
    int(p.hostWidth, 0, 16_384) &&
    int(p.hostHeight, 0, 16_384) &&
    int(p.hostFps, 0, 1000)
  )
}

/** Разбирает и проверяет сообщение от хоста: числа в разумных пределах, строки ограниченной длины. */
export function parseHostMessage(raw: unknown): HostMessage | null {
  const m = parse(raw, HOST_TYPES)
  if (!m) return null
  switch (m.t) {
    case 'pairBegin':
      if (!(typeof m.pin === 'string' && /^\d{4}$/.test(m.pin))) return null
      break
    case 'hostInfo':
      if (typeof m.v !== 'number' || !str(m.hostName, 64) || !int(m.slotsUsed, 0, 64) || !int(m.maxSlots, 0, 64)) return null
      m.hostName = sanitizeNickname(m.hostName as string)
      break
    case 'joinAccepted':
      if (!isPerms(m.perms) || !isPolicy(m.policy) || typeof m.needsPair !== 'boolean') return null
      if (m.trustToken !== undefined && !str(m.trustToken, 128)) return null
      break
    case 'permissionsChanged':
      if (!isPerms(m.perms)) return null
      break
    case 'joinDenied':
      if (!['denied', 'full', 'version', 'busy'].includes(m.reason as string)) return null
      break
    case 'pairResult':
      if (typeof m.ok !== 'boolean') return null
      break
    case 'sessionState':
      if (typeof m.streaming !== 'boolean') return null
      break
  }
  return m as unknown as HostMessage
}

export function parseDiscoveryReply(raw: Uint8Array | string): DiscoveryReply | null {
  try {
    const obj = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as Partial<DiscoveryReply>
    if (obj.magic !== DISCOVERY_REPLY || !str(obj.hostName) || typeof obj.port !== 'number') return null
    return {
      magic: DISCOVERY_REPLY,
      hostName: obj.hostName,
      slotsUsed: Number(obj.slotsUsed) || 0,
      maxSlots: Number(obj.maxSlots) || 4,
      port: obj.port
    }
  } catch {
    return null
  }
}

/** Ник в безопасном для отображения и для имени клиента Apollo виде. */
export function sanitizeNickname(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f<>"'`\\]/g, '').trim().slice(0, 24)
  return clean || 'Player'
}
