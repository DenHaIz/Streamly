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
  RadminStatus,
  Settings,
  TrustedFriendView
} from './types'

export type JoinDecision = 'allow' | 'trust' | 'deny'

export interface BridgeEvents {
  settings: Settings
  radmin: RadminStatus
  hostState: HostState
  clientState: ClientState
  hosts: DiscoveredHost[]
  /** Меню Alt+F2 открыто (screens — сколько мониторов у этого ПК). */
  overlay: { open: boolean; screens: number }
}

export type BridgeEvent = keyof BridgeEvents

export interface StreamlyBridge {
  getSettings(): Promise<Settings>
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>
  getRadmin(): Promise<RadminStatus>
  getAppInfo(): Promise<AppInfo>
  openExternal(url: string): Promise<void>
  copyText(text: string): Promise<void>
  /** Цвета системных кнопок окна под текущую тему. */
  setTitleBar(dark: boolean): Promise<void>
  /** Открыть папку с логами Streamly. */
  openLogs(): Promise<void>
  /** Скопировать отчёт для диагностики (версии, сеть, состояние, хвост лога) в буфер обмена. */
  copyDiagnostics(): Promise<void>

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
  }

  client: {
    getState(): Promise<ClientState>
    discover(): Promise<void>
    getHosts(): Promise<DiscoveredHost[]>
    connect(address: string): Promise<void>
    /** Проверка связи с хостом по адресу: Radmin, ping, порты Streamly и Apollo. */
    diagnose(address: string): Promise<CheckReport>
    cancel(): Promise<void>
    reset(): Promise<void>
    /** Выключить себе (true) или вернуть клавиатуру, мышь, геймпад. */
    setSelfOff(patch: Partial<InputPerms>): Promise<void>
    /** Перезапустить трансляцию с текущими настройками качества. */
    restartStream(): Promise<boolean>
  }

  /** Меню во время игры (Alt+F2). */
  overlay: {
    /** Закрыть меню и вернуться в игру. */
    close(): Promise<void>
    /** Курсор на другой монитор этого ПК (мышь отпускается из окна трансляции). */
    toOtherScreen(): Promise<boolean>
  }

  on<E extends BridgeEvent>(event: E, cb: (payload: BridgeEvents[E]) => void): () => void
}

/** Имена IPC-каналов invoke. */
export const IPC = {
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  getRadmin: 'radmin:get',
  getAppInfo: 'app:info',
  openExternal: 'app:openExternal',
  copyText: 'app:copy',
  setTitleBar: 'app:titlebar',
  openLogs: 'app:openLogs',
  copyDiagnostics: 'app:diagnostics',
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
  clientGetState: 'client:getState',
  clientDiscover: 'client:discover',
  clientGetHosts: 'client:getHosts',
  clientConnect: 'client:connect',
  clientDiagnose: 'client:diagnose',
  clientCancel: 'client:cancel',
  clientReset: 'client:reset',
  clientSetSelfOff: 'client:setSelfOff',
  clientRestartStream: 'client:restartStream',
  overlayClose: 'overlay:close',
  overlayOtherScreen: 'overlay:otherScreen'
} as const

export const EVENT_CHANNEL = 'streamly:event'
