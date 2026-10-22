import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'
import { effectivePerms, NO_INPUT, toApolloPerm, type InputPerms } from '@shared/perms'
import {
  makeInviteLink,
  parseClientMessage,
  PROTOCOL_VERSION,
  sanitizeNickname,
  SIGNALING_PORT,
  versionAtLeast,
  type ClientMessage,
  type HostMessage,
  type PairFailReason
} from '@shared/protocol'
import type {
  CheckItem,
  CheckReport,
  ErrorCode,
  HostAudioState,
  HostDisplay,
  HostEncoder,
  HostSettings,
  HostState,
  JoinRequestView,
  PlayerStatus,
  PlayerView,
  StreamPolicy,
  TrustedFriendView
} from '@shared/types'
import type { JoinDecision } from '@shared/ipc'
import type { ApolloApi, ApolloClient } from '../apollo/api'
import { ApolloError } from '../apollo/api'
import { parseDisplayDevices, parseEncoder } from '../apollo/displays'
import { AUTO_BITRATE_CAP_MAX, autoBitrateCap } from '@shared/quality'
import type { RouterOptions, RouterState } from '../helper/helper'
import type { ApolloInstallStatus, SetupOptions } from '../apollo/installer'
import type { ElevatedResult } from '../../elevate'
import type { SecretsService, SettingsService, TrustedFriend } from '../../settings'
import { DiscoveryResponder, isAllowedPeer } from '../net/discovery'

export type ApolloLike = Pick<
  ApolloApi,
  | 'probe'
  | 'setInitialCredentials'
  | 'login'
  | 'listClients'
  | 'setPerm'
  | 'disconnect'
  | 'unpair'
  | 'submitPin'
  | 'patchConfig'
  | 'restart'
  | 'getLogs'
  | 'closeApp'
>

/** Маршрутизация звука хоста (StreamlyHelper): Discord мимо трансляции. */
export interface AudioRouterLike extends EventEmitter {
  readonly available: boolean
  readonly routerState: RouterState | null
  router(opts: RouterOptions): Promise<RouterState>
}

export interface InstallerLike {
  readonly hasBundledInstaller: boolean
  status(): Promise<ApolloInstallStatus>
  setup(opts: SetupOptions): Promise<ElevatedResult>
  /** Запуск и остановка службы Apollo без прав администратора (после настройки serviceControl). */
  startService(): Promise<boolean>
  stopService(): Promise<boolean>
}

export interface HostDeps {
  settings: SettingsService
  secrets: SecretsService
  apollo: ApolloLike
  installer: InstallerLike
  /** IP хоста в сети Radmin (или адрес для отладки). */
  address: () => string | undefined
  appVersion: string
  signalingPort?: number
  discoveryPort?: number
  /** Дополнительные разрешённые адреса клиентов (для тестов и отладки по LAN). */
  extraAllowed?: string[]
  pollMs?: number
  /** Разрешение и частота основного монитора хоста (для условий трансляции). */
  displayMode?: () => { width: number; height: number; fps: number } | undefined
  /** Проверка, слушает ли что-то TCP-порт на этом ПК (для самопроверки). */
  portOpen?: (host: string, port: number) => Promise<boolean>
  pairTimeoutMs?: number
  /** Сколько отклонённый друг не может повторить запрос. */
  denyCooldownMs?: number
  /** Сколько запрос ждёт решения хоста, прежде чем соединение закрывается. */
  requestTimeoutMs?: number
  /** Маршрутизация звука (без неё «убрать Discord» недоступно). */
  audio?: AudioRouterLike
  /** Последний известный список мониторов (между запусками Apollo). */
  displaysCache?: { get(): HostDisplay[]; set(list: HostDisplay[]): void }
  /** Сколько ждать после ухода последнего игрока, прежде чем закрыть «Desktop» в Apollo. */
  idleCloseMs?: number
  /** Сколько байт отправлено через сетевой адаптер с этим адресом (для исходящего потока хоста). */
  sentBytes?: (address: string) => Promise<number | undefined>
  /** Сколько действует ссылка-приглашение. */
  inviteTtlMs?: number
  /** Названия видеокарт ПК (для проверки, что видео кодирует дискретная, а не встроенная). */
  gpus?: () => Promise<string[]>
  /** Слоты геймпадов XInput на хосте (номера геймпадов игроков). */
  xinput?: () => Promise<{ index: number; connected: boolean; active: boolean }[] | null>
  /** Сколько держать место игрока после обрыва сигнального соединения. */
  resumeGraceMs?: number
  /** Версия Apollo в комплекте Streamly (для проверки, не устарел ли установленный). */
  bundledApolloVersion?: string
  log?: (msg: string, err?: unknown) => void
}

interface Peer {
  id: string
  ws: WebSocket
  address: string
  alive: boolean
  missed?: number
  rttMs?: number
  deviceId?: string
  nickname: string
  /** Версия Streamly у игрока (новые возможности — только у тех, кто их понимает). */
  appVersion?: string
  trustToken?: string
  admitted: boolean
  requestId?: string
  requestedAt?: number
  status: PlayerStatus
  since: number
  pairing: boolean
  pairSpawned?: () => void
  /** Что игрок выключил себе сам. */
  selfOff: InputPerms
  /** Игрок просит убрать Discord из трансляции. */
  muteChat: boolean
  poorNetwork: boolean
  /** Код из ссылки-приглашения. */
  inviteCode?: string
  viaInvite: boolean
  /** Просьба выдать ввод (что именно просит). */
  inputRequest?: InputPerms
  /** После отказа повторная просьба не раньше этого времени. */
  inputRequestBlockedUntil?: number
  lastSpeedTest?: number
  /** Игрок сам отключился: место после закрытия соединения не держим. */
  leaving?: boolean
  /** Хэш токена возобновления, выданного при допуске (возвращение после короткого обрыва). */
  resumeHash?: string
  /** Токен возобновления из hello. */
  resumeToken?: string
  /** Когда Apollo начал видеть поток игрока (для номера его геймпада). */
  streamStartedAt?: number
  lastIdentify?: number
  /** Ограничение частоты сообщений (маркерное ведро). */
  tokens: number
  tokensAt: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** Сколько неодобренных соединений принимаем всего и с одного адреса. Допущенные игроки в эти лимиты не входят. */
const MAX_PENDING = 12
const MAX_PENDING_PER_IP = 3
/** Слот запуска стрима: пока не подключился предыдущий игрок (или пока не истёк срок), следующий ждёт. */
const LAUNCH_SLOT_MS = 25_000
/** Сообщения от клиента: не больше 40 подряд и 8 в секунду в среднем. */
const BUCKET_SIZE = 40
const BUCKET_RATE = 8
/** Уведомления о запросах с одного адреса не чаще раза в 5 с. */
const NOTIFY_EVERY_MS = 5000
/** Доля избыточных пакетов (FEC), %. Apollo по умолчанию — 20. */
const FEC = { normal: 20, high: 30 } as const
/**
 * Пресеты кодировщика. Apollo по умолчанию — самый быстрый (NVENC P1): на RTX 40/50 запас огромный,
 * и P3 даёт заметно более чистую картинку при почти той же задержке. Двухпроходное кодирование
 * в четверть разрешения оставляем (как в Apollo): оно держит размер кадров ровным, без всплесков в сети.
 * AMD (amd_usage остаётся ultralowlatency) и Intel получают аналогичные ступени.
 */
const ENCODER_PRESETS = {
  latency: { nvenc_preset: '1', nvenc_spatial_aq: 'disabled', amd_quality: 'speed', qsv_preset: 'veryfast', sw_preset: 'ultrafast' },
  balanced: { nvenc_preset: '3', nvenc_spatial_aq: 'disabled', amd_quality: 'balanced', qsv_preset: 'fast', sw_preset: 'superfast' },
  quality: { nvenc_preset: '5', nvenc_spatial_aq: 'enabled', amd_quality: 'quality', qsv_preset: 'medium', sw_preset: 'veryfast' }
} as const

/** Параметры Apollo для выбранного пресета кодировщика или ручной настройки. */
function encoderConfig(h: HostSettings): Record<string, string> {
  if (h.encoderPreset !== 'custom') {
    return {
      ...ENCODER_PRESETS[h.encoderPreset],
      nvenc_twopass: 'quarter_res',
      amd_usage: 'ultralowlatency',
      amd_rc: 'vbr_latency',
      amd_preanalysis: 'disabled',
      amd_vbaq: 'enabled',
      min_threads: '2'
    }
  }
  const c = h.encoderCustom
  const onOff = (v: boolean): string => (v ? 'enabled' : 'disabled')
  return {
    nvenc_preset: String(c.nvPreset),
    nvenc_twopass: c.nvTwoPass,
    nvenc_spatial_aq: onOff(c.nvSpatialAq),
    amd_usage: c.amdUsage,
    amd_quality: c.amdQuality,
    amd_rc: c.amdRc,
    amd_preanalysis: onOff(c.amdPreanalysis),
    amd_vbaq: onOff(c.amdVbaq),
    qsv_preset: c.qsvPreset,
    sw_preset: c.swPreset,
    min_threads: String(c.swThreads)
  }
}
/** Замер скорости: столько данных хост присылает игроку (кусками по 64 КБ) и не чаще раза в 20 с на игрока. */
const SPEED_TEST_BYTES = 4 * 1024 * 1024
const SPEED_CHUNK = randomBytes(64 * 1024)
const SPEED_TEST_EVERY_MS = 20_000

/** Во время чужой игры замер скромнее и порциями: уже играющие не должны получить рывок. */
const SPEED_TEST_SHARED_BYTES = 1536 * 1024

/** Остановка хоста во время асинхронной операции: дальше ничего не делаем. */
class Cancelled extends Error {}

/** Игрок, у которого оборвалось сигнальное соединение: место и права в Apollo держатся, пока он не вернётся. */
interface Grace {
  deviceId: string
  nickname: string
  address: string
  resumeHash: string
  since: number
  selfOff: InputPerms
  muteChat: boolean
  viaInvite: boolean
  timer: NodeJS.Timeout
}

const ALL_INPUT: InputPerms = { keyboard: true, mouse: true, gamepad: true }

export class HostController extends EventEmitter {
  private phase: HostState['phase'] = 'idle'
  private error?: ErrorCode
  private errorDetail?: string
  private wss: WebSocketServer | null = null
  private discovery: DiscoveryResponder | null = null
  private readonly peers = new Map<string, Peer>()
  private pollTimer: NodeJS.Timeout | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private pairQueue: Promise<void> = Promise.resolve()
  private polling: Promise<void> | null = null
  private starting = false
  /** Номер запуска: растёт при каждой остановке, старые асинхронные операции по нему понимают, что устарели. */
  private gen = 0
  /** Выгнанные за эту сессию: даже доверенным нужно снова подтверждение хоста. */
  private readonly kicked = new Set<string>()
  /** Отклонённые: по устройству и по адресу (новый deviceId с того же ПК не обходит паузу). */
  private readonly denyUntil = new Map<string, number>()
  private readonly lastNotify = new Map<string, number>()
  /**
   * Очередь запусков стрима. Apollo держит только один ожидающий запуск: если два друга стартуют
   * одновременно, второй тихо теряется. Поэтому разрешаем запуск по одному, пока предыдущий не подключится.
   */
  private launchQueue: string[] = []
  private activeLaunch: { peerId: string; since: number } | null = null
  private emitTimer: NodeJS.Timeout | null = null
  private lastPollError = 0
  /** Опросы Apollo подряд с ошибкой: несколько подряд — Apollo упал, пробуем поднять службу. */
  private pollFailures = 0
  private lastServiceKick = 0
  private apolloDown = false
  private serviceControl = false
  gamepadDriver = true
  /** Мониторы хоста по логу Apollo. */
  private displays: HostDisplay[] = []
  /** Настройки Apollo, с которыми он сейчас запущен (монитор, FEC): если отличаются, нужен перезапуск. */
  private appliedConfig = ''
  private pendingRestart = false
  private reconfiguring = false
  /** Звук идёт через виртуальные колонки, и Discord можно убрать из трансляции. */
  private routingMode = false
  /**
   * Звук настроен для хостинга: с конца настройки Apollo и до остановки. Раньше режим считался по фазе,
   * и событие помощника, пришедшее между настройкой звука и фазой «running», выключало его на весь хостинг.
   */
  private audioActive = false
  private lastRouter = ''
  private lastAudioSig = ''
  /** Когда Apollo последний раз видел хоть один поток (для закрытия «Desktop» после ухода всех). */
  private lastStreamAt = 0
  private appOpen = false
  private encoder?: HostEncoder
  private gpuNames: string[] = []
  /** Ссылка-приглашение текущего сеанса хостинга. */
  private invite: { code: string; expiresAt: number } | null = null
  /** Хост временно забрал ввод у всех. */
  private inputPaused = false
  private upload: { bytes: number; at: number; mbps?: number } | null = null
  /** Игроки, ждущие возвращения после обрыва (по deviceId). */
  private readonly graces = new Map<string, Grace>()
  /** Чей геймпад в каком слоте XInput: deviceId, 'host' (свой геймпад хоста) или '?' (неизвестно). */
  private readonly padOwner = new Map<number, string>()
  private padsInit = false
  private identifying = false
  private readonly padsSent = new Map<string, string>()
  /** Потолок битрейта, который игроки получили последним (перераспределение при смене числа игроков). */
  private lastCap = 0

  constructor(private readonly d: HostDeps) {
    super()
    this.displays = d.displaysCache?.get() ?? []
    d.audio?.on('router', () => this.onRouterState())
  }

  private log(msg: string, err?: unknown): void {
    this.d.log?.(`[host] ${msg}`, err)
  }

  // ---------- Состояние ----------

  getState(): HostState {
    const players: PlayerView[] = []
    const requests: JoinRequestView[] = []
    for (const p of this.peers.values()) {
      if (!p.deviceId) continue
      if (p.admitted) {
        const f = this.friend(p.deviceId)
        players.push({
          deviceId: p.deviceId,
          nickname: p.nickname,
          address: p.address,
          status: p.status,
          perms: f?.perms ?? this.d.settings.get().host.defaultPerms,
          trusted: f?.trusted ?? false,
          since: p.since,
          rttMs: p.rttMs,
          selfOff: p.selfOff,
          muteChat: p.muteChat,
          poorNetwork: p.poorNetwork,
          inputRequest: p.inputRequest,
          viaInvite: p.viaInvite,
          padSlot: this.slotOf(p.deviceId)
        })
      } else if (p.requestId) {
        requests.push({
          id: p.requestId,
          deviceId: p.deviceId,
          nickname: p.nickname,
          address: p.address,
          at: p.requestedAt ?? Date.now(),
          known: !!this.friend(p.deviceId)
        })
      }
    }
    for (const g of this.graces.values()) {
      const f = this.friend(g.deviceId)
      players.push({
        deviceId: g.deviceId,
        nickname: g.nickname,
        address: g.address,
        status: 'reconnecting',
        perms: f?.perms ?? this.d.settings.get().host.defaultPerms,
        trusted: f?.trusted ?? false,
        since: g.since,
        selfOff: g.selfOff,
        muteChat: g.muteChat,
        poorNetwork: true,
        viaInvite: g.viaInvite,
        padSlot: this.slotOf(g.deviceId)
      })
    }
    players.sort((a, b) => a.since - b.since)
    return {
      phase: this.phase,
      error: this.error,
      errorDetail: this.errorDetail,
      address: this.d.address(),
      hostName: this.d.settings.get().nickname,
      maxPlayers: this.d.settings.get().host.maxPlayers,
      players,
      requests,
      gamepadDriver: this.gamepadDriver,
      audio: this.audioView(),
      pendingRestart: this.pendingRestart,
      encoder: this.encoder,
      wrongGpu: this.wrongGpu(),
      uploadMbps: this.phase === 'running' ? this.upload?.mbps : undefined,
      inputPaused: this.inputPaused,
      apolloDown: this.apolloDown || undefined
    }
  }

  private audioView(): HostAudioState {
    const a = this.d.audio
    const st = a?.routerState
    const h = this.d.settings.get().host
    let unavailable: HostAudioState['unavailable']
    if (!this.routingMode) {
      if (!a?.available) unavailable = 'noHelper'
      else if (!h.chatRouting) unavailable = 'disabled'
      else if (st && !st.virtualFound) unavailable = 'noVirtualSink'
    }
    return {
      chatControl: this.routingMode,
      unavailable,
      chatExcluded: this.routingMode && !!st?.chatExcluded,
      monitoring: this.routingMode && !!st?.monitoring,
      error: st?.error ?? undefined
    }
  }

  /** Помощник сообщил новое состояние звука: обновляем панель и игроков. */
  private onRouterState(): void {
    this.recomputeRouting()
    this.emitState()
    this.broadcastAudio()
  }

  private broadcastAudio(force = false): void {
    const a = this.audioView()
    const sig = `${a.chatControl} ${a.chatExcluded}`
    if (!force && sig === this.lastAudioSig) return
    this.lastAudioSig = sig
    for (const p of this.peers.values()) {
      if (p.admitted) this.send(p, { t: 'audioState', chatControl: a.chatControl, chatExcluded: a.chatExcluded })
    }
  }

  /** Обновления состояния склеиваются: поток сообщений от игроков не превращается в поток перерисовок. */
  private emitState(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emit('state', this.getState())
    }, 30)
  }

  private setPhase(phase: HostState['phase'], error?: ErrorCode, detail?: string): void {
    this.phase = phase
    this.error = error
    this.errorDetail = detail
    // Смена фазы видна сразу.
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
    this.emit('state', this.getState())
  }

  private get admittedCount(): number {
    let n = this.graces.size
    for (const p of this.peers.values()) if (p.admitted) n++
    return n
  }

  private check(gen: number): void {
    if (gen !== this.gen) throw new Cancelled()
  }

  // ---------- Запуск ----------

  /** «Я хост»: проверки, при необходимости установка (UAC), настройка Apollo и запуск сигнализации. */
  async start(): Promise<void> {
    if (this.starting || this.phase === 'running') return
    this.starting = true
    const gen = this.gen
    try {
      this.setPhase('checking')
      if (!this.d.address()) return this.setPhase('error', 'no_radmin')
      const st = await this.d.installer.status()
      this.check(gen)
      this.gamepadDriver = st.gamepadDriver
      // Оригинальный Sunshine занимает те же порты (47984–48010): Apollo рядом с ним не заработает.
      if (st.sunshineRunning) return this.setPhase('error', 'sunshine_conflict')
      if (!st.installed) {
        const bundled = this.d.installer.hasBundledInstaller
        return this.setPhase(bundled ? 'needsInstall' : 'error', bundled ? undefined : 'apollo_install_failed', bundled ? undefined : 'installer not bundled')
      }
      // Одно окно UAC, если чего-то не хватает: правило файрвола или право запускать службу Apollo без админа.
      const needElevation = !st.firewall || !st.serviceControl
      if (needElevation) {
        const res = await this.d.installer.setup({ installApollo: false, firewall: !st.firewall, serviceControl: !st.serviceControl, startService: !st.running })
        this.check(gen)
        if (!res.ok) return this.setPhase('error', res.cancelled ? 'install_cancelled' : 'apollo_unreachable', res.error)
      } else if (!st.running && !(await this.d.installer.startService())) {
        this.check(gen)
        return this.setPhase('error', 'apollo_unreachable', 'ApolloService did not start')
      }
      this.serviceControl = true
      await this.configure(gen)
    } catch (e) {
      this.onStartError(e, 'unknown')
    } finally {
      this.starting = false
    }
  }

  /** Тихая установка Apollo из комплекта (одно окно UAC). */
  async install(): Promise<void> {
    if (this.starting || this.phase === 'running') return
    this.starting = true
    const gen = this.gen
    try {
      this.setPhase('installing')
      const res = await this.d.installer.setup({ installApollo: true, firewall: true, serviceControl: true, startService: true })
      this.check(gen)
      if (!res.ok) {
        return res.cancelled ? this.setPhase('needsInstall', 'install_cancelled') : this.setPhase('error', 'apollo_install_failed', res.error)
      }
      const st = await this.d.installer.status()
      this.check(gen)
      this.gamepadDriver = st.gamepadDriver
      this.serviceControl = st.serviceControl
      await this.configure(gen)
    } catch (e) {
      this.onStartError(e, 'apollo_install_failed')
    } finally {
      this.starting = false
    }
  }

  private onStartError(e: unknown, code: ErrorCode): void {
    if (e instanceof Cancelled) return
    this.log('start failed', e)
    // Хост не запустился: звук возвращается как было.
    if (this.audioActive) void this.updateAudio(false)
    if (this.phase !== 'error') this.setPhase('error', code, String(e))
  }

  /** Учётные данные Apollo, если он уже стоял у пользователя со своим паролем. */
  async submitCredentials(username: string, password: string): Promise<boolean> {
    if (this.phase !== 'needsCredentials' || this.starting) return false
    try {
      await this.d.apollo.login({ username, password })
    } catch {
      return false
    }
    this.d.secrets.update((s) => {
      s.apollo = { username, password }
    })
    this.starting = true
    const gen = this.gen
    void this.configure(gen)
      .catch((e) => this.onStartError(e, 'unknown'))
      .finally(() => (this.starting = false))
    return true
  }

  private async waitForApollo(timeoutMs: number, gen: number): Promise<'ok' | 'needsSetup' | 'down'> {
    const until = Date.now() + timeoutMs
    for (;;) {
      const r = await this.d.apollo.probe()
      this.check(gen)
      if (r !== 'down' || Date.now() > until) return r
      await sleep(1000)
    }
  }

  private async configure(gen: number): Promise<void> {
    this.setPhase('configuring')
    const probe = await this.waitForApollo(45_000, gen)
    if (probe === 'down') return this.setPhase('error', 'apollo_unreachable')
    if (probe === 'needsSetup') {
      const creds = { username: 'streamly', password: randomBytes(18).toString('base64url') }
      await this.d.apollo.setInitialCredentials(creds)
      this.d.secrets.update((s) => {
        s.apollo = creds
      })
    } else if (!this.d.secrets.get().apollo) {
      return this.setPhase('needsCredentials')
    }

    try {
      await this.d.apollo.login(this.d.secrets.get().apollo)
    } catch (e) {
      if (e instanceof ApolloError && e.kind === 'auth') return this.setPhase('needsCredentials', 'apollo_auth')
      throw e
    }
    this.check(gen)

    // Подпись того, что реально записали: настройки, изменённые во время перезапуска, применятся следующим разом.
    const cfg = this.apolloConfig()
    const changed = await this.d.apollo.patchConfig(cfg)
    this.check(gen)
    if (changed) {
      await this.d.apollo.restart()
      await sleep(1500)
      if ((await this.waitForApollo(30_000, gen)) !== 'ok') return this.setPhase('error', 'apollo_unreachable')
      await this.d.apollo.login(this.d.secrets.get().apollo)
      this.check(gen)
    }
    this.appliedConfig = JSON.stringify(cfg)
    this.pendingRestart = this.configSig() !== this.appliedConfig
    await this.refreshDisplays()
    this.check(gen)
    // Звук настраиваем до допуска игроков: от этого зависят условия трансляции, которые они получат.
    await this.updateAudio(true)
    this.check(gen)

    // Пока Streamly не допустил клиента, у него нет прав: прямое подключение Moonlight в обход приложения не пройдёт.
    await this.lockdownAll(false)
    this.check(gen)
    // «Desktop», оставшийся от прошлого запуска (например, после сбоя), держал бы виртуальный монитор и настройки экранов.
    await this.d.apollo.closeApp().catch(() => false)
    this.appOpen = false
    this.check(gen)
    this.kicked.clear()
    this.denyUntil.clear()
    await this.listen(gen)
    this.check(gen)
    this.setPhase('running')
  }

  /** Настройки Apollo, которыми управляет Streamly. */
  private apolloConfig(): Record<string, string> {
    const s = this.d.settings.get()
    const h = s.host
    const virtual = h.display === 'virtual'
    return {
      sunshine_name: `${s.nickname} (Streamly)`,
      // Веб-интерфейс Apollo только с этого ПК: друзья из Radmin (WAN для Apollo) его не увидят.
      origin_web_ui_allowed: 'pc',
      // Виртуальный монитор Apollo создаёт под разрешение игрока. Сам по себе это пустой дополнительный экран
      // (у друзей — чёрная картинка), поэтому на время игры он становится основным или единственным.
      headless_mode: virtual ? 'enabled' : 'disabled',
      // Физический монитор хоста не трогаем: ни разрешение, ни частоту, ни расположение (хост играет на нём сам).
      dd_configuration_option: virtual ? (h.virtualOnly ? 'ensure_only_display' : 'ensure_primary') : 'disabled',
      output_name: virtual || h.display === 'primary' ? '' : h.display,
      // Потолок битрейта на игрока: Apollo кодирует каждому отдельный поток, а исходящий канал хоста общий.
      max_bitrate: String(h.maxBitrateKbps === -1 ? AUTO_BITRATE_CAP_MAX : h.maxBitrateKbps),
      // Избыточные пакеты: потеря части пакетов восстанавливается без пропуска кадра.
      fec_percentage: String(FEC[h.lossProtection]),
      // Одновременных трансляций (в Sunshine по умолчанию одна). Лимит игроков держит сам Streamly,
      // поэтому здесь максимум: смена лимита в настройках не перезапускает Apollo.
      channels: '4',
      ...encoderConfig(h)
    }
  }

  private configSig(): string {
    return JSON.stringify(this.apolloConfig())
  }

  /** Мониторы и кодировщик хоста из лога Apollo (он пишет их при запуске). */
  private async refreshDisplays(): Promise<void> {
    try {
      const log = await this.d.apollo.getLogs()
      const list = parseDisplayDevices(log)
      if (list.length) {
        this.displays = list
        this.d.displaysCache?.set(list)
      }
      if (this.d.gpus && !this.gpuNames.length) this.gpuNames = await this.d.gpus().catch(() => [])
      const enc = parseEncoder(log)
      if (enc) {
        if (enc.vendor === 'software' && this.encoder?.vendor !== 'software') this.log('video is encoded on the CPU (no hardware encoder found)')
        this.encoder = enc
      }
    } catch (e) {
      this.log('displays', e instanceof Error ? e.message : e)
    }
  }

  /**
   * Видео кодирует не лучшая видеокарта. Типичный случай — Ryzen со встроенной графикой и RTX:
   * монитор подключён к материнской плате, и Apollo кодирует на встроенном AMD (или на процессоре).
   */
  private wrongGpu(): HostState['wrongGpu'] {
    const enc = this.encoder
    if (!enc) return undefined
    const nvidia = this.gpuNames.find((n) => /nvidia|geforce|rtx|gtx/i.test(n))
    const radeon = this.gpuNames.find((n) => /radeon rx|radeon pro/i.test(n))
    if (nvidia && enc.vendor !== 'nvenc') return { encoderVendor: enc.vendor, better: nvidia }
    if (!nvidia && radeon && (enc.vendor === 'software' || enc.vendor === 'quicksync')) return { encoderVendor: enc.vendor, better: radeon }
    return undefined
  }

  listDisplays(): HostDisplay[] {
    return this.displays
  }

  /** Настройки поменялись: звук применяется сразу, монитор и FEC — перезапуском Apollo, когда никто не играет. */
  onSettingsChanged(): void {
    if (this.phase !== 'running') return
    void this.updateAudio()
    this.rebalance()
    if (this.configSig() === this.appliedConfig) {
      if (this.pendingRestart) {
        this.pendingRestart = false
        this.emitState()
      }
      return
    }
    // Перезапуск Apollo оборвал бы запуск трансляции или сопряжение: откладываем до свободной минуты.
    const busy = this.appOpen || !!this.activeLaunch || this.launchQueue.length > 0 || [...this.peers.values()].some((p) => p.pairing)
    if (busy) {
      if (!this.pendingRestart) {
        this.pendingRestart = true
        this.emitState()
      }
      return
    }
    void this.reconfigure()
  }

  /** Применяет изменённые настройки Apollo перезапуском (несколько секунд, игроки в это время не играют). */
  private async reconfigure(): Promise<void> {
    if (this.reconfiguring || this.phase !== 'running') return
    const gen = this.gen
    this.reconfiguring = true
    const cfg = this.apolloConfig()
    try {
      if (await this.d.apollo.patchConfig(cfg)) {
        this.check(gen)
        await this.d.apollo.restart()
        await sleep(1500)
        if ((await this.waitForApollo(30_000, gen)) !== 'ok') throw new Error('Apollo did not come back after restart')
        await this.d.apollo.login()
        this.check(gen)
        await this.refreshDisplays()
      }
      this.appliedConfig = JSON.stringify(cfg)
      // Пока Apollo перезапускался, настройки могли снова поменяться: применим при следующей возможности.
      this.pendingRestart = this.configSig() !== this.appliedConfig
      this.log('apollo reconfigured')
      this.emitState()
    } catch (e) {
      if (!(e instanceof Cancelled)) {
        this.log('reconfigure failed', e)
        // Не получилось — повторим, когда все уйдут (idleCheck).
        this.pendingRestart = true
        this.emitState()
      }
    } finally {
      this.reconfiguring = false
      // Запуски, которые ждали, пока Apollo перезапускается.
      if (this.phase === 'running') this.pumpLaunches()
    }
  }

  /**
   * Маршрутизация звука: включена на время хостинга. Discord уходит мимо трансляции, если об этом
   * просит хоть один игрок (звук у всех общий: Apollo захватывает одно устройство на всех).
   */
  private async updateAudio(active = this.audioActive): Promise<void> {
    this.audioActive = active
    const a = this.d.audio
    if (!a?.available) {
      this.routingMode = false
      return
    }
    const h = this.d.settings.get().host
    const opts: RouterOptions = {
      enabled: active && h.chatRouting,
      monitor: h.keepHostAudio,
      excludeChat: [...this.peers.values()].some((p) => p.admitted && p.muteChat)
    }
    const sig = JSON.stringify(opts)
    if (sig !== this.lastRouter) {
      this.lastRouter = sig
      try {
        await a.router(opts)
      } catch (e) {
        this.lastRouter = ''
        this.log('audio router', e instanceof Error ? e.message : e)
      }
    }
    this.recomputeRouting(active)
  }

  /**
   * Режим «звук через виртуальные колонки». Apollo выбирает устройство по первой сессии,
   * поэтому, пока кто-то играет, режим не меняем: новые игроки получат те же условия.
   */
  private recomputeRouting(active = this.audioActive): void {
    if (this.appOpen && active) return
    const st = this.d.audio?.routerState
    const next = active && this.d.settings.get().host.chatRouting && !!this.d.audio?.available && !!st?.virtualFound
    if (next !== this.routingMode) {
      this.routingMode = next
      this.log(`audio routing ${next ? 'on' : 'off'}`)
      this.emitState()
      this.broadcastAudio()
    }
  }

  /**
   * При запуске приложения: если Streamly раньше упал, у друзей в Apollo могли остаться права.
   * Снимаем их и выключаем службу Apollo (она нужна только на время хостинга).
   */
  async lockdownOnBoot(): Promise<void> {
    if (this.phase !== 'idle') return
    try {
      const st = await this.d.installer.status()
      if (!st.installed || !st.running) return
      this.serviceControl = st.serviceControl
      if (this.d.secrets.get().apollo && (await this.d.apollo.probe()) === 'ok') {
        await this.d.apollo.login(this.d.secrets.get().apollo)
        if (this.phase === 'idle') await this.lockdownAll(true)
      }
      if (this.phase === 'idle' && st.serviceControl) await this.d.installer.stopService()
    } catch (e) {
      this.log('boot lockdown failed', e)
    }
  }

  private async listen(gen: number): Promise<void> {
    const port = this.d.signalingPort ?? SIGNALING_PORT
    // Слушаем только адрес в сети Radmin, а не все интерфейсы ПК.
    const host = this.d.address()
    const wss = await new Promise<WebSocketServer>((resolve, reject) => {
      const s = new WebSocketServer({ host, port, maxPayload: 8 * 1024 })
      s.once('listening', () => resolve(s))
      s.once('error', reject)
    }).catch((e: NodeJS.ErrnoException) => {
      // EACCES: порт попал в диапазон, зарезервированный Windows (Hyper-V/WSL), — для пользователя это тоже «порт занят».
      if (gen === this.gen) this.setPhase('error', e.code === 'EADDRINUSE' || e.code === 'EACCES' ? 'port_busy' : 'unknown', `${e.code ?? ''} ${e.message}`.trim())
      throw e
    })
    // Хост остановили, пока сервер запускался: закрываем его, а не оставляем висеть.
    if (gen !== this.gen) {
      wss.close()
      throw new Cancelled()
    }
    this.wss = wss
    wss.on('error', (e) => this.log('signaling server error', e))
    wss.on('connection', (ws, req) => this.onConnection(ws, req.socket.remoteAddress ?? ''))

    const discovery = new DiscoveryResponder(
      () => ({ hostName: this.d.settings.get().nickname, slotsUsed: this.admittedCount, maxSlots: this.d.settings.get().host.maxPlayers }),
      this.d.discoveryPort,
      this.allowedExtra()
    )
    try {
      await discovery.start()
      if (gen !== this.gen) {
        discovery.stop()
        throw new Cancelled()
      }
      this.discovery = discovery
    } catch (e) {
      if (e instanceof Cancelled) throw e
      // Поиск не обязателен: к хосту всегда можно подключиться по IP.
      this.log('discovery responder failed', e)
    }

    this.heartbeat = setInterval(() => {
      let changed = false
      for (const p of this.peers.values()) {
        p.missed = p.alive ? 0 : (p.missed ?? 0) + 1
        if (p.missed >= 3) {
          p.ws.terminate()
          continue
        }
        p.alive = false
        const buf = Buffer.alloc(8)
        buf.writeDoubleLE(performance.now())
        p.ws.ping(buf)
        if (p.admitted) changed = true
        // Запрос, который хост так и не рассмотрел, не держит соединение вечно.
        if (!p.admitted && p.requestedAt && Date.now() - p.requestedAt > (this.d.requestTimeoutMs ?? 180_000)) p.ws.close()
        // Соединение без запроса (поздоровался и молчит) занимало бы место в очереди неодобренных.
        if (!p.admitted && !p.requestId && Date.now() - p.since > 30_000) p.ws.close()
      }
      if (changed) this.emitState()
    }, 5_000)
    this.pollTimer = setInterval(() => {
      if (this.polling) return
      this.polling = this.poll(gen).finally(() => (this.polling = null))
    }, this.d.pollMs ?? 2000)
  }

  /** Адреса, с которых принимаем соединения сверх сети Radmin: свой адрес (проверка на одном ПК) и отладочные. */
  private allowedExtra(): string[] {
    const own = this.d.address()
    return [...(this.d.extraAllowed ?? []), ...(own ? [own] : [])]
  }

  private stopping: Promise<void> | null = null

  /** Остановка хоста. Повторный вызов во время остановки ждёт ту же операцию. */
  stop(): Promise<void> {
    this.stopping ??= this.doStop().finally(() => (this.stopping = null))
    return this.stopping
  }

  private async doStop(): Promise<void> {
    const wasActive = this.phase === 'running' || this.phase === 'configuring'
    this.gen++
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.pollTimer = this.heartbeat = null
    for (const p of [...this.peers.values()]) {
      this.send(p, { t: 'hostStopping' })
      p.ws.close()
    }
    // Друг с упавшим ПК или Radmin не ответит на закрытие, и ws ждал бы его 30 с: через секунду обрываем.
    const sockets = [...(this.wss?.clients ?? [])]
    const cut = setTimeout(() => sockets.forEach((s) => s.terminate()), 1000)
    this.peers.clear()
    for (const id of [...this.graces.keys()]) this.endGrace(id)
    this.launchQueue = []
    this.activeLaunch = null
    this.discovery?.stop()
    this.discovery = null
    const wss = this.wss
    await Promise.race([new Promise<void>((r) => (wss ? wss.close(() => r()) : r())), sleep(3000)])
    clearTimeout(cut)
    sockets.forEach((s) => s.terminate())
    this.wss = null
    // Дожидаемся опроса, который мог уже начаться, иначе он вернул бы права после блокировки.
    await this.polling
    if (wasActive) {
      try {
        await this.lockdownAll(true)
      } catch (e) {
        this.log('lockdown on stop failed', e)
      }
    }
    // Звук хоста возвращается как было: Discord снова «по умолчанию», повтор колонок выключен.
    await this.updateAudio(false)
    this.appOpen = false
    this.pendingRestart = false
    this.invite = null
    this.inputPaused = false
    this.upload = null
    this.apolloDown = false
    this.pollFailures = 0
    this.padOwner.clear()
    this.padsInit = false
    this.padsSent.clear()
    this.lastCap = 0
    // Служба Apollo нужна только на время хостинга: после перезагрузки ПК она сама не запустится.
    if (wasActive && this.serviceControl) await this.d.installer.stopService().catch(() => false)
    this.starting = false
    this.setPhase('idle')
  }

  // ---------- Apollo ----------

  private friend(deviceId: string): TrustedFriend | undefined {
    const friends = this.d.secrets.get().friends
    return Object.hasOwn(friends, deviceId) ? friends[deviceId] : undefined
  }

  /** Убирает права у всех клиентов Apollo, кроме допущенных сейчас. */
  private async lockdownAll(disconnect: boolean): Promise<void> {
    const admittedUuids = new Set(
      [...this.peers.values()].filter((p) => p.admitted && p.deviceId).map((p) => this.friend(p.deviceId!)?.apolloUuid)
    )
    const clients = await this.d.apollo.listClients()
    await Promise.all(
      clients
        .filter((c) => !admittedUuids.has(c.uuid))
        .map(async (c) => {
          if (c.perm !== 0) await this.d.apollo.setPerm(c.uuid, 0)
          if (disconnect && c.connected) await this.d.apollo.disconnect(c.uuid)
        })
    )
  }

  /**
   * Выдаёт (perms — права от хоста) или забирает (null) права. Действуют выданные хостом
   * минус то, что игрок выключил себе сам. Выдача проверяет, что хост не остановили.
   */
  private async applyPerms(deviceId: string, perms: InputPerms | null, gen = this.gen): Promise<void> {
    const uuid = this.friend(deviceId)?.apolloUuid
    if (!uuid) return
    const peer = [...this.peers.values()].find((p) => p.deviceId === deviceId && p.admitted)
    const selfOff = peer?.selfOff ?? this.graces.get(deviceId)?.selfOff
    try {
      if (perms && gen !== this.gen) return
      await this.d.apollo.setPerm(uuid, perms ? toApolloPerm(this.inputPaused ? NO_INPUT : effectivePerms(perms, selfOff)) : 0)
      if (!perms) await this.d.apollo.disconnect(uuid)
    } catch (e) {
      this.log(`applyPerms ${deviceId}`, e)
    }
  }

  /** Раз в 2 с сверяет список клиентов Apollo: статус «в игре», чужие подключения, превышение лимита. */
  private async poll(gen: number): Promise<void> {
    let clients: ApolloClient[]
    try {
      clients = await this.d.apollo.listClients()
    } catch (e) {
      // Пока Apollo недоступен, не засоряем лог каждые 2 с.
      if (Date.now() - this.lastPollError > 30_000) this.log('poll failed', e instanceof Error ? e.message : e)
      this.lastPollError = Date.now()
      await this.onApolloFailure(gen)
      return
    }
    if (gen !== this.gen) return
    if (this.apolloDown || this.pollFailures) {
      if (this.apolloDown) this.log('apollo is back')
      this.pollFailures = 0
      this.apolloDown = false
      this.emitState()
    }
    const byUuid = new Map(clients.map((c) => [c.uuid, c]))
    const known = new Set<string>()
    let changed = false
    for (const p of this.peers.values()) {
      if (!p.admitted || !p.deviceId) continue
      const f = this.friend(p.deviceId)
      if (!f?.apolloUuid) continue
      known.add(f.apolloUuid)
      const c = byUuid.get(f.apolloUuid)
      if (!c) continue
      const next: PlayerStatus = c.connected ? 'streaming' : p.status === 'streaming' ? 'waiting' : p.status
      if (next !== p.status) {
        if (next === 'streaming') p.streamStartedAt = Date.now()
        // Клиент узнаёт от хоста, что стрим действительно идёт (или оборвался).
        if (next === 'streaming' || p.status === 'streaming') this.send(p, { t: 'sessionState', streaming: next === 'streaming' })
        p.status = next
        changed = true
      }
      const want = toApolloPerm(this.inputPaused ? NO_INPUT : effectivePerms(f.perms, p.selfOff))
      if (c.perm !== want && gen === this.gen) await this.d.apollo.setPerm(c.uuid, want).catch(() => undefined)
    }
    // Игроки после обрыва: их поток в Apollo может идти дальше, права держим.
    for (const g of this.graces.values()) {
      const f = this.friend(g.deviceId)
      if (!f?.apolloUuid) continue
      known.add(f.apolloUuid)
      const c = byUuid.get(f.apolloUuid)
      const want = toApolloPerm(this.inputPaused ? NO_INPUT : effectivePerms(f.perms, g.selfOff))
      if (c && c.perm !== want && gen === this.gen) await this.d.apollo.setPerm(c.uuid, want).catch(() => undefined)
    }
    for (const c of clients) {
      if (known.has(c.uuid)) continue
      if (c.perm !== 0) await this.d.apollo.setPerm(c.uuid, 0).catch(() => undefined)
      if (c.connected) await this.d.apollo.disconnect(c.uuid).catch(() => undefined)
    }
    this.pumpLaunches()
    if (await this.trackPads()) changed = true
    if (await this.measureUpload()) changed = true
    if (changed) this.emitState()
    await this.idleCheck(clients.some((c) => c.connected && known.has(c.uuid)), gen)
  }

  /**
   * Apollo не отвечает несколько опросов подряд (служба упала или зависла): показываем это хосту
   * и пробуем запустить службу снова (не чаще раза в минуту). Во время перезапуска с новыми настройками — норма.
   */
  private async onApolloFailure(gen: number): Promise<void> {
    if (this.reconfiguring || gen !== this.gen) return
    this.pollFailures++
    if (this.pollFailures < 5) return
    if (!this.apolloDown) {
      this.apolloDown = true
      this.log('apollo stopped responding')
      this.emitState()
    }
    if (Date.now() - this.lastServiceKick < 60_000) return
    this.lastServiceKick = Date.now()
    const ok = await this.d.installer.startService().catch(() => false)
    this.log(`apollo service restart: ${ok ? 'ok' : 'failed'}`)
    if (ok && gen === this.gen) await this.d.apollo.login().catch(() => undefined)
  }

  /** Исходящий поток хоста по счётчику адаптера Radmin. true — значение заметно изменилось. */
  private async measureUpload(): Promise<boolean> {
    const address = this.d.address()
    if (!this.d.sentBytes || !address) return false
    const bytes = await this.d.sentBytes(address).catch(() => undefined)
    if (bytes === undefined) return false
    const now = Date.now()
    const prev = this.upload
    this.upload = { bytes, at: now, mbps: prev?.mbps }
    if (!prev || now <= prev.at || bytes < prev.bytes) return false
    const mbps = Math.round(((bytes - prev.bytes) * 8) / ((now - prev.at) / 1000) / 1e5) / 10
    this.upload.mbps = mbps
    return prev.mbps === undefined || Math.abs(mbps - prev.mbps) >= 0.5
  }

  /**
   * Все игроки ушли: закрываем «Desktop» в Apollo. Он убирает виртуальный монитор и возвращает экраны
   * и звук хоста, иначе пустой монитор оставался бы до остановки хоста. Заодно применяем отложенные настройки.
   */
  private async idleCheck(anyStreaming: boolean, gen: number): Promise<void> {
    if (anyStreaming) {
      this.lastStreamAt = Date.now()
      if (!this.appOpen) {
        this.appOpen = true
        this.emitState()
      }
      return
    }
    const launching = !!this.activeLaunch || this.launchQueue.length > 0
    if (launching || gen !== this.gen) return
    if (this.appOpen && Date.now() - this.lastStreamAt > (this.d.idleCloseMs ?? 12_000)) {
      this.appOpen = false
      this.log('all players left: closing Desktop in Apollo')
      await this.d.apollo.closeApp().catch((e: unknown) => this.log('closeApp failed', e instanceof Error ? e.message : e))
      this.recomputeRouting()
      this.emitState()
    }
    if (!this.appOpen && this.pendingRestart) void this.reconfigure()
  }

  // ---------- Сигнализация ----------

  private send(p: Peer, msg: HostMessage): void {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(JSON.stringify(msg))
  }

  private onConnection(ws: WebSocket, remote: string): void {
    const address = remote.replace(/^::ffff:/, '')
    if (!isAllowedPeer(address, this.allowedExtra())) {
      ws.close(1008, 'forbidden')
      return
    }
    // Лимиты только для неодобренных: их наплыв не должен мешать друзьям, которые уже играют.
    const pending = [...this.peers.values()].filter((p) => !p.admitted)
    if (pending.length >= MAX_PENDING || pending.filter((p) => p.address === address).length >= MAX_PENDING_PER_IP) {
      ws.close(1013, 'busy')
      return
    }
    const peer: Peer = {
      id: randomUUID(),
      ws,
      address,
      alive: true,
      nickname: '',
      admitted: false,
      status: 'waiting',
      since: Date.now(),
      pairing: false,
      selfOff: { ...NO_INPUT },
      muteChat: false,
      poorNetwork: false,
      viaInvite: false,
      tokens: BUCKET_SIZE,
      tokensAt: Date.now()
    }
    this.peers.set(peer.id, peer)
    ws.on('pong', (data: Buffer) => {
      peer.alive = true
      if (data.length === 8) peer.rttMs = Math.max(0, Math.round(performance.now() - data.readDoubleLE(0)))
    })
    ws.on('message', (data) => {
      // Ограничение частоты: поток сообщений от одного клиента обрывает его соединение.
      const now = Date.now()
      peer.tokens = Math.min(BUCKET_SIZE, peer.tokens + ((now - peer.tokensAt) / 1000) * BUCKET_RATE)
      peer.tokensAt = now
      if (--peer.tokens < 0) {
        this.log(`rate limit: ${peer.address}`)
        return void ws.terminate()
      }
      const msg = parseClientMessage(data)
      if (!msg) return
      peer.alive = true
      void this.onMessage(peer, msg).catch((e) => this.log(`message ${msg.t}`, e))
    })
    ws.on('close', () => void this.onClose(peer))
    ws.on('error', () => undefined)
    // Без hello за 10 с соединение не нужно.
    setTimeout(() => {
      if (!peer.deviceId) ws.close()
    }, 10_000)
  }

  private async onClose(peer: Peer): Promise<void> {
    if (!this.peers.delete(peer.id)) return
    this.launchQueue = this.launchQueue.filter((id) => id !== peer.id)
    this.pumpLaunches()
    if (peer.deviceId && peer.admitted) {
      const stillHere = [...this.peers.values()].some((p) => p.deviceId === peer.deviceId && p.admitted)
      if (!stillHere && !peer.leaving && peer.resumeHash && this.phase === 'running' && !this.kicked.has(peer.deviceId)) {
        // Короткий обрыв (Wi-Fi, Radmin): трансляция Moonlight может идти дальше. Права и место держим,
        // игрок вернётся по токену без подтверждения.
        this.startGrace(peer)
      } else {
        if (!stillHere) await this.applyPerms(peer.deviceId, null)
        if (peer.muteChat) await this.updateAudio()
      }
    }
    this.rebalance()
    this.pushPads()
    this.emitState()
  }

  private startGrace(peer: Peer): void {
    const deviceId = peer.deviceId!
    this.endGrace(deviceId)
    this.log(`${peer.nickname}: signaling lost, holding the place`)
    const timer = setTimeout(() => void this.expireGrace(deviceId), this.d.resumeGraceMs ?? 20_000)
    this.graces.set(deviceId, {
      deviceId,
      nickname: peer.nickname,
      address: peer.address,
      resumeHash: peer.resumeHash!,
      since: peer.since,
      selfOff: peer.selfOff,
      muteChat: peer.muteChat,
      viaInvite: peer.viaInvite,
      timer
    })
  }

  private endGrace(deviceId: string): Grace | undefined {
    const g = this.graces.get(deviceId)
    if (g) {
      clearTimeout(g.timer)
      this.graces.delete(deviceId)
    }
    return g
  }

  /** Игрок не вернулся вовремя: права снимаются, место освобождается. */
  private async expireGrace(deviceId: string): Promise<void> {
    const g = this.endGrace(deviceId)
    if (!g) return
    this.log(`${g.nickname} did not come back`)
    if (!this.isAdmitted(deviceId)) await this.applyPerms(deviceId, null)
    if (g.muteChat) await this.updateAudio()
    this.rebalance()
    this.pushPads()
    this.emitState()
  }

  private isDenied(peer: Peer): boolean {
    const now = Date.now()
    return (this.denyUntil.get(`d:${peer.deviceId}`) ?? 0) > now || (this.denyUntil.get(`a:${peer.address}`) ?? 0) > now
  }

  private async onMessage(peer: Peer, msg: ClientMessage): Promise<void> {
    if (msg.t === 'ping') return this.send(peer, { t: 'pong', ts: typeof msg.ts === 'number' ? msg.ts : undefined })
    if (msg.t === 'hello') {
      if (peer.deviceId) return
      if (msg.v !== PROTOCOL_VERSION) {
        this.send(peer, { t: 'joinDenied', reason: 'version' })
        return void peer.ws.close()
      }
      // Старое соединение того же устройства вытесняется только после допуска нового (см. admit),
      // иначе кто угодно с чужим deviceId мог бы выкинуть друга из игры.
      peer.deviceId = msg.deviceId
      peer.nickname = sanitizeNickname(msg.nickname)
      peer.appVersion = msg.appVersion
      peer.trustToken = msg.trustToken
      peer.resumeToken = msg.resumeToken
      peer.inviteCode = msg.inviteCode
      return this.send(peer, {
        t: 'hostInfo',
        v: PROTOCOL_VERSION,
        hostName: this.d.settings.get().nickname,
        slotsUsed: this.admittedCount,
        maxSlots: this.d.settings.get().host.maxPlayers
      })
    }
    if (!peer.deviceId) return

    switch (msg.t) {
      case 'joinRequest': {
        if (peer.admitted || peer.requestId) return
        const deviceId = peer.deviceId
        const kicked = this.kicked.has(deviceId) || this.kicked.has(`a:${peer.address}`)
        // Возвращение после короткого обрыва: место ещё держится (или хост ещё не заметил обрыва старого
        // соединения), токен совпал — без подтверждения и без разрыва идущей трансляции в Apollo.
        const tokenHash = peer.resumeToken ? sha256(peer.resumeToken) : undefined
        const g = this.graces.get(deviceId)
        const old = [...this.peers.values()].find((p) => p !== peer && p.admitted && p.deviceId === deviceId && p.resumeHash)
        const from = g && g.resumeHash === tokenHash ? g : old && old.resumeHash === tokenHash ? old : undefined
        if (!kicked && tokenHash && from) {
          if (g) this.endGrace(deviceId)
          peer.selfOff = from.selfOff
          peer.muteChat = from.muteChat
          peer.viaInvite = from.viaInvite
          this.log(`${peer.nickname} is back after a short drop`)
          return this.admit(peer, false, undefined, true)
        }
        if (this.isDenied(peer)) {
          this.send(peer, { t: 'joinDenied', reason: 'denied' })
          return void peer.ws.close()
        }
        if (this.admittedCount >= this.d.settings.get().host.maxPlayers && !this.isAdmitted(deviceId)) {
          return this.send(peer, { t: 'joinDenied', reason: 'full' })
        }
        const f = this.friend(deviceId)
        if (!kicked && f?.trusted && f.tokenHash && peer.trustToken && sha256(peer.trustToken) === f.tokenHash) {
          return this.admit(peer, false)
        }
        // Ссылка-приглашение хоста: входит без подтверждения (если это не выключено в настройках).
        if (!kicked && this.validInvite(peer.inviteCode) && this.d.settings.get().host.inviteAutoAdmit) {
          peer.viaInvite = true
          this.log(`${peer.nickname} joined with the invite link`)
          this.emit('inviteJoin', { nickname: peer.nickname })
          return this.admit(peer, false)
        }
        // Если тот же друг уже ждёт подтверждения с другого соединения, новый запрос заменяет старый.
        for (const other of this.peers.values()) {
          if (other !== peer && other.deviceId === deviceId && other.requestId) other.ws.close()
        }
        peer.requestId = randomUUID()
        peer.requestedAt = Date.now()
        // Уведомление Windows — не чаще раза в 5 с с одного адреса.
        if (Date.now() - (this.lastNotify.get(peer.address) ?? 0) > NOTIFY_EVERY_MS) {
          this.lastNotify.set(peer.address, Date.now())
          this.emit('joinRequest', { nickname: peer.nickname })
        }
        return this.emitState()
      }
      case 'pairRequest':
        if (!peer.admitted || peer.pairing) return
        peer.pairing = true
        this.pairQueue = this.pairQueue
          .then(() => this.pair(peer, this.gen))
          .catch((e) => this.log('pair', e))
          .finally(() => (peer.pairing = false))
        return
      case 'pairSpawned':
        peer.pairSpawned?.()
        return
      case 'launchRequest':
        if (!peer.admitted || this.launchQueue.includes(peer.id) || this.activeLaunch?.peerId === peer.id) return
        this.launchQueue.push(peer.id)
        return this.pumpLaunches()
      case 'sessionStarted':
        // Новый запуск: прежний статус «в игре» мог остаться от старой сессии, ждём подтверждения от Apollo заново.
        if (peer.admitted) {
          peer.status = 'connecting'
          this.emitState()
        }
        return
      case 'sessionEnded':
        if (peer.admitted) {
          if (this.activeLaunch?.peerId === peer.id) this.activeLaunch = null
          peer.status = 'waiting'
          peer.poorNetwork = false
          this.pumpLaunches()
          this.emitState()
        }
        return
      case 'prefs': {
        const selfOff: InputPerms = { keyboard: msg.selfOff.keyboard, mouse: msg.selfOff.mouse, gamepad: msg.selfOff.gamepad }
        const inputChanged = JSON.stringify(selfOff) !== JSON.stringify(peer.selfOff)
        const chatChanged = peer.muteChat !== msg.muteChat
        peer.selfOff = selfOff
        peer.muteChat = msg.muteChat
        const f = this.friend(peer.deviceId)
        if (inputChanged && peer.admitted && f?.apolloUuid) await this.applyPerms(peer.deviceId, f.perms)
        if (chatChanged && peer.admitted) await this.updateAudio()
        return this.emitState()
      }
      case 'inputRequest': {
        if (!peer.admitted) return
        if ((peer.inputRequestBlockedUntil ?? 0) > Date.now()) return this.send(peer, { t: 'inputRequestResult', granted: false })
        const granted = this.friend(peer.deviceId)?.perms
        if (!granted) return
        // Просить можно только то, что хост выключил.
        const want: InputPerms = {
          keyboard: msg.perms.keyboard && !granted.keyboard,
          mouse: msg.perms.mouse && !granted.mouse,
          gamepad: msg.perms.gamepad && !granted.gamepad
        }
        if (!want.keyboard && !want.mouse && !want.gamepad) return this.send(peer, { t: 'inputRequestResult', granted: true })
        const first = !peer.inputRequest
        peer.inputRequest = {
          keyboard: want.keyboard || !!peer.inputRequest?.keyboard,
          mouse: want.mouse || !!peer.inputRequest?.mouse,
          gamepad: want.gamepad || !!peer.inputRequest?.gamepad
        }
        if (first) this.emit('inputRequest', { nickname: peer.nickname, perms: peer.inputRequest })
        return this.emitState()
      }
      case 'speedTest': {
        if (!peer.admitted || Date.now() - (peer.lastSpeedTest ?? 0) < SPEED_TEST_EVERY_MS) return this.send(peer, { t: 'speedEnd', bytes: 0 })
        peer.lastSpeedTest = Date.now()
        const shared = this.graces.size > 0 || [...this.peers.values()].some((p) => p !== peer && p.admitted && p.status === 'streaming')
        if (!shared) {
          // Без сжатия и подряд: клиент считает скорость по времени прихода кусков.
          for (let sent = 0; sent < SPEED_TEST_BYTES; sent += SPEED_CHUNK.length) {
            if (peer.ws.readyState !== peer.ws.OPEN) return
            peer.ws.send(SPEED_CHUNK, { binary: true })
          }
          return this.send(peer, { t: 'speedEnd', bytes: SPEED_TEST_BYTES })
        }
        // Кто-то уже играет: меньше данных и порциями с паузами, чтобы его трансляция не дёрнулась.
        // Замер выйдет скромнее настоящего канала — для автоподбора это безопасная сторона.
        // send только ставит данные в очередь: следующую порцию — когда предыдущая ушла в сеть.
        let sent = 0
        while (sent < SPEED_TEST_SHARED_BYTES) {
          if (peer.ws.readyState !== peer.ws.OPEN) return
          peer.ws.send(SPEED_CHUNK, { binary: true })
          sent += SPEED_CHUNK.length
          await sleep(4)
          for (let i = 0; peer.ws.bufferedAmount > 32 * 1024 && i < 500; i++) await sleep(4)
        }
        return this.send(peer, { t: 'speedEnd', bytes: sent })
      }
      case 'leave':
        peer.leaving = true
        return
      case 'identifyPad':
        if (peer.admitted) void this.identifyPad(peer)
        return
      case 'netStatus':
        if (peer.admitted && peer.poorNetwork !== msg.poor) {
          peer.poorNetwork = msg.poor
          if (msg.poor) this.log(`poor network reported by ${peer.nickname} (rtt ${peer.rttMs ?? '?'} ms)`)
          this.emitState()
        }
        return
    }
  }

  private pumpLaunches(): void {
    // Apollo перезапускается: Moonlight подключился бы к выключенному хосту.
    if (this.reconfiguring) return
    const a = this.activeLaunch
    if (a) {
      const p = this.peers.get(a.peerId)
      // Запуск завершён: друг подключился (Apollo видит его поток), ушёл, или вышел срок слота.
      if (!p || !p.admitted || p.status === 'streaming' || Date.now() - a.since > LAUNCH_SLOT_MS) this.activeLaunch = null
    }
    while (!this.activeLaunch && this.launchQueue.length) {
      const id = this.launchQueue.shift()!
      const p = this.peers.get(id)
      if (!p?.admitted) continue
      this.activeLaunch = { peerId: id, since: Date.now() }
      this.send(p, { t: 'launchGo' })
    }
  }

  /** Условия трансляции для игроков: звук на хосте, потолок битрейта, монитор хоста. */
  policy(): StreamPolicy {
    const h = this.d.settings.get().host
    // Виртуальный монитор создаётся под разрешение игрока: ограничивать нечего.
    const chosen = this.displays.find((d) => d.id === h.display)
    const mode = h.display === 'virtual' ? undefined : chosen?.width ? chosen : this.d.displayMode?.()
    return {
      // Через виртуальные колонки: Apollo захватывает их, а хост слышит игру через повтор помощника.
      hostAudio: this.routingMode ? false : h.keepHostAudio,
      // «Авто»: потолок зависит от числа игроков на момент допуска (вместе с этим игроком).
      maxBitrateKbps: h.maxBitrateKbps === -1 ? autoBitrateCap(this.admittedCount) : h.maxBitrateKbps,
      hostWidth: mode?.width ?? 0,
      hostHeight: mode?.height ?? 0,
      hostFps: mode?.fps ?? 0,
      encoder: this.encoder
    }
  }

  private isAdmitted(deviceId: string): boolean {
    return this.graces.has(deviceId) || [...this.peers.values()].some((p) => p.admitted && p.deviceId === deviceId)
  }

  /** Решение хоста по запросу на подключение. */
  async respond(requestId: string, decision: JoinDecision): Promise<void> {
    const peer = [...this.peers.values()].find((p) => p.requestId === requestId)
    if (!peer?.deviceId) return
    peer.requestId = undefined
    if (decision === 'deny') {
      const until = Date.now() + (this.d.denyCooldownMs ?? 30_000)
      this.denyUntil.set(`d:${peer.deviceId}`, until)
      this.denyUntil.set(`a:${peer.address}`, until)
      this.send(peer, { t: 'joinDenied', reason: 'denied' })
      peer.ws.close()
      this.emitState()
      return
    }
    if (this.admittedCount >= this.d.settings.get().host.maxPlayers && !this.isAdmitted(peer.deviceId)) {
      this.send(peer, { t: 'joinDenied', reason: 'full' })
      this.emitState()
      return
    }
    this.kicked.delete(peer.deviceId)
    this.kicked.delete(`a:${peer.address}`)
    await this.admit(peer, decision === 'trust', decision === 'spectate' ? NO_INPUT : undefined)
  }

  /** Список клиентов Apollo с одной повторной попыткой: короткий сбой не должен превращаться в лишнее сопряжение. */
  private async listClientsRetry(): Promise<ApolloClient[] | null> {
    for (let i = 0; i < 2; i++) {
      try {
        return await this.d.apollo.listClients()
      } catch {
        await sleep(700)
      }
    }
    return null
  }

  private async admit(peer: Peer, grantTrust: boolean, perms?: InputPerms, resumed = false): Promise<void> {
    const deviceId = peer.deviceId!
    const gen = this.gen
    // Игрок вернулся (по токену, доверию, ссылке или с подтверждением): место за ним больше не держим отдельно.
    this.endGrace(deviceId)
    // Новое соединение допущено: старое соединение этого же устройства больше не нужно.
    let replaced = false
    for (const other of [...this.peers.values()]) {
      if (other !== peer && other.deviceId === deviceId) {
        replaced ||= other.admitted
        other.admitted = false
        this.peers.delete(other.id)
        other.ws.close()
      }
    }
    let token: string | undefined
    const before = this.friend(deviceId)
    const prevTrust = { trusted: before?.trusted ?? false, tokenHash: before?.tokenHash }
    this.d.secrets.update((s) => {
      const prev = Object.hasOwn(s.friends, deviceId) ? s.friends[deviceId] : undefined
      const f: TrustedFriend = prev ?? {
        deviceId,
        nickname: peer.nickname,
        perms: { ...this.d.settings.get().host.defaultPerms },
        trusted: false,
        addedAt: Date.now()
      }
      f.nickname = peer.nickname
      f.lastSeen = Date.now()
      // «Пустить зрителем»: без клавиатуры, мыши и геймпада.
      if (perms) f.perms = { ...perms }
      if (grantTrust) {
        token = randomBytes(24).toString('base64url')
        f.trusted = true
        f.tokenHash = sha256(token)
      }
      s.friends[deviceId] = f
    })
    peer.admitted = true
    peer.status = 'connecting'
    peer.since = Date.now()
    const f = this.friend(deviceId)!
    // Хост решает, нужно ли сопряжение: знает ли Apollo этого клиента.
    let needsPair = true
    if (f.apolloUuid) {
      const clients = await this.listClientsRetry()
      if (!clients) {
        // Apollo не отвечает: не ломаем рабочее сопряжение, просим подключиться чуть позже.
        // Новое доверие так и не дошло до игрока: возвращаем как было, иначе токен в его руках устарел бы.
        if (token) {
          this.d.secrets.update((s) => {
            const ff = Object.hasOwn(s.friends, deviceId) ? s.friends[deviceId] : undefined
            if (ff) Object.assign(ff, prevTrust)
          })
        }
        peer.admitted = false
        this.send(peer, { t: 'joinDenied', reason: 'busy' })
        peer.ws.close()
        this.emitState()
        return
      }
      needsPair = !clients.some((c) => c.uuid === f.apolloUuid)
      // Переподключение того же устройства: старый поток в Apollo обрываем, чтобы статус не остался «в игре» от него.
      // При возвращении после обрыва трансляция та же самая — её не трогаем.
      if (replaced && !needsPair && !resumed) await this.d.apollo.disconnect(f.apolloUuid).catch(() => undefined)
    }
    if (gen !== this.gen || !this.peers.has(peer.id)) return
    if (!needsPair) await this.applyPerms(deviceId, f.perms, gen)
    // Токен возобновления: после короткого обрыва игрок вернётся без подтверждения (пока хост держит место).
    // Только Streamly 0.5+: старые версии не умеют ни возвращаться, ни сообщать, что уходят сами.
    const resumeToken = versionAtLeast(peer.appVersion, '0.5.0') ? randomBytes(18).toString('base64url') : undefined
    peer.resumeHash = resumeToken ? sha256(resumeToken) : undefined
    this.send(peer, { t: 'joinAccepted', trustToken: token, perms: f.perms, needsPair, policy: this.policy(), resumeToken })
    this.rebalance(peer)
    this.pushPads()
    const audio = this.audioView()
    this.send(peer, { t: 'audioState', chatControl: audio.chatControl, chatExcluded: audio.chatExcluded })
    if (this.inputPaused) this.send(peer, { t: 'inputPaused', paused: true })
    if (peer.muteChat) await this.updateAudio()
    this.emitState()
  }

  /** Сопряжение Moonlight: PIN задаём сами и отправляем его в Apollo. Строго по одному за раз. */
  private async pair(peer: Peer, gen: number): Promise<void> {
    if (gen !== this.gen || !peer.admitted || !peer.deviceId || !this.peers.has(peer.id)) return
    try {
      await this.pairInner(peer, gen)
    } catch (e) {
      // Любая ошибка Apollo по ходу сопряжения: игрок не должен застрять в «сопряжении».
      this.log(`pair error for ${peer.nickname}`, e instanceof Error ? e.message : e)
      if (this.peers.has(peer.id)) {
        peer.status = 'waiting'
        this.send(peer, { t: 'pairResult', ok: false, reason: 'apollo_error' })
        this.emitState()
      }
    } finally {
      peer.pairSpawned = undefined
    }
  }

  private async pairInner(peer: Peer, gen: number): Promise<void> {
    const deviceId = peer.deviceId!
    // Имя клиента в Apollo задаёт хост: уникальный суффикс не позволит спутать его с другим другом.
    const name = `${peer.nickname} · Streamly-${randomBytes(3).toString('hex')}`
    const pin = String(randomInt(0, 10000)).padStart(4, '0')
    peer.status = 'pairing'
    this.emitState()

    // Старые записи этого игрока в Apollo (в том числе «сироты», о которых хост забыл) мешают новому
    // сопряжению: Moonlight посчитает себя уже сопряжённым и не отправит запрос.
    const old = this.friend(deviceId)?.apolloUuid
    const knownUuids = new Set(Object.values(this.d.secrets.get().friends).map((f) => f.apolloUuid).filter(Boolean))
    const prefix = `${peer.nickname} · Streamly-`
    for (const c of await this.d.apollo.listClients()) {
      if (c.uuid === old || (!knownUuids.has(c.uuid) && c.name.startsWith(prefix))) await this.d.apollo.unpair(c.uuid).catch(() => undefined)
    }
    const before = new Set((await this.d.apollo.listClients()).map((c) => c.uuid))

    // Ждём, пока клиент запустит Moonlight. Если игрок отключился, не держим очередь все 15 с.
    let onClose: (() => void) | undefined
    let spawnTimer: NodeJS.Timeout | undefined
    const spawned = new Promise<boolean>((resolve) => {
      peer.pairSpawned = () => resolve(true)
      onClose = () => resolve(false)
      peer.ws.once('close', onClose)
      spawnTimer = setTimeout(() => resolve(false), 15_000)
    })
    this.send(peer, { t: 'pairBegin', pin })
    const ok = await spawned
    clearTimeout(spawnTimer)
    if (onClose) peer.ws.off('close', onClose)

    // PIN уходит первому ожидающему сопряжению. Это может оказаться чужая или старая попытка,
    // поэтому успехом считаем только появление нового клиента с нашим именем.
    let uuid: string | undefined
    let pinAccepted = false
    if (ok) {
      const until = Date.now() + (this.d.pairTimeoutMs ?? 30_000)
      while (!uuid && Date.now() < until && this.peers.has(peer.id) && gen === this.gen) {
        await sleep(1000)
        const accepted = await this.d.apollo.submitPin(pin, name).catch(() => false)
        pinAccepted ||= accepted
        const after = await this.d.apollo.listClients().catch((): ApolloClient[] => [])
        uuid = after.find((c) => !before.has(c.uuid) && c.name === name)?.uuid
        // Чужое сопряжение, получившее наш PIN, не должно остаться в Apollo.
        if (accepted && !uuid) {
          for (const c of after) if (!before.has(c.uuid)) await this.d.apollo.unpair(c.uuid).catch(() => undefined)
        }
      }
    }
    if (!uuid) {
      const reason: PairFailReason = !ok ? 'client_timeout' : pinAccepted ? 'apollo_error' : 'no_request'
      this.log(`pair failed for ${peer.nickname}: ${reason}`)
      peer.status = 'waiting'
      this.send(peer, { t: 'pairResult', ok: false, reason })
      this.emitState()
      return
    }
    this.d.secrets.update((s) => {
      const f = Object.hasOwn(s.friends, deviceId) ? s.friends[deviceId] : undefined
      if (f) {
        f.apolloUuid = uuid
        f.apolloName = name
      }
    })
    // Пока шло сопряжение, игрока могли выгнать, он мог уйти, или хост остановили: прав не выдаём.
    if (gen !== this.gen || !this.peers.has(peer.id) || !peer.admitted) {
      await this.applyPerms(deviceId, null)
      return
    }
    await this.applyPerms(deviceId, this.friend(deviceId)!.perms, gen)
    peer.status = 'connecting'
    this.send(peer, { t: 'pairResult', ok: true })
    this.emitState()
  }

  // ---------- Действия хоста ----------

  /** Меняет только переданные права (быстрые переключения разных пунктов не затирают друг друга). */
  async setPerms(deviceId: string, patch: Partial<InputPerms>): Promise<void> {
    const cur = this.friend(deviceId)?.perms
    if (!cur) return
    const pick = (k: keyof InputPerms): boolean => (typeof patch[k] === 'boolean' ? (patch[k] as boolean) : cur[k])
    const clean: InputPerms = { keyboard: pick('keyboard'), mouse: pick('mouse'), gamepad: pick('gamepad') }
    this.d.secrets.update((s) => {
      s.friends[deviceId].perms = clean
    })
    const peer = [...this.peers.values()].find((p) => p.deviceId === deviceId && p.admitted)
    if (!peer && this.graces.has(deviceId)) await this.applyPerms(deviceId, clean)
    if (peer) {
      await this.applyPerms(deviceId, clean)
      this.send(peer, { t: 'permissionsChanged', perms: clean })
      // Хост сам выдал то, о чём просили: просьба выполнена.
      const req = peer.inputRequest
      if (req && (!req.keyboard || clean.keyboard) && (!req.mouse || clean.mouse) && (!req.gamepad || clean.gamepad)) {
        peer.inputRequest = undefined
        this.send(peer, { t: 'inputRequestResult', granted: true })
      }
    }
    this.emitState()
  }

  /** Ответ на просьбу игрока выдать ввод. Отказ — повторная просьба не раньше чем через 30 с. */
  async respondInput(deviceId: string, grant: boolean): Promise<void> {
    const peer = [...this.peers.values()].find((p) => p.deviceId === deviceId && p.admitted)
    const req = peer?.inputRequest
    if (!peer || !req) return
    peer.inputRequest = undefined
    if (grant) {
      const patch: Partial<InputPerms> = {}
      for (const k of ['keyboard', 'mouse', 'gamepad'] as const) if (req[k]) patch[k] = true
      await this.setPerms(deviceId, patch)
      this.send(peer, { t: 'inputRequestResult', granted: true })
    } else {
      peer.inputRequestBlockedUntil = Date.now() + 30_000
      this.send(peer, { t: 'inputRequestResult', granted: false })
    }
    this.emitState()
  }

  /** Забрать ввод у всех игроков разом (и вернуть). Выданные права при этом не меняются. */
  async setInputPaused(paused: boolean): Promise<void> {
    if (this.phase !== 'running' || this.inputPaused === paused) return
    this.inputPaused = paused
    this.log(paused ? 'input paused for everyone' : 'input resumed')
    for (const p of [...this.peers.values()]) {
      if (!p.admitted || !p.deviceId) continue
      const f = this.friend(p.deviceId)
      if (f?.apolloUuid) await this.applyPerms(p.deviceId, f.perms)
      this.send(p, { t: 'inputPaused', paused })
    }
    this.emitState()
  }

  /**
   * Переподключить геймпады игрока (двойной или зависший геймпад). Streamly 0.4+ сам быстро перезапускает
   * трансляцию — Apollo создаёт виртуальные геймпады заново. У старых версий разрываем сессию в Apollo:
   * клиент переподключится сам.
   */
  async resetGamepad(deviceId: string): Promise<void> {
    const peer = [...this.peers.values()].find((p) => p.deviceId === deviceId && p.admitted)
    if (!peer) return
    this.log(`reset gamepad: ${peer.nickname}`)
    if (versionAtLeast(peer.appVersion, '0.4.0')) return this.send(peer, { t: 'resetGamepad' })
    const uuid = this.friend(deviceId)?.apolloUuid
    if (uuid) await this.d.apollo.disconnect(uuid).catch((e: unknown) => this.log('reset gamepad: disconnect failed', e))
  }

  /** Передать управление: всё получает только этот игрок, у остальных клавиатура, мышь и геймпад снимаются. */
  async passControl(deviceId: string): Promise<void> {
    if (!this.isAdmitted(deviceId)) return
    this.log(`control passed to ${this.friend(deviceId)?.nickname ?? deviceId}`)
    const ids = new Set([...this.peers.values()].filter((p) => p.admitted && p.deviceId).map((p) => p.deviceId!))
    for (const id of this.graces.keys()) ids.add(id)
    // Сначала забираем у остальных, потом выдаём: два игрока не управляют одновременно ни на миг.
    for (const id of ids) if (id !== deviceId) await this.setPerms(id, NO_INPUT)
    await this.setPerms(deviceId, ALL_INPUT)
  }

  /** Зритель: без ввода; выключение возвращает права по умолчанию из настроек. */
  async setSpectator(deviceId: string, on: boolean): Promise<void> {
    await this.setPerms(deviceId, on ? NO_INPUT : this.d.settings.get().host.defaultPerms)
  }

  /**
   * Сделать геймпад игрока первым. Номер геймпада XInput — порядок, в котором Apollo создал виртуальные геймпады,
   * поэтому переподключаем геймпады всех играющих: сначала этого игрока, потом остальных (очередь запусков
   * у хоста сохраняет порядок). Своих геймпадов хоста это не касается: они остаются первыми.
   */
  async makePadFirst(deviceId: string): Promise<void> {
    const players = [...this.peers.values()].filter((p) => p.admitted && p.deviceId && p.status === 'streaming')
    const target = players.find((p) => p.deviceId === deviceId)
    if (!target) return
    const rest = players.filter((p) => p !== target && this.slotOf(p.deviceId!) !== undefined).sort((a, b) => (this.slotOf(a.deviceId!) ?? 9) - (this.slotOf(b.deviceId!) ?? 9))
    this.log(`pad order: ${[target, ...rest].map((p) => p.nickname).join(', ')}`)
    for (const p of [target, ...rest]) {
      await this.resetGamepad(p.deviceId!)
      await sleep(400)
    }
    this.pushPads()
    this.emitState()
  }

  /** Номер геймпада игрока (1–4). */
  private slotOf(deviceId: string): number | undefined {
    for (const [slot, owner] of this.padOwner) if (owner === deviceId) return slot + 1
    return undefined
  }

  /**
   * Номера геймпадов: новый слот XInput приписываем игроку, который раньше всех из недавно начавших
   * трансляцию ещё без геймпада (Apollo создаёт геймпады в порядке подключений, занимая свободный слот
   * с наименьшим номером). Геймпады, что были до начала хостинга, — свои у хоста. Точно — по нажатию (identifyPad).
   */
  private async trackPads(): Promise<boolean> {
    if (!this.d.xinput) return false
    const slots = await this.d.xinput().catch(() => null)
    if (!slots) return false
    let changed = false
    for (const s of [...slots].sort((a, b) => a.index - b.index)) {
      const owner = this.padOwner.get(s.index)
      if (!s.connected) {
        if (owner !== undefined) {
          this.padOwner.delete(s.index)
          changed = true
        }
        continue
      }
      if (owner !== undefined) continue
      changed = true
      if (!this.padsInit) {
        this.padOwner.set(s.index, 'host')
        continue
      }
      const owned = new Set(this.padOwner.values())
      const now = Date.now()
      const candidate = [...this.peers.values()]
        .filter((p) => p.admitted && p.deviceId && p.status === 'streaming' && !owned.has(p.deviceId) && now - (p.streamStartedAt ?? 0) < 20_000)
        .filter((p) => this.friend(p.deviceId!)?.perms.gamepad)
        .sort((a, b) => (a.streamStartedAt ?? 0) - (b.streamStartedAt ?? 0))[0]
      this.padOwner.set(s.index, candidate?.deviceId ?? '?')
    }
    this.padsInit = true
    if (changed) this.pushPads()
    return changed
  }

  /** Игрок спрашивает «какой геймпад мой»: ждём нажатия на любом геймпаде игроков до 10 с. */
  private async identifyPad(peer: Peer): Promise<void> {
    const xinput = this.d.xinput
    // Один поиск за раз, и не чаще раза в 15 с от одного игрока: никто не займёт его постоянно.
    if (!xinput || this.identifying || Date.now() - (peer.lastIdentify ?? 0) < 15_000) return this.send(peer, { t: 'padIdentified', slot: null })
    peer.lastIdentify = Date.now()
    this.identifying = true
    try {
      let prev = ((await xinput().catch(() => null)) ?? []).map((s) => s.active)
      const until = Date.now() + 10_000
      while (Date.now() < until && this.peers.has(peer.id) && peer.admitted) {
        await sleep(120)
        const now = await xinput().catch(() => null)
        if (!now) continue
        // Свои геймпады хоста и уже точно определённые слоты других игроков не в счёт.
        const owned = (i: number): boolean => {
          const o = this.padOwner.get(i)
          return o === 'host' || (!!o && o !== '?' && o !== peer.deviceId)
        }
        const hit = now.find((s) => s.connected && s.active && !prev[s.index] && !owned(s.index))
        prev = now.map((s) => s.active)
        if (!hit) continue
        for (const [slot, owner] of this.padOwner) if (owner === peer.deviceId) this.padOwner.set(slot, '?')
        this.padOwner.set(hit.index, peer.deviceId!)
        this.log(`${peer.nickname} has gamepad ${hit.index + 1}`)
        this.send(peer, { t: 'padIdentified', slot: hit.index + 1 })
        this.pushPads()
        this.emitState()
        return
      }
      this.send(peer, { t: 'padIdentified', slot: null })
    } finally {
      this.identifying = false
    }
  }

  /** Номера геймпадов — каждому игроку (только при изменениях). */
  private pushPads(): void {
    const players = [...this.peers.values()].filter((p) => p.admitted && p.deviceId)
    const base = [
      ...players.map((p) => ({ deviceId: p.deviceId!, nickname: p.nickname, slot: this.slotOf(p.deviceId!) ?? null })),
      ...[...this.graces.values()].map((g) => ({ deviceId: g.deviceId, nickname: g.nickname, slot: this.slotOf(g.deviceId) ?? null }))
    ]
    for (const p of players) {
      const list = base.map((b) => ({ nickname: b.nickname, slot: b.slot, you: b.deviceId === p.deviceId }))
      const sig = JSON.stringify(list)
      if (this.padsSent.get(p.id) === sig) continue
      this.padsSent.set(p.id, sig)
      this.send(p, { t: 'pads', list })
    }
  }

  /**
   * Потолок битрейта «Авто» зависит от числа игроков: при изменении сообщаем всем новые условия.
   * Игрок с битрейтом заметно выше нового потолка перезапустит трансляцию (см. клиент).
   */
  private rebalance(except?: Peer): void {
    if (this.phase !== 'running') return
    const policy = this.policy()
    if (policy.maxBitrateKbps === this.lastCap) return
    const first = this.lastCap === 0
    this.lastCap = policy.maxBitrateKbps
    if (first) return
    this.log(`bitrate cap per player: ${policy.maxBitrateKbps} kbps`)
    for (const p of this.peers.values()) if (p.admitted && p !== except) this.send(p, { t: 'policyUpdate', policy })
  }

  /** Ссылка-приглашение: одна на сеанс хостинга, действует 12 часов (или до остановки хоста). */
  createInvite(): { link: string; expiresAt: number } | null {
    const address = this.d.address()
    if (this.phase !== 'running' || !address) return null
    if (!this.invite || this.invite.expiresAt < Date.now()) {
      this.invite = { code: randomBytes(12).toString('base64url'), expiresAt: Date.now() + (this.d.inviteTtlMs ?? 12 * 3600_000) }
    }
    return { link: makeInviteLink(address, this.d.settings.get().nickname, this.invite.code), expiresAt: this.invite.expiresAt }
  }

  private validInvite(code: string | undefined): boolean {
    const inv = this.invite
    if (!code || !inv || inv.expiresAt < Date.now()) return false
    const a = Buffer.from(code)
    const b = Buffer.from(inv.code)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** Ставит драйвер геймпадов ViGEmBus скриптом Apollo (одно окно UAC), если тихая установка его не поставила. */
  async installGamepadDriver(): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
    const res = await this.d.installer.setup({ installApollo: false, firewall: false, startService: false, installGamepad: true })
    const st = await this.d.installer.status().catch(() => undefined)
    if (st) this.gamepadDriver = st.gamepadDriver
    this.log(`gamepad driver install: ok=${res.ok} cancelled=${!!res.cancelled} ${res.error ?? ''}`)
    this.emitState()
    return { ok: res.ok && this.gamepadDriver, cancelled: res.cancelled, error: res.error }
  }

  /** Отключить всех игроков разом. */
  async kickAll(): Promise<void> {
    const ids = new Set([...this.peers.values()].filter((p) => p.admitted && p.deviceId).map((p) => p.deviceId!))
    for (const id of this.graces.keys()) ids.add(id)
    for (const id of ids) await this.kick(id)
  }

  /**
   * Самопроверка хоста: всё, что нужно, чтобы друзья могли подключиться.
   * Каждый пункт с подсказкой, что исправить.
   */
  async selfCheck(): Promise<CheckReport> {
    const items: CheckItem[] = []
    const add = (id: string, status: CheckItem['status'], hint?: string, value?: string): void => {
      items.push({ id, status, hint: status === 'ok' ? undefined : hint, value })
    }
    const address = this.d.address()
    add('radmin', address ? 'ok' : 'fail', 'radmin', address)
    let st: ApolloInstallStatus | undefined
    try {
      st = await this.d.installer.status()
    } catch {
      /* нет данных */
    }
    const hosting = this.phase === 'running'
    add('apolloInstalled', st?.installed ? 'ok' : 'fail', 'apolloInstall')
    // Служба Apollo работает только во время хостинга, вне его её остановка — норма.
    add('apolloService', st?.running ? 'ok' : hosting ? 'fail' : 'skip', 'apolloService')
    add('sunshine', st?.sunshineRunning ? 'fail' : 'ok', 'sunshine')
    add('firewall', st?.firewall ? 'ok' : 'warn', 'firewall')
    add('gamepadDriver', st?.gamepadDriver ? 'ok' : 'warn', 'vigem')
    // Версия Apollo: установленный раньше Apollo не обновляется сам вместе со Streamly.
    const bundled = this.d.bundledApolloVersion
    if (st?.installed && st.version && st.version !== '0.0.0') {
      const outdated = !!bundled && !versionAtLeast(st.version, bundled)
      add('apolloVersion', outdated ? 'warn' : 'ok', 'apolloOutdated', outdated ? `${st.version} → ${bundled}` : st.version)
    }
    if (st?.running) {
      const probe = await this.d.apollo.probe().catch(() => 'down' as const)
      add('apolloApi', probe === 'down' ? 'fail' : 'ok', 'apolloApi')
      if (this.d.portOpen) {
        const ports = [47984, 47989, 48010]
        const open = await Promise.all(ports.map((p) => this.d.portOpen!('127.0.0.1', p)))
        add('apolloPorts', open.every(Boolean) ? 'ok' : 'fail', 'apolloPorts', ports.filter((_, i) => !open[i]).join(', ') || undefined)
      }
    }
    add('hosting', hosting ? 'ok' : 'warn', 'hosting')
    if (this.encoder) {
      const wrong = this.wrongGpu()
      add('encoder', this.encoder.vendor === 'software' || wrong ? 'warn' : 'ok', wrong ? 'wrongGpu' : 'softwareEncoder', wrong ? `${this.encoder.vendor} → ${wrong.better}` : this.encoder.vendor)
    }
    const h = this.d.settings.get().host
    add('audio', h.keepHostAudio ? 'ok' : 'warn', 'hostAudio')
    if (hosting) {
      const audio = this.audioView()
      const hint = audio.error
        ? 'chatRoutingError'
        : audio.unavailable === 'noVirtualSink'
          ? 'noVirtualSink'
          : audio.unavailable === 'disabled'
            ? 'chatDisabled'
            : audio.unavailable === 'noHelper'
              ? 'noHelper'
              : 'chatStarting'
      // Discord мимо трансляции — дополнительная возможность: выключена в настройках — не проблема.
      const status = audio.chatControl && !audio.error ? 'ok' : audio.unavailable === 'disabled' || audio.unavailable === 'noHelper' ? 'skip' : 'warn'
      add('chatRouting', status, hint, audio.error)
    }
    const failed = items.some((i) => i.status === 'fail')
    return { target: address, items, summary: failed ? 'hostProblems' : items.some((i) => i.status === 'warn') ? 'hostWarnings' : 'hostOk' }
  }

  async kick(deviceId: string): Promise<void> {
    // До следующего запуска хоста выгнанному нужно снова подтверждение, даже если он доверенный.
    this.kicked.add(deviceId)
    const g = this.endGrace(deviceId)
    if (g) this.kicked.add(`a:${g.address}`)
    // Ссылку-приглашение выгнанный тоже знает: она меняется, а с его адреса без подтверждения больше не пускаем.
    this.invite = null
    for (const p of [...this.peers.values()]) {
      if (p.deviceId !== deviceId) continue
      this.kicked.add(`a:${p.address}`)
      this.send(p, { t: 'kicked' })
      p.admitted = false
      p.ws.close()
      this.peers.delete(p.id)
      this.launchQueue = this.launchQueue.filter((id) => id !== p.id)
    }
    this.pumpLaunches()
    await this.applyPerms(deviceId, null)
    await this.updateAudio()
    this.rebalance()
    this.pushPads()
    this.emitState()
  }

  listTrusted(): TrustedFriendView[] {
    return Object.values(this.d.secrets.get().friends)
      .filter((f) => f.trusted)
      .map((f) => ({ deviceId: f.deviceId, nickname: f.nickname, addedAt: f.addedAt, lastSeen: f.lastSeen }))
      .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
  }

  /** Убирает друга из доверенных и снимает сопряжение в Apollo. */
  async removeTrusted(deviceId: string): Promise<void> {
    const f = this.friend(deviceId)
    if (!f) return
    await this.kick(deviceId)
    if (f.apolloUuid) await this.d.apollo.unpair(f.apolloUuid).catch(() => undefined)
    this.d.secrets.update((s) => {
      delete s.friends[deviceId]
    })
    this.emitState()
  }
}
