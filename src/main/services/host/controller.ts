import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'
import { toApolloPerm, type InputPerms } from '@shared/perms'
import {
  parseClientMessage,
  PROTOCOL_VERSION,
  sanitizeNickname,
  SIGNALING_PORT,
  type ClientMessage,
  type HostMessage,
  type PairFailReason
} from '@shared/protocol'
import type { CheckItem, CheckReport, ErrorCode, HostState, JoinRequestView, PlayerStatus, PlayerView, StreamPolicy, TrustedFriendView } from '@shared/types'
import type { JoinDecision } from '@shared/ipc'
import type { ApolloApi, ApolloClient } from '../apollo/api'
import { ApolloError } from '../apollo/api'
import type { ApolloInstallStatus, SetupOptions } from '../apollo/installer'
import type { ElevatedResult } from '../../elevate'
import type { SecretsService, SettingsService, TrustedFriend } from '../../settings'
import { DiscoveryResponder, isAllowedPeer } from '../net/discovery'

export type ApolloLike = Pick<
  ApolloApi,
  'probe' | 'setInitialCredentials' | 'login' | 'listClients' | 'setPerm' | 'disconnect' | 'unpair' | 'submitPin' | 'patchConfig' | 'restart'
>

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
  trustToken?: string
  admitted: boolean
  requestId?: string
  requestedAt?: number
  status: PlayerStatus
  since: number
  pairing: boolean
  pairSpawned?: () => void
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

/** Остановка хоста во время асинхронной операции: дальше ничего не делаем. */
class Cancelled extends Error {}

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
  private serviceControl = false
  gamepadDriver = true

  constructor(private readonly d: HostDeps) {
    super()
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
          rttMs: p.rttMs
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
      gamepadDriver: this.gamepadDriver
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
    let n = 0
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

    const settings = this.d.settings.get()
    const changed = await this.d.apollo.patchConfig({
      sunshine_name: `${settings.nickname} (Streamly)`,
      // Веб-интерфейс Apollo только с этого ПК: друзья из Radmin (WAN для Apollo) его не увидят.
      origin_web_ui_allowed: 'pc',
      headless_mode: settings.host.useVirtualDisplay ? 'enabled' : 'disabled',
      // Не менять разрешение и частоту монитора хоста под каждого игрока: хост играет на нём сам.
      dd_configuration_option: 'disabled',
      // Потолок битрейта на игрока: Apollo кодирует каждому отдельный поток, а исходящий канал хоста общий.
      max_bitrate: String(settings.host.maxBitrateKbps)
    })
    this.check(gen)
    if (changed) {
      await this.d.apollo.restart()
      await sleep(1500)
      if ((await this.waitForApollo(30_000, gen)) !== 'ok') return this.setPhase('error', 'apollo_unreachable')
      await this.d.apollo.login(this.d.secrets.get().apollo)
      this.check(gen)
    }

    // Пока Streamly не допустил клиента, у него нет прав: прямое подключение Moonlight в обход приложения не пройдёт.
    await this.lockdownAll(false)
    this.check(gen)
    this.kicked.clear()
    this.denyUntil.clear()
    await this.listen(gen)
    this.check(gen)
    this.setPhase('running')
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
    this.peers.clear()
    this.launchQueue = []
    this.activeLaunch = null
    this.discovery?.stop()
    this.discovery = null
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()))
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

  /** Выдаёт (perms) или забирает (null) права. Выдача проверяет, что хост не остановили. */
  private async applyPerms(deviceId: string, perms: InputPerms | null, gen = this.gen): Promise<void> {
    const uuid = this.friend(deviceId)?.apolloUuid
    if (!uuid) return
    try {
      if (perms && gen !== this.gen) return
      await this.d.apollo.setPerm(uuid, perms ? toApolloPerm(perms) : 0)
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
      return
    }
    if (gen !== this.gen) return
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
        // Клиент узнаёт от хоста, что стрим действительно идёт (или оборвался).
        if (next === 'streaming' || p.status === 'streaming') this.send(p, { t: 'sessionState', streaming: next === 'streaming' })
        p.status = next
        changed = true
      }
      const want = toApolloPerm(f.perms)
      if (c.perm !== want && gen === this.gen) await this.d.apollo.setPerm(c.uuid, want).catch(() => undefined)
    }
    for (const c of clients) {
      if (known.has(c.uuid)) continue
      if (c.perm !== 0) await this.d.apollo.setPerm(c.uuid, 0).catch(() => undefined)
      if (c.connected) await this.d.apollo.disconnect(c.uuid).catch(() => undefined)
    }
    this.pumpLaunches()
    if (changed) this.emitState()
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
      if (!stillHere) await this.applyPerms(peer.deviceId, null)
    }
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
      peer.trustToken = msg.trustToken
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
        if (this.isDenied(peer)) {
          this.send(peer, { t: 'joinDenied', reason: 'denied' })
          return void peer.ws.close()
        }
        if (this.admittedCount >= this.d.settings.get().host.maxPlayers && !this.isAdmitted(deviceId)) {
          return this.send(peer, { t: 'joinDenied', reason: 'full' })
        }
        const f = this.friend(deviceId)
        if (!this.kicked.has(deviceId) && f?.trusted && f.tokenHash && peer.trustToken && sha256(peer.trustToken) === f.tokenHash) {
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
          this.pumpLaunches()
          this.emitState()
        }
        return
    }
  }

  private pumpLaunches(): void {
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
    const mode = this.d.displayMode?.()
    return {
      hostAudio: h.keepHostAudio,
      maxBitrateKbps: h.maxBitrateKbps,
      hostWidth: mode?.width ?? 0,
      hostHeight: mode?.height ?? 0,
      hostFps: mode?.fps ?? 0
    }
  }

  private isAdmitted(deviceId: string): boolean {
    return [...this.peers.values()].some((p) => p.admitted && p.deviceId === deviceId)
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
    await this.admit(peer, decision === 'trust')
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

  private async admit(peer: Peer, grantTrust: boolean): Promise<void> {
    const deviceId = peer.deviceId!
    const gen = this.gen
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
        peer.admitted = false
        this.send(peer, { t: 'joinDenied', reason: 'busy' })
        peer.ws.close()
        this.emitState()
        return
      }
      needsPair = !clients.some((c) => c.uuid === f.apolloUuid)
      // Переподключение того же устройства: старый поток в Apollo обрываем, чтобы статус не остался «в игре» от него.
      if (replaced && !needsPair) await this.d.apollo.disconnect(f.apolloUuid).catch(() => undefined)
    }
    if (gen !== this.gen || !this.peers.has(peer.id)) return
    if (!needsPair) await this.applyPerms(deviceId, f.perms, gen)
    this.send(peer, { t: 'joinAccepted', trustToken: token, perms: f.perms, needsPair, policy: this.policy() })
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
    const spawned = new Promise<boolean>((resolve) => {
      peer.pairSpawned = () => resolve(true)
      peer.ws.once('close', () => resolve(false))
      setTimeout(() => resolve(false), 15_000)
    })
    this.send(peer, { t: 'pairBegin', pin })
    const ok = await spawned

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
    if (peer) {
      await this.applyPerms(deviceId, clean)
      this.send(peer, { t: 'permissionsChanged', perms: clean })
    }
    this.emitState()
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
    const h = this.d.settings.get().host
    add('audio', h.keepHostAudio ? 'ok' : 'warn', 'hostAudio')
    const failed = items.some((i) => i.status === 'fail')
    return { target: address, items, summary: failed ? 'hostProblems' : items.some((i) => i.status === 'warn') ? 'hostWarnings' : 'hostOk' }
  }

  async kick(deviceId: string): Promise<void> {
    // До следующего запуска хоста выгнанному нужно снова подтверждение, даже если он доверенный.
    this.kicked.add(deviceId)
    for (const p of [...this.peers.values()]) {
      if (p.deviceId !== deviceId) continue
      this.send(p, { t: 'kicked' })
      p.admitted = false
      p.ws.close()
      this.peers.delete(p.id)
      this.launchQueue = this.launchQueue.filter((id) => id !== p.id)
    }
    this.pumpLaunches()
    await this.applyPerms(deviceId, null)
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
