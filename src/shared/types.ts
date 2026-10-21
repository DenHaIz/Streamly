import type { InputPerms } from './perms'

export type Lang = 'ru' | 'en'
export type ThemePref = 'system' | 'light' | 'dark'

export type Resolution = 'auto' | '720' | '1080' | '1440' | '4K'
export type Codec = 'auto' | 'H.264' | 'HEVC' | 'AV1'
export type DisplayMode = 'fullscreen' | 'borderless' | 'windowed'
export type CaptureKeys = 'never' | 'fullscreen' | 'always'

export interface StreamSettings {
  resolution: Resolution
  fps: number
  /** 0 = Moonlight подбирает сам. */
  bitrateKbps: number
  codec: Codec
  displayMode: DisplayMode
  vsync: boolean
  framePacing: boolean
  perfOverlay: boolean
  /** 0 = авто (Moonlight решает сам, для VPN это 1024). */
  packetSize: number
  captureSystemKeys: CaptureKeys
  /** Курсор «как на рабочем столе» (абсолютная мышь); для игр лучше выключить. */
  absoluteMouse: boolean
}

export interface HostSettings {
  maxPlayers: number
  defaultPerms: InputPerms
  useVirtualDisplay: boolean
  /** Потолок битрейта на одного игрока, кбит/с (0 — без ограничения). Apollo кодирует поток каждому отдельно. */
  maxBitrateKbps: number
  /** Звук игры остаётся и на колонках хоста (иначе Apollo может переключить вывод на виртуальное устройство). */
  keepHostAudio: boolean
  /** Уведомлять о запросах на подключение, когда окно Streamly не активно. */
  notifyRequests: boolean
  /** Включать режим хоста сразу при запуске Streamly. */
  autoStartHosting: boolean
}

/** Условия трансляции, которые хост сообщает игроку при допуске. */
export interface StreamPolicy {
  hostAudio: boolean
  maxBitrateKbps: number
  /** Разрешение и частота основного монитора хоста: выше них стримить бессмысленно. */
  hostWidth: number
  hostHeight: number
  hostFps: number
}

export interface RecentHost {
  address: string
  name: string
  lastUsed: number
}

export interface Settings {
  onboarded: boolean
  language: Lang
  theme: ThemePref
  nickname: string
  deviceId: string
  autostart: boolean
  /** Крестик сворачивает Streamly в трей, пока идёт хостинг или трансляция. */
  closeToTray: boolean
  stream: StreamSettings
  host: HostSettings
  recentHosts: RecentHost[]
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] }

export const DEFAULT_SETTINGS: Omit<Settings, 'deviceId' | 'nickname' | 'language'> = {
  onboarded: false,
  theme: 'system',
  autostart: false,
  closeToTray: true,
  stream: {
    resolution: 'auto',
    fps: 60,
    bitrateKbps: 0,
    codec: 'auto',
    displayMode: 'fullscreen',
    vsync: false,
    framePacing: false,
    perfOverlay: false,
    packetSize: 0,
    captureSystemKeys: 'fullscreen',
    absoluteMouse: true
  },
  host: {
    maxPlayers: 4,
    defaultPerms: { keyboard: true, mouse: true, gamepad: true },
    useVirtualDisplay: false,
    maxBitrateKbps: 20000,
    keepHostAudio: true,
    notifyRequests: true,
    autoStartHosting: false
  },
  recentHosts: []
}

export interface RadminStatus {
  /** Найден виртуальный адаптер Radmin VPN. */
  installed: boolean
  /** У адаптера есть адрес 26.x.x.x. */
  connected: boolean
  ip?: string
  adapterName?: string
}

export type ErrorCode =
  | 'no_radmin'
  | 'apollo_install_failed'
  | 'apollo_unreachable'
  | 'apollo_auth'
  | 'install_cancelled'
  | 'port_busy'
  | 'host_unreachable'
  | 'host_not_hosting'
  | 'host_busy'
  | 'sunshine_conflict'
  | 'pair_no_request'
  | 'stream_timeout'
  | 'host_full'
  | 'denied'
  | 'kicked'
  | 'host_stopped'
  | 'pair_failed'
  | 'stream_failed'
  | 'moonlight_missing'
  | 'version_mismatch'
  | 'connection_lost'
  | 'unknown'

// ---------- Хост ----------

export type HostPhase =
  | 'idle'
  | 'checking'
  | 'needsInstall'
  | 'installing'
  | 'needsCredentials'
  | 'configuring'
  | 'running'
  | 'error'

export type PlayerStatus = 'waiting' | 'pairing' | 'connecting' | 'streaming'

export interface PlayerView {
  deviceId: string
  nickname: string
  address: string
  status: PlayerStatus
  perms: InputPerms
  trusted: boolean
  since: number
  /** Задержка до игрока по сети (мс), измеряется по сигнальному соединению. */
  rttMs?: number
}

export interface JoinRequestView {
  id: string
  deviceId: string
  nickname: string
  address: string
  at: number
  /** Устройство уже подключалось раньше (иначе — «новое устройство», стоит сверить ник). */
  known: boolean
}

export interface HostState {
  phase: HostPhase
  error?: ErrorCode
  errorDetail?: string
  address?: string
  hostName: string
  maxPlayers: number
  players: PlayerView[]
  requests: JoinRequestView[]
  /** Установлен ли драйвер виртуальных геймпадов (ViGEmBus). */
  gamepadDriver: boolean
}

export interface TrustedFriendView {
  deviceId: string
  nickname: string
  addedAt: number
  lastSeen?: number
}

// ---------- Клиент ----------

export type ClientPhase =
  | 'idle'
  | 'connecting'
  | 'waitingApproval'
  | 'pairing'
  | 'launching'
  | 'streaming'
  | 'ended'
  | 'error'

export interface ClientState {
  phase: ClientPhase
  host?: { address: string; name: string }
  error?: ErrorCode
  errorDetail?: string
  perms?: InputPerms
  startedAt?: number
  /** Задержка до хоста (мс). */
  rttMs?: number
  policy?: StreamPolicy
}

// ---------- Проверка связи ----------

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'

/** Один пункт проверки. id — ключ перевода (diag.checks.<id>), hint — ключ подсказки (diag.hints.<hint>). */
export interface CheckItem {
  id: string
  status: CheckStatus
  value?: string
  hint?: string
}

export interface CheckReport {
  target?: string
  items: CheckItem[]
  /** Итог: ключ перевода diag.summary.<summary>. */
  summary: string
}

export type HostSource = 'broadcast' | 'scan' | 'recent' | 'manual'

export interface DiscoveredHost {
  address: string
  name: string
  slotsUsed: number
  maxSlots: number
  source: HostSource
  online: boolean
  lastSeen: number
}

export interface AppInfo {
  version: string
  moonlightAvailable: boolean
  apolloBundled: boolean
  apolloInstalled: boolean
  platform: string
}
