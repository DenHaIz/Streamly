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
import type { ErrorCode, HostState, JoinRequestView, PlayerStatus, PlayerView, TrustedFriendView } from '@shared/types'
import type { JoinDecision } from '@shared/ipc'
import type { ApolloApi, ApolloClient } from '../apollo/api'
import { ApolloError } from '../apollo/api'
import type { ApolloInstallStatus } from '../apollo/installer'
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
  setup(opts: { installApollo: boolean; firewall: boolean; startService: boolean }): Promise<ElevatedResult>
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
  pairTimeoutMs?: number
  /** Сколько отклонённый друг не может повторить запрос. */
  denyCooldownMs?: number
  log?: (msg: string, err?: unknown) => void
}

interface Peer {
  id: string
  ws: WebSocket
  address: string
  alive: boolean
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
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

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
  private readonly denyUntil = new Map<string, number>()
  /**
   * Очередь запусков стрима. Apollo держит только один ожидающий запуск: если два друга стартуют
   * одновременно, второй тихо теряется. Поэтому разрешаем запуск по одному, пока предыдущий не подключится.
   */
  private launchQueue: string[] = []
  private activeLaunch: { peerId: string; since: number } | null = null
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
          since: p.since
        })
      } else if (p.requestId) {
        requests.push({ id: p.requestId, deviceId: p.deviceId, nickname: p.nickname, address: p.address, at: p.requestedAt ?? Date.now() })
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

  private emitState(): void {
    this.emit('state', this.getState())
  }

  private setPhase(phase: HostState['phase'], error?: ErrorCode, detail?: string): void {
    this.phase = phase
    this.error = error
    this.errorDetail = detail
    this.emitState()
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
      if (!st.running || !st.firewall) {
        const res = await this.d.installer.setup({ installApollo: false, firewall: !st.firewall, startService: !st.running })
        this.check(gen)
        if (!res.ok) return this.setPhase('error', res.cancelled ? 'install_cancelled' : 'apollo_unreachable', res.error)
      }
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
      const res = await this.d.installer.setup({ installApollo: true, firewall: true, startService: false })
      this.check(gen)
      if (!res.ok) {
        return res.cancelled ? this.setPhase('needsInstall', 'install_cancelled') : this.setPhase('error', 'apollo_install_failed', res.error)
      }
      const st = await this.d.installer.status()
      this.check(gen)
      this.gamepadDriver = st.gamepadDriver
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
      headless_mode: settings.host.useVirtualDisplay ? 'enabled' : 'disabled'
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
    await this.listen()
    this.check(gen)
    this.setPhase('running')
  }

  /**
   * При запуске приложения: если Streamly раньше упал или ПК перезагрузился, у друзей в Apollo
   * могли остаться права. Снимаем их, не дожидаясь нажатия «Я хост».
   */
  async lockdownOnBoot(): Promise<void> {
    if (!this.d.secrets.get().apollo || this.phase !== 'idle') return
    try {
      if ((await this.d.apollo.probe()) !== 'ok') return
      await this.d.apollo.login(this.d.secrets.get().apollo)
      if (this.phase === 'idle') await this.lockdownAll(true)
    } catch (e) {
      this.log('boot lockdown failed', e)
    }
  }

  private async listen(): Promise<void> {
    const port = this.d.signalingPort ?? SIGNALING_PORT
    this.wss = await new Promise<WebSocketServer>((resolve, reject) => {
      const wss = new WebSocketServer({ port, maxPayload: 8 * 1024 })
      wss.once('listening', () => resolve(wss))
      wss.once('error', reject)
    }).catch((e: NodeJS.ErrnoException) => {
      this.setPhase('error', e.code === 'EADDRINUSE' ? 'port_busy' : 'unknown', e.message)
      throw e
    })
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req.socket.remoteAddress ?? ''))

    this.discovery = new DiscoveryResponder(
      () => ({ hostName: this.d.settings.get().nickname, slotsUsed: this.admittedCount, maxSlots: this.d.settings.get().host.maxPlayers }),
      this.d.discoveryPort,
      this.d.extraAllowed
    )
    try {
      await this.discovery.start()
    } catch (e) {
      // Поиск не обязателен: к хосту всегда можно подключиться по IP.
      this.log('discovery responder failed', e)
      this.discovery = null
    }

    this.heartbeat = setInterval(() => {
      for (const p of this.peers.values()) {
        if (!p.alive) {
          p.ws.terminate()
          continue
        }
        p.alive = false
        p.ws.ping()
      }
    }, 10_000)
    const gen = this.gen
    this.pollTimer = setInterval(() => {
      if (this.polling) return
      this.polling = this.poll(gen).finally(() => (this.polling = null))
    }, this.d.pollMs ?? 2000)
  }

  private stopping: Promise<void> | null = null

  /** Остановка хоста. Повторный вызов во время остановки ждёт ту же операцию. */
  stop(): Promise<void> {
    this.stopping ??= this.doStop().finally(() => (this.stopping = null))
    return this.stopping
  }

  private async doStop(): Promise<void> {
    const wasRunning = this.phase === 'running'
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
    if (wasRunning || this.phase === 'configuring') {
      try {
        await this.lockdownAll(true)
      } catch (e) {
        this.log('lockdown on stop failed', e)
      }
    }
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
      this.log('poll failed', e)
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
    if (!isAllowedPeer(address, this.d.extraAllowed)) {
      ws.close(1008, 'forbidden')
      return
    }
    if (this.peers.size >= 16) {
      ws.close(1013, 'busy')
      return
    }
    const peer: Peer = { id: randomUUID(), ws, address, alive: true, nickname: '', admitted: false, status: 'waiting', since: Date.now(), pairing: false }
    this.peers.set(peer.id, peer)
    ws.on('pong', () => (peer.alive = true))
    ws.on('message', (data) => {
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

  private async onMessage(peer: Peer, msg: ClientMessage): Promise<void> {
    if (msg.t === 'ping') return this.send(peer, { t: 'pong' })
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
        if ((this.denyUntil.get(deviceId) ?? 0) > Date.now()) {
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
        this.emit('joinRequest', { nickname: peer.nickname })
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
        if (peer.admitted && peer.status !== 'streaming') {
          peer.status = 'connecting'
          this.emitState()
        }
        return
      case 'sessionEnded':
        if (peer.admitted) {
          peer.status = 'waiting'
          this.emitState()
        }
        return
    }
  }

  private pumpLaunches(): void {
    const a = this.activeLaunch
    if (a) {
      const p = this.peers.get(a.peerId)
      // Запуск завершён: друг подключился, ушёл, или прошло достаточно времени (у Apollo таймаут ожидания 10 с).
      if (!p || !p.admitted || p.status === 'streaming' || Date.now() - a.since > 12_000) this.activeLaunch = null
    }
    while (!this.activeLaunch && this.launchQueue.length) {
      const id = this.launchQueue.shift()!
      const p = this.peers.get(id)
      if (!p?.admitted) continue
      this.activeLaunch = { peerId: id, since: Date.now() }
      this.send(p, { t: 'launchGo' })
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
      this.denyUntil.set(peer.deviceId, Date.now() + (this.d.denyCooldownMs ?? 30_000))
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

  private async admit(peer: Peer, grantTrust: boolean): Promise<void> {
    const deviceId = peer.deviceId!
    const gen = this.gen
    // Новое соединение допущено: старое соединение этого же устройства больше не нужно.
    for (const other of [...this.peers.values()]) {
      if (other !== peer && other.deviceId === deviceId) {
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
      const clients = await this.d.apollo.listClients().catch((): ApolloClient[] => [])
      needsPair = !clients.some((c) => c.uuid === f.apolloUuid)
    }
    if (gen !== this.gen || !this.peers.has(peer.id)) return
    if (!needsPair) await this.applyPerms(deviceId, f.perms, gen)
    this.send(peer, { t: 'joinAccepted', trustToken: token, perms: f.perms, needsPair })
    this.emitState()
  }

  /** Сопряжение Moonlight: PIN задаём сами и отправляем его в Apollo. Строго по одному за раз. */
  private async pair(peer: Peer, gen: number): Promise<void> {
    if (gen !== this.gen || !peer.admitted || !peer.deviceId || !this.peers.has(peer.id)) return
    const deviceId = peer.deviceId
    // Имя клиента в Apollo задаёт хост: уникальный суффикс не позволит спутать его с другим другом.
    const name = `${peer.nickname} · Streamly-${randomBytes(3).toString('hex')}`
    const pin = String(randomInt(0, 10000)).padStart(4, '0')
    peer.status = 'pairing'
    this.emitState()

    const old = this.friend(deviceId)?.apolloUuid
    if (old) await this.d.apollo.unpair(old).catch(() => undefined)
    const before = new Set((await this.d.apollo.listClients()).map((c) => c.uuid))

    const spawned = new Promise<void>((resolve) => (peer.pairSpawned = resolve))
    this.send(peer, { t: 'pairBegin', pin })
    const ok = await Promise.race([spawned.then(() => true), sleep(15_000).then(() => false)])
    peer.pairSpawned = undefined

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

  async kick(deviceId: string): Promise<void> {
    // До следующего запуска хоста выгнанному нужно снова подтверждение, даже если он доверенный.
    this.kicked.add(deviceId)
    for (const p of [...this.peers.values()]) {
      if (p.deviceId !== deviceId) continue
      this.send(p, { t: 'kicked' })
      p.admitted = false
      p.ws.close()
      this.peers.delete(p.id)
    }
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
