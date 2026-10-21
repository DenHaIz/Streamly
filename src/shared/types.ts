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
  audioOnHost: boolean
  /** Курсор «как на рабочем столе» (абсолютная мышь); для игр лучше выключить. */
  absoluteMouse: boolean
}

export interface HostSettings {
  maxPlayers: number
  defaultPerms: InputPerms
  useVirtualDisplay: boolean
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
  stream: StreamSettings
  host: HostSettings
  recentHosts: RecentHost[]
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] }

export const DEFAULT_SETTINGS: Omit<Settings, 'deviceId' | 'nickname' | 'language'> = {
  onboarded: false,
  theme: 'system',
  autostart: false,
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
    audioOnHost: false,
    absoluteMouse: true
  },
  host: {
    maxPlayers: 4,
    defaultPerms: { keyboard: true, mouse: true, gamepad: true },
    useVirtualDisplay: false
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
}

export interface JoinRequestView {
  id: string
  deviceId: string
  nickname: string
  address: string
  at: number
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
