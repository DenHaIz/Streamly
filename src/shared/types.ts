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
  /** Громкость трансляции у себя, 0–100. */
  volume: number
  /** Просить хоста убрать из трансляции Discord (чтобы не слышать свой голос и голоса друзей дважды). */
  muteHostChat: boolean
}

/** Какой монитор хоста транслировать: основной, виртуальный или конкретный (id устройства Apollo). */
export type HostDisplayChoice = 'primary' | 'virtual' | string

export type LossProtection = 'normal' | 'high'

export interface HostSettings {
  maxPlayers: number
  defaultPerms: InputPerms
  display: HostDisplayChoice
  /** Виртуальный монитор: на время игры выключать физические мониторы хоста (друзья видят весь рабочий стол). */
  virtualOnly: boolean
  /** Потолок битрейта на одного игрока, кбит/с (0 — без ограничения). Apollo кодирует поток каждому отдельно. */
  maxBitrateKbps: number
  /** Звук игры остаётся и на колонках хоста (иначе Apollo может переключить вывод на виртуальное устройство). */
  keepHostAudio: boolean
  /** Разрешить игрокам убирать Discord из трансляции (нужны виртуальные колонки Steam Streaming Speakers). */
  chatRouting: boolean
  /** Доля избыточных пакетов (FEC): «высокая» лучше переживает потери при нескольких игроках. */
  lossProtection: LossProtection
  /** Уведомлять о запросах на подключение, когда окно Streamly не активно. */
  notifyRequests: boolean
  /** Включать режим хоста сразу при запуске Streamly. */
  autoStartHosting: boolean
}

/** Условия трансляции, которые хост сообщает игроку при допуске. */
export interface StreamPolicy {
  hostAudio: boolean
  maxBitrateKbps: number
  /** Разрешение и частота транслируемого монитора хоста: выше них стримить бессмысленно (0 — без ограничения). */
  hostWidth: number
  hostHeight: number
  hostFps: number
}

/** Монитор хоста по данным Apollo. */
export interface HostDisplay {
  /** id устройства Apollo (output_name). */
  id: string
  name: string
  /** \\.\DISPLAYn */
  displayName: string
  primary: boolean
  width: number
  height: number
  fps: number
}

/** Маршрутизация звука хоста (Discord мимо трансляции). */
export interface HostAudioState {
  /** Помощник запущен и нашёл виртуальные колонки: игроки могут убрать Discord. */
  chatControl: boolean
  /** Почему недоступно: нет виртуальных колонок, выключено в настройках, нет помощника. */
  unavailable?: 'noVirtualSink' | 'disabled' | 'noHelper'
  /** Discord сейчас убран из трансляции. */
  chatExcluded: boolean
  /** Хост слышит игру через повтор виртуальных колонок. */
  monitoring: boolean
  error?: string
}

export interface RecentHost {
  address: string
  name: string
  lastUsed: number
}

export interface Settings {
  /** Версия формата настроек (для переноса старых значений). */
  schema: number
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

export const SETTINGS_SCHEMA = 2

export const DEFAULT_SETTINGS: Omit<Settings, 'deviceId' | 'nickname' | 'language'> = {
  schema: SETTINGS_SCHEMA,
  onboarded: false,
  theme: 'system',
  autostart: false,
  closeToTray: true,
  stream: {
    resolution: 'auto',
    fps: 60,
    bitrateKbps: 0,
    codec: 'auto',
    // «Без рамки» вместо эксклюзивного полного экрана: меню Alt+F2 и второй монитор работают без мигания.
    displayMode: 'borderless',
    vsync: false,
    framePacing: false,
    perfOverlay: false,
    packetSize: 0,
    captureSystemKeys: 'fullscreen',
    absoluteMouse: true,
    volume: 100,
    muteHostChat: true
  },
  host: {
    maxPlayers: 4,
    defaultPerms: { keyboard: true, mouse: true, gamepad: true },
    display: 'primary',
    virtualOnly: false,
    maxBitrateKbps: 20000,
    keepHostAudio: true,
    chatRouting: true,
    lossProtection: 'high',
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
  /** Что игрок выключил себе сам (из меню Alt+F2). */
  selfOff: InputPerms
  /** Игрок просит убрать Discord из трансляции. */
  muteChat: boolean
  /** Moonlight у игрока сообщает о плохой связи. */
  poorNetwork: boolean
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
  audio: HostAudioState
  /** Настройки монитора или защиты от потерь поменялись во время игры: применятся, когда все отключатся. */
  pendingRestart: boolean
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
  /** Разброс задержки (мс): большой — признак ретранслятора Radmin или перегруженной сети. */
  jitterMs?: number
  policy?: StreamPolicy
  /** Что игрок выключил себе сам. */
  selfOff?: InputPerms
  /** Может ли хост убрать Discord из трансляции и убран ли он сейчас. */
  hostChat?: { control: boolean; excluded: boolean }
  /** Moonlight сообщает о плохой связи (потери пакетов). */
  poorNetwork?: boolean
  /** Трансляция перезапускается с новыми настройками качества. */
  restarting?: boolean
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
