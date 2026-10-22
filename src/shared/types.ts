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
  /** Автоподбор качества: замер канала перед стартом и снижение при плохой связи. */
  autoQuality: boolean
  /** HDR (нужно включить HDR в Windows на обоих ПК). */
  hdr: boolean
  /** Цвет 4:4:4: чёткий текст, но больше трафика и нужна поддержка с обеих сторон. */
  yuv444: boolean
  /** Все геймпады этого ПК — как один (первый игрок): против двойных геймпадов (Steam Input, DS4Windows). */
  singleGamepad: boolean
}

/** Качество для конкретного хоста (запоминается из меню Alt+F2). */
export type QualityProfile = Pick<StreamSettings, 'resolution' | 'fps' | 'bitrateKbps'>

/** Какой монитор хоста транслировать: основной, виртуальный или конкретный (id устройства Apollo). */
export type HostDisplayChoice = 'primary' | 'virtual' | string

export type LossProtection = 'normal' | 'high'

/** Баланс кодирования: задержка или качество картинки при том же битрейте. */
export type EncoderPreset = 'latency' | 'balanced' | 'quality' | 'custom'

/**
 * Ручная настройка кодировщика (EncoderPreset = 'custom'). Apollo берёт параметры того кодировщика,
 * который нашёл на ПК: NVIDIA, AMD, Intel Quick Sync или процессор.
 */
export interface EncoderCustom {
  /** NVENC P1–P7: больше — лучше картинка и дольше кодирование. */
  nvPreset: number
  nvTwoPass: 'disabled' | 'quarter_res' | 'full_res'
  nvSpatialAq: boolean
  amdUsage: 'ultralowlatency' | 'lowlatency' | 'lowlatency_high_quality'
  amdQuality: 'speed' | 'balanced' | 'quality'
  amdRc: 'vbr_latency' | 'cbr' | 'vbr_peak'
  amdPreanalysis: boolean
  amdVbaq: boolean
  qsvPreset: 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow'
  swPreset: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast'
  /** Минимум потоков процессора на кодирование. */
  swThreads: number
}

export interface HostSettings {
  maxPlayers: number
  defaultPerms: InputPerms
  display: HostDisplayChoice
  /** Виртуальный монитор: на время игры выключать физические мониторы хоста (друзья видят весь рабочий стол). */
  virtualOnly: boolean
  /**
   * Потолок битрейта на одного игрока, кбит/с: 0 — без ограничения, -1 — авто (30 Мбит/с на 1–2 игроков,
   * 20 — на 3–4). Apollo кодирует поток каждому отдельно.
   */
  maxBitrateKbps: number
  /** Звук игры остаётся и на колонках хоста (иначе Apollo может переключить вывод на виртуальное устройство). */
  keepHostAudio: boolean
  /** Разрешить игрокам убирать Discord из трансляции (нужны виртуальные колонки Steam Streaming Speakers). */
  chatRouting: boolean
  /** Доля избыточных пакетов (FEC): «высокая» лучше переживает потери при нескольких игроках. */
  lossProtection: LossProtection
  /** Пресет кодировщика (NVENC P1/P3/P5 и аналоги у AMD и Intel). */
  encoderPreset: EncoderPreset
  encoderCustom: EncoderCustom
  /** Уведомлять о запросах на подключение, когда окно Streamly не активно. */
  notifyRequests: boolean
  /** Включать режим хоста сразу при запуске Streamly. */
  autoStartHosting: boolean
  /** Друзья со ссылкой-приглашением входят без подтверждения. */
  inviteAutoAdmit: boolean
  /** Звук при запросе на подключение или просьбе об управлении. */
  requestSound: boolean
  /** Плашка с запросами поверх игры, пока окно Streamly не на экране. */
  gameNotify: boolean
}

/** Условия трансляции, которые хост сообщает игроку при допуске. */
export interface StreamPolicy {
  hostAudio: boolean
  maxBitrateKbps: number
  /** Разрешение и частота транслируемого монитора хоста: выше них стримить бессмысленно (0 — без ограничения). */
  hostWidth: number
  hostHeight: number
  hostFps: number
  /** Чем кодирует видео хост (по логу Apollo). */
  encoder?: HostEncoder
}

export type EncoderVendor = 'nvenc' | 'amdvce' | 'quicksync' | 'software' | 'other'

/** Кодировщик видео хоста. */
export interface HostEncoder {
  vendor: EncoderVendor
  hevc: boolean
  av1: boolean
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
  /** Своё качество для отдельных хостов (по адресу). */
  hostQuality: Record<string, QualityProfile>
  updates: UpdateSettings
  /** Показывать редко нужные настройки. */
  showAdvanced: boolean
  hotkeys: HotkeySettings
}

/** Горячие клавиши (формат Electron: «Alt+F2», «Ctrl+Shift+F2»; пусто — выключена). */
export interface HotkeySettings {
  /** Меню игрока (Alt+F2). */
  clientMenu: string
  /** Запасное сочетание меню игрока: когда Moonlight перехватывает Alt. */
  clientMenuAlt: string
  /** Меню хоста поверх игры. */
  hostMenu: string
  /** Забрать управление у всех и вернуть. */
  hostPause: string
  /** Разрешить первый запрос (или выдать управление). */
  hostAllow: string
  /** Отклонить первый запрос. */
  hostDeny: string
}

export type HotkeyName = keyof HotkeySettings
/** ok — работает, taken — занято другой программой, off — выключено, idle — понадобится позже (не хостинг или не игра). */
export type HotkeyStatus = 'ok' | 'taken' | 'off' | 'idle'

export const DEFAULT_HOTKEYS: HotkeySettings = {
  clientMenu: 'Alt+F2',
  clientMenuAlt: 'Ctrl+Shift+F2',
  hostMenu: 'Alt+F3',
  hostPause: 'Alt+F12',
  hostAllow: 'Alt+F6',
  hostDeny: 'Alt+F7'
}

export interface UpdateSettings {
  /** Проверять обновления на GitHub при запуске и раз в несколько часов. */
  auto: boolean
  /** Версия, которую попросили не предлагать (ручная проверка всё равно её покажет). */
  skipped: string
}

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'latest' | 'error' | 'unsupported'

/** Обновление Streamly через GitHub Releases. Ничего не ставится без согласия пользователя. */
export interface UpdateState {
  status: UpdateStatus
  /** Текущая версия. */
  current: string
  /** Найденная новая версия. */
  version?: string
  /** Что нового (текст из релиза). */
  notes?: string
  /** Загрузка, 0–100. */
  percent?: number
  /** Скорость загрузки, байт/с. */
  bytesPerSecond?: number
  error?: string
  checkedAt?: number
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] }

export const SETTINGS_SCHEMA = 3

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
    muteHostChat: true,
    autoQuality: false,
    hdr: false,
    yuv444: false,
    // Steam Input и DS4Windows у игрока показывают геймпад дважды: у хоста появлялось два. Один на ПК — частый случай.
    singleGamepad: true
  },
  host: {
    maxPlayers: 4,
    defaultPerms: { keyboard: true, mouse: true, gamepad: true },
    display: 'primary',
    virtualOnly: false,
    maxBitrateKbps: -1,
    keepHostAudio: true,
    chatRouting: true,
    lossProtection: 'high',
    // Под видеокарты NVIDIA RTX: P3 заметно чище P1 при почти той же задержке.
    encoderPreset: 'balanced',
    // Ручная настройка начинается со значений «Баланса» (под RTX: P3, двухпроходное в четверть разрешения).
    encoderCustom: {
      nvPreset: 3,
      nvTwoPass: 'quarter_res',
      nvSpatialAq: false,
      amdUsage: 'ultralowlatency',
      amdQuality: 'balanced',
      amdRc: 'vbr_latency',
      amdPreanalysis: false,
      amdVbaq: true,
      qsvPreset: 'fast',
      swPreset: 'superfast',
      swThreads: 4
    },
    notifyRequests: true,
    autoStartHosting: false,
    inviteAutoAdmit: true,
    requestSound: true,
    gameNotify: true
  },
  recentHosts: [],
  hostQuality: {},
  updates: { auto: true, skipped: '' },
  showAdvanced: false,
  hotkeys: { ...DEFAULT_HOTKEYS }
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

/** reconnecting — сигнальное соединение оборвалось, место держится, пока игрок не вернётся (или не выйдет срок). */
export type PlayerStatus = 'waiting' | 'pairing' | 'connecting' | 'streaming' | 'reconnecting'

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
  /** Игрок просит выдать ему ввод (то, что хост выключил). */
  inputRequest?: InputPerms
  /** Вошёл по ссылке-приглашению. */
  viaInvite: boolean
  /** Номер геймпада игрока у хоста (1–4, по XInput), если удалось определить. */
  padSlot?: number
}

/** Номер геймпада одного игрока (для игроков: кто каким геймпадом управляет у хоста). */
export interface PadInfo {
  nickname: string
  /** 1–4; null — не определён (нет геймпада или ещё не нажимали). */
  slot: number | null
  /** Это вы. */
  you: boolean
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
  /** Кодировщик видео (после первого запуска Apollo). */
  encoder?: HostEncoder
  /** Исходящий поток хоста по адаптеру сети Radmin, Мбит/с. */
  uploadMbps?: number
  /** Хост временно забрал ввод у всех игроков. */
  inputPaused: boolean
  /** Видео кодирует не та видеокарта (например, встроенная графика Ryzen при наличии RTX). */
  wrongGpu?: { encoderVendor: EncoderVendor; better: string }
  /** Apollo перестал отвечать во время хостинга: Streamly пробует перезапустить его службу. */
  apolloDown?: boolean
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
  /** Переподключение после обрыва (автоматически). */
  reconnecting?: boolean
  /** Идёт замер скорости канала до хоста. */
  measuring?: boolean
  /** Скорость канала от хоста по замеру, Мбит/с. */
  speedMbps?: number
  /** С какими параметрами запущена трансляция. */
  active?: { width: number; height: number; fps: number; bitrateKbps: number; auto: boolean }
  /** Автоподбор снизил качество из-за плохой связи. */
  autoLowered?: boolean
  /** Подключение к сети по Wi-Fi (кабель надёжнее). */
  wifi?: boolean
  /** Похоже на подключение через ретранслятор Radmin. */
  relaySuspect?: boolean
  /** Просьба выдать ввод: ждём ответа хоста или хост отказал. */
  inputRequest?: 'pending' | 'denied'
  /** Хост временно забрал ввод у всех. */
  inputPaused?: boolean
  /** Номера геймпадов у хоста (кнопка-глаз в меню игрока). */
  pads?: PadInfo[]
  /** «Какой геймпад мой»: ждём нажатия или результат. */
  padIdentify?: 'waiting' | 'done' | 'notFound'
  /** Сигнальное соединение с хостом оборвалось, трансляция идёт, Streamly переподключается. */
  signalLost?: boolean
  /** Хост снизил потолок битрейта (пришли новые игроки): трансляция перезапущена с меньшим битрейтом. */
  capLowered?: number
}

/** Ссылка-приглашение streamly://join/... */
export interface Invite {
  address: string
  name: string
  code?: string
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
