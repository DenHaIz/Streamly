// Контракт между интерфейсом (renderer) и основным процессом. Реализации: src/preload/index.ts и src/renderer/src/dev/mockBridge.ts.
import type { InputPerms } from './perms'
import type {
  AppInfo,
  CheckReport,
  ClientState,
  DeepPartial,
  DiscoveredHost,
  HostDisplay,
  HostState,
  Invite,
  NetStatus,
  Settings,
  TrustedFriendView,
  UpdateState,
  HotkeyName,
  HotkeyStatus,
  PadDeviceView,
  PadRawState
} from './types'

/** spectate — пустить зрителем: без клавиатуры, мыши и геймпада. */
export type JoinDecision = 'allow' | 'trust' | 'deny' | 'spectate'

export interface BridgeEvents {
  settings: Settings
  net: NetStatus
  hostState: HostState
  clientState: ClientState
  hosts: DiscoveredHost[]
  /** Меню Alt+F2 открыто (screens — сколько мониторов у этого ПК). */
  overlay: { open: boolean; screens: number }
  /** Открыта ссылка-приглашение (или найдена в буфере обмена). */
  invite: Invite
  update: UpdateState
  /** Открыть экран (пункт меню в трее). */
  navigate: NavTarget
  /** Хосту нужно внимание (запрос на подключение, просьба об управлении): звук в интерфейсе. */
  alert: { kind: 'joinRequest' | 'inputRequest' }
  /** Состояние горячих клавиш (работает, занята, выключена). */
  hotkeys: Record<HotkeyName, HotkeyStatus>
  /** Меню хоста поверх игры открыто или закрыто (только в его окне). */
  hostMenu: { open: boolean }
  /** В начале игры: геймпады, которых Moonlight не видит (нет раскладки) — их можно настроить. */
  padsWarning: { names: string[] }
}

export type NavTarget = 'home' | 'host' | 'connect' | 'settings' | 'about'

export type BridgeEvent = keyof BridgeEvents

export interface StreamlyBridge {
  getSettings(): Promise<Settings>
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>
  getNet(): Promise<NetStatus>
  getAppInfo(): Promise<AppInfo>
  openExternal(url: string): Promise<void>
  copyText(text: string): Promise<void>
  /** Цвета системных кнопок окна под текущую тему. */
  setTitleBar(dark: boolean): Promise<void>
  /** Открыть папку с логами Streamly. */
  openLogs(): Promise<void>
  /** Скопировать отчёт для диагностики (версии, сеть, состояние, хвост лога) в буфер обмена. */
  copyDiagnostics(): Promise<void>
  /** Ссылка-приглашение в буфере обмена (если есть и ещё не предлагалась). */
  checkInvite(): Promise<Invite | null>

  /** Обновления через GitHub Releases: проверка, загрузка и установка — только по действию пользователя. */
  update: {
    getState(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<void>
    /** Закрыть Streamly и установить скачанное обновление. */
    install(): Promise<void>
    /** Не предлагать эту версию. */
    skip(version: string): Promise<void>
  }

  /** Состояние горячих клавиш. */
  getHotkeys(): Promise<Record<HotkeyName, HotkeyStatus>>
  /** Пока в настройках записывают новое сочетание, горячие клавиши Streamly отпущены (иначе нажатие сработало бы). */
  suspendHotkeys(on: boolean): Promise<void>
  /** Ошибка в интерфейсе — в журнал Streamly. */
  logError(text: string): Promise<void>
  /** Сохранить журнал за 14 дней одним архивом (диалог «Сохранить как»). Путь к файлу или null, если отменили. */
  exportLogs(): Promise<string | null>

  host: {
    getState(): Promise<HostState>
    start(): Promise<void>
    install(): Promise<void>
    submitCredentials(username: string, password: string): Promise<boolean>
    stop(): Promise<void>
    respond(requestId: string, decision: JoinDecision): Promise<void>
    /** Только изменённые права: остальные остаются как есть. */
    setPerms(deviceId: string, perms: Partial<InputPerms>): Promise<void>
    kick(deviceId: string): Promise<void>
    /** Установить драйвер геймпадов (ViGEmBus) через Apollo, одно окно UAC. */
    installGamepad(): Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
    /** Отключить всех игроков. */
    kickAll(): Promise<void>
    /** Самопроверка хоста: Apollo, порты, файрвол, драйверы. */
    selfCheck(): Promise<CheckReport>
    listTrusted(): Promise<TrustedFriendView[]>
    removeTrusted(deviceId: string): Promise<void>
    /** Мониторы хоста (по логу Apollo; до первого запуска хоста список пуст). */
    listDisplays(): Promise<HostDisplay[]>
    /** Ссылка-приглашение текущего сеанса хостинга (null — хост не запущен). */
    createInvite(): Promise<{ link: string; expiresAt: number } | null>
    /** Ответ на просьбу игрока выдать ввод. */
    respondInput(deviceId: string, grant: boolean): Promise<void>
    /** Забрать ввод у всех игроков (или вернуть). */
    setInputPaused(paused: boolean): Promise<void>
    /** Переподключить геймпады игрока (двойной или зависший геймпад). */
    resetGamepad(deviceId: string): Promise<void>
    /** Передать управление: всё получает только этот игрок, у остальных снимается. */
    passControl(deviceId: string): Promise<void>
    /** Зритель: без клавиатуры, мыши и геймпада (false — вернуть права по умолчанию). */
    setSpectator(deviceId: string, on: boolean): Promise<void>
    /** Сделать геймпад игрока первым: переподключить геймпады всех, начиная с него. */
    makePadFirst(deviceId: string): Promise<void>
    /** Меню хоста поверх игры: закрыть. */
    closeMenu(): Promise<void>
    /** Плашка запросов поверх игры: высота содержимого (окно подгоняется). */
    notifyResize(height: number): Promise<void>
  }

  client: {
    getState(): Promise<ClientState>
    discover(): Promise<void>
    getHosts(): Promise<DiscoveredHost[]>
    /** inviteCode — код из ссылки-приглашения: хост пускает без подтверждения. */
    connect(address: string, inviteCode?: string): Promise<void>
    /** Проверка связи с хостом по адресу: Radmin, ping, порты Streamly и Apollo. */
    diagnose(address: string): Promise<CheckReport>
    cancel(): Promise<void>
    reset(): Promise<void>
    /** Выключить себе (true) или вернуть клавиатуру, мышь, геймпад. */
    setSelfOff(patch: Partial<InputPerms>): Promise<void>
    /** Перезапустить трансляцию с текущими настройками качества. */
    restartStream(): Promise<boolean>
    /** Попросить у хоста ввод, который он выключил. */
    requestInput(perms: Partial<InputPerms>): Promise<void>
    /** Переподключить свои геймпады: быстрый перезапуск трансляции, хост создаёт геймпады заново. */
    resetGamepad(): Promise<boolean>
    /** «Какой геймпад мой»: хост ждёт нажатия на вашем геймпаде. */
    identifyPad(): Promise<void>
  }

  /** Геймпады этого ПК глазами Moonlight и мастер раскладки. */
  pads: {
    /** null — модуль Streamly (помощник) недоступен. */
    list(): Promise<PadDeviceView[] | null>
    state(guid: string): Promise<PadRawState | null>
    /** Мастер закрыт: отпустить устройство. */
    close(): Promise<void>
  }

  /** Меню во время игры (Alt+F2). */
  overlay: {
    /** Закрыть меню и вернуться в игру. */
    close(): Promise<void>
    /** Курсор на другой монитор этого ПК (мышь отпускается из окна трансляции). */
    toOtherScreen(): Promise<boolean>
    /** Включить или выключить подробную статистику Moonlight поверх трансляции. */
    toggleStats(): Promise<boolean>
  }

  on<E extends BridgeEvent>(event: E, cb: (payload: BridgeEvents[E]) => void): () => void
}

/** Имена IPC-каналов invoke. */
export const IPC = {
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  getNet: 'net:get',
  getAppInfo: 'app:info',
  openExternal: 'app:openExternal',
  copyText: 'app:copy',
  setTitleBar: 'app:titlebar',
  openLogs: 'app:openLogs',
  copyDiagnostics: 'app:diagnostics',
  checkInvite: 'app:checkInvite',
  updateGetState: 'update:getState',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateSkip: 'update:skip',
  hostResetGamepad: 'host:resetGamepad',
  hostPassControl: 'host:passControl',
  hostSetSpectator: 'host:setSpectator',
  hostMakePadFirst: 'host:makePadFirst',
  hostCloseMenu: 'host:closeMenu',
  hostNotifyResize: 'host:notifyResize',
  clientIdentifyPad: 'client:identifyPad',
  getHotkeys: 'app:hotkeys',
  suspendHotkeys: 'app:suspendHotkeys',
  logError: 'app:logError',
  exportLogs: 'app:exportLogs',
  clientResetGamepad: 'client:resetGamepad',
  hostGetState: 'host:getState',
  hostStart: 'host:start',
  hostInstall: 'host:install',
  hostCredentials: 'host:credentials',
  hostStop: 'host:stop',
  hostRespond: 'host:respond',
  hostSetPerms: 'host:setPerms',
  hostKick: 'host:kick',
  hostKickAll: 'host:kickAll',
  hostInstallGamepad: 'host:installGamepad',
  hostSelfCheck: 'host:selfCheck',
  hostListTrusted: 'host:listTrusted',
  hostRemoveTrusted: 'host:removeTrusted',
  hostListDisplays: 'host:listDisplays',
  hostCreateInvite: 'host:createInvite',
  hostRespondInput: 'host:respondInput',
  hostSetInputPaused: 'host:setInputPaused',
  clientGetState: 'client:getState',
  clientDiscover: 'client:discover',
  clientGetHosts: 'client:getHosts',
  clientConnect: 'client:connect',
  clientDiagnose: 'client:diagnose',
  clientCancel: 'client:cancel',
  clientReset: 'client:reset',
  clientSetSelfOff: 'client:setSelfOff',
  clientRestartStream: 'client:restartStream',
  clientRequestInput: 'client:requestInput',
  padsList: 'pads:list',
  padsState: 'pads:state',
  padsClose: 'pads:close',
  overlayToggleStats: 'overlay:toggleStats',
  overlayClose: 'overlay:close',
  overlayOtherScreen: 'overlay:otherScreen'
} as const

export const EVENT_CHANNEL = 'streamly:event'
