// Протокол Streamly между клиентом и хостом: JSON-сообщения поверх WebSocket.
import type { InputPerms } from './perms'
import type { Invite, StreamPolicy } from './types'

export const PROTOCOL_VERSION = 1
export const SIGNALING_PORT = 47900
export const DISCOVERY_PORT = 47901
export const DISCOVERY_MAGIC = 'STREAMLY_DISCOVER_V1'
export const DISCOVERY_REPLY = 'STREAMLY_HOST_V1'
/** Имя приложения в Apollo, которое стримит рабочий стол. */
export const APOLLO_APP = 'Desktop'

export type ClientMessage =
  /** resumeToken — возвращение после короткого обрыва: хост пускает без подтверждения, пока держит место. */
  | { t: 'hello'; v: number; deviceId: string; nickname: string; appVersion: string; trustToken?: string; inviteCode?: string; resumeToken?: string }
  | { t: 'joinRequest' }
  | { t: 'pairRequest' }
  | { t: 'pairSpawned' }
  /** Клиент готов запустить стрим и ждёт своей очереди (Apollo держит только один ожидающий запуск). */
  | { t: 'launchRequest' }
  | { t: 'sessionStarted' }
  | { t: 'sessionEnded' }
  /** ts — время отправки у клиента, хост возвращает его в pong для замера задержки. */
  | { t: 'ping'; ts?: number }
  /** Пожелания игрока: убрать Discord из трансляции, что он выключил себе сам (клавиатура, мышь, геймпад). */
  | { t: 'prefs'; muteChat: boolean; selfOff: InputPerms }
  /** Moonlight у игрока сообщает о плохой (или снова нормальной) связи. */
  | { t: 'netStatus'; poor: boolean }
  /** Игрок просит выдать ввод, который хост выключил (true — просит). */
  | { t: 'inputRequest'; perms: InputPerms }
  /** Замер скорости: хост присылает двоичные данные и затем speedEnd. */
  | { t: 'speedTest' }
  /** «Какой геймпад мой»: хост ждёт нажатия на геймпаде игрока и сообщает номер. */
  | { t: 'identifyPad' }
  /** Игрок уходит сам (а не обрыв связи): место не держим. */
  | { t: 'leave' }
  /** Замер канала по UDP: хост выдаёт токен для регистрации UDP-адреса игрока (probeToken). */
  | { t: 'probeOpen' }
  /** Ступень замера: хост шлёт по UDP пакеты со скоростью kbps в течение ms, затем probeStepEnd. */
  | { t: 'probeStep'; id: number; kbps: number; ms: number }
  /** Итог замера у игрока: хост узнаёт, что его исходящий канал не меньше этого (потолок для нескольких игроков). */
  | { t: 'probeResult'; capacityKbps: number; saturated: boolean }
  /** Канал до хоста забит (очередь и потери по UDP-пингам держатся несколько секунд) или снова свободен. */
  | { t: 'netCongestion'; on: boolean }

export type HostMessage =
  | { t: 'hostInfo'; v: number; hostName: string; slotsUsed: number; maxSlots: number }
  /** needsPair: хост не знает этого клиента в Apollo, нужно сопряжение (хост — источник истины). */
  /** features: что умеет хост ('udpProbe' — замер канала и пинги по UDP). */
  | { t: 'joinAccepted'; trustToken?: string; perms: InputPerms; needsPair: boolean; policy: StreamPolicy; resumeToken?: string; features?: string[] }
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
  /** chatControl: хост может убрать Discord из трансляции; chatExcluded: убран сейчас. */
  | { t: 'audioState'; chatControl: boolean; chatExcluded: boolean }
  | { t: 'inputRequestResult'; granted: boolean }
  /** Хост временно забрал (или вернул) ввод у всех игроков. */
  | { t: 'inputPaused'; paused: boolean }
  /** Конец замера скорости: сколько байт отправлено (0 — замер сейчас недоступен). */
  | { t: 'speedEnd'; bytes: number }
  /** Хост просит переподключить геймпады (двойной или зависший геймпад): клиент быстро перезапускает трансляцию. */
  | { t: 'resetGamepad' }
  /** Условия трансляции изменились (например, потолок битрейта при смене числа игроков). */
  | { t: 'policyUpdate'; policy: StreamPolicy }
  /** Номера геймпадов игроков у хоста. */
  | { t: 'pads'; list: { nickname: string; slot: number | null; you: boolean }[] }
  /** Ответ на identifyPad: номер геймпада (null — нажатия не было). */
  | { t: 'padIdentified'; slot: number | null }
  /** Токен для UDP-замера и порт, куда его прислать (пустой токен — замер сейчас недоступен). */
  | { t: 'probeToken'; token: string; port: number }
  /** Ступень отправлена: сколько пакетов и с какой скоростью (хост мог снизить её, если кто-то уже играет). */
  | { t: 'probeStepEnd'; id: number; sent: number; kbps: number }

export type PairFailReason = 'client_timeout' | 'no_request' | 'apollo_error'

export interface DiscoveryReply {
  magic: typeof DISCOVERY_REPLY
  hostName: string
  slotsUsed: number
  maxSlots: number
  port: number
}

const CLIENT_TYPES = new Set([
  'hello',
  'joinRequest',
  'pairRequest',
  'pairSpawned',
  'launchRequest',
  'sessionStarted',
  'sessionEnded',
  'ping',
  'prefs',
  'netStatus',
  'inputRequest',
  'speedTest',
  'identifyPad',
  'leave',
  'probeOpen',
  'probeStep',
  'probeResult',
  'netCongestion'
])
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
  'pong',
  'audioState',
  'inputRequestResult',
  'inputPaused',
  'speedEnd',
  'resetGamepad',
  'policyUpdate',
  'pads',
  'padIdentified',
  'probeToken',
  'probeStepEnd'
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
    if (m.inviteCode !== undefined && !(typeof m.inviteCode === 'string' && /^[\w-]{8,64}$/.test(m.inviteCode))) return null
    if (m.resumeToken !== undefined && !(typeof m.resumeToken === 'string' && /^[\w-]{16,64}$/.test(m.resumeToken))) return null
  }
  if (m.t === 'inputRequest' && !isPerms(m.perms)) return null
  if (m.t === 'prefs' && (typeof m.muteChat !== 'boolean' || !isPerms(m.selfOff))) return null
  if (m.t === 'netStatus' && typeof m.poor !== 'boolean') return null
  if (m.t === 'probeStep' && !(int(m.id, 0, 255) && int(m.kbps, 100, 1_000_000) && int(m.ms, 1, 10_000))) return null
  if (m.t === 'probeResult' && !(int(m.capacityKbps, 0, 10_000_000) && typeof m.saturated === 'boolean')) return null
  if (m.t === 'netCongestion' && typeof m.on !== 'boolean') return null
  return m as unknown as ClientMessage
}

const int = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const isPerms = (v: unknown): v is InputPerms =>
  !!v && typeof v === 'object' && ['keyboard', 'mouse', 'gamepad'].every((k) => typeof (v as Record<string, unknown>)[k] === 'boolean')
const isPolicy = (v: unknown): v is StreamPolicy => {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  if (p.fecPercent !== undefined && !int(p.fecPercent, 0, 100)) return false
  if (p.encoder !== undefined) {
    const e = p.encoder as Record<string, unknown> | null
    if (!e || typeof e !== 'object' || !['nvenc', 'amdvce', 'quicksync', 'software', 'other'].includes(e.vendor as string)) return false
    if (typeof e.hevc !== 'boolean' || typeof e.av1 !== 'boolean') return false
  }
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
      if (m.resumeToken !== undefined && !(typeof m.resumeToken === 'string' && /^[\w-]{16,64}$/.test(m.resumeToken))) return null
      if (m.features !== undefined) {
        if (!Array.isArray(m.features) || m.features.length > 16 || !m.features.every((x) => str(x, 32))) return null
      }
      break
    case 'probeToken':
      if (!(typeof m.token === 'string' && /^[\w-]{0,16}$/.test(m.token)) || !int(m.port, 1, 65535)) return null
      break
    case 'probeStepEnd':
      if (!int(m.id, 0, 255) || !int(m.sent, 0, 1_000_000) || !int(m.kbps, 0, 1_000_000)) return null
      break
    case 'policyUpdate':
      if (!isPolicy(m.policy)) return null
      break
    case 'pads': {
      const list = m.list
      if (!Array.isArray(list) || list.length > 8) return null
      for (const p of list as Record<string, unknown>[]) {
        if (!p || typeof p !== 'object' || !str(p.nickname, 32) || typeof p.you !== 'boolean') return null
        if (p.slot !== null && !int(p.slot, 1, 4)) return null
        p.nickname = sanitizeNickname(p.nickname as string)
      }
      break
    }
    case 'padIdentified':
      if (m.slot !== null && !int(m.slot, 1, 4)) return null
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
    case 'audioState':
      if (typeof m.chatControl !== 'boolean' || typeof m.chatExcluded !== 'boolean') return null
      break
    case 'inputRequestResult':
      if (typeof m.granted !== 'boolean') return null
      break
    case 'inputPaused':
      if (typeof m.paused !== 'boolean') return null
      break
    case 'speedEnd':
      if (!int(m.bytes, 0, 64 * 1024 * 1024)) return null
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

/** Версия a не ниже b (x.y.z). */
export function versionAtLeast(a: string | undefined, b: string): boolean {
  if (!a) return false
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return true
}

/** Ник в безопасном для отображения и для имени клиента Apollo виде. */
export function sanitizeNickname(name: string): string {
  const clean = name
    .replace(/[\u0000-\u001f\u007f<>"'`\\]/g, '')
    .replace(/[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .trim()
    .slice(0, 24)
  return clean || 'Player'
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Ссылка-приглашение: streamly://join/<адрес>?name=<имя хоста>&code=<код>. */
export function makeInviteLink(address: string, name: string, code?: string): string {
  const q = new URLSearchParams({ name })
  if (code) q.set('code', code)
  return `streamly://join/${address}?${q.toString()}`
}

/** Находит и разбирает ссылку-приглашение в произвольном тексте (сообщение из Discord, аргументы запуска). */
export function parseInviteLink(text: string): Invite | null {
  const m = /streamly:\/\/join\/([0-9.]{7,15})(\?[^\s"'<>]*)?/i.exec(text)
  if (!m) return null
  const address = m[1]
  const ip = IPV4.exec(address)
  if (!ip || ip.slice(1).some((n) => Number(n) > 255)) return null
  const q = new URLSearchParams(m[2] ?? '')
  const code = q.get('code') ?? undefined
  return {
    address,
    name: sanitizeNickname(q.get('name') ?? address),
    code: code && /^[\w-]{8,64}$/.test(code) ? code : undefined
  }
}
