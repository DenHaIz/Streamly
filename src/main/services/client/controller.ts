import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import type { InputPerms } from '@shared/perms'
import { parseHostMessage, PROTOCOL_VERSION, SIGNALING_PORT, type ClientMessage, type HostMessage } from '@shared/protocol'
import type { ClientState, DiscoveredHost, ErrorCode, HostSource, StreamSettings } from '@shared/types'
import type { SecretsService, SettingsService } from '../../settings'
import type { MoonlightProcess } from '../moonlight/runner'
import type { ProbeResult } from '../net/discovery'

export interface MoonlightLike {
  readonly available: boolean
  pair(host: string, pin: string): MoonlightProcess
  list(host: string): MoonlightProcess
  stream(host: string, settings: StreamSettings, native?: { width: number; height: number }): MoonlightProcess
}

export interface ClientDeps {
  settings: SettingsService
  secrets: SecretsService
  moonlight: MoonlightLike
  appVersion: string
  /** Разрешение основного экрана клиента (для режима «авто»). */
  nativeResolution?: () => { width: number; height: number } | undefined
  /** Поиск хостов. */
  probe: (targets: string[], onFound: (r: ProbeResult) => void) => Promise<ProbeResult[]>
  neighbors: () => Promise<string[]>
  signalingPort?: number
  connectTimeoutMs?: number
  /** Сколько ждать, пока хост увидит стрим, прежде чем считать запуск неудачным. */
  streamStartTimeoutMs?: number
  /** Сколько ждать восстановления, если хост перестал видеть стрим. */
  streamLostGraceMs?: number
  /** Хвост лога Moonlight с момента since (для подробностей ошибки). */
  moonlightLog?: (since: number) => string | undefined
  /** Пауза перед закрытием окна сопряжения, чтобы Moonlight успел сохранить сертификат хоста. */
  pairSettleMs?: number
  log?: (msg: string, err?: unknown) => void
}

const ACTIVE: ClientState['phase'][] = ['connecting', 'waitingApproval', 'pairing', 'launching', 'streaming']

export class ClientController extends EventEmitter {
  private state: ClientState = { phase: 'idle' }
  private ws: WebSocket | null = null
  private pairProc: MoonlightProcess | null = null
  private streamProc: MoonlightProcess | null = null
  private listProc: MoonlightProcess | null = null
  private timers: { start?: NodeJS.Timeout; lost?: NodeJS.Timeout } = {}
  private connectedAt = 0
  private streamStartedAt = 0
  private launchAddress: string | null = null
  private hosts = new Map<string, DiscoveredHost>()
  private discovering = false
  /** Номер попытки: колбэки старых попыток игнорируются. */
  private attempt = 0

  constructor(private readonly d: ClientDeps) {
    super()
  }

  private log(msg: string, err?: unknown): void {
    this.d.log?.(`[client] ${msg}`, err)
  }

  getState(): ClientState {
    return this.state
  }

  private set(next: Partial<ClientState>): void {
    this.state = { ...this.state, ...next }
    this.emit('state', this.state)
  }

  private fail(error: ErrorCode, detail?: string): void {
    this.teardown()
    this.set({ phase: 'error', error, errorDetail: detail })
  }

  // ---------- Поиск ----------

  getHosts(): DiscoveredHost[] {
    return [...this.hosts.values()].sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen)
  }

  private upsertHost(h: Omit<DiscoveredHost, 'lastSeen'>): void {
    const prev = this.hosts.get(h.address)
    this.hosts.set(h.address, { ...prev, ...h, source: prev?.online && !h.online ? prev.source : h.source, lastSeen: Date.now() })
    this.emit('hosts', this.getHosts())
  }

  async discover(): Promise<void> {
    if (this.discovering) return
    this.discovering = true
    try {
      const recent = this.d.settings.get().recentHosts
      // Недавние хосты показываем сразу (офлайн), пока не ответят.
      for (const h of recent) {
        if (!this.hosts.has(h.address)) {
          this.upsertHost({ address: h.address, name: h.name, slotsUsed: 0, maxSlots: 4, source: 'recent', online: false })
        }
      }
      const neighbors = await this.d.neighbors().catch((): string[] => [])
      const targets = [...recent.map((h) => h.address), ...neighbors]
      const seen = new Set<string>()
      await this.d.probe(targets, (r) => {
        seen.add(r.address)
        const isRecent = recent.some((h) => h.address === r.address)
        const source: HostSource = isRecent ? 'recent' : neighbors.includes(r.address) ? 'scan' : 'broadcast'
        this.upsertHost({ address: r.address, name: r.hostName, slotsUsed: r.slotsUsed, maxSlots: r.maxSlots, source, online: true })
      })
      for (const h of this.hosts.values()) {
        if (!seen.has(h.address) && h.online) this.hosts.set(h.address, { ...h, online: false })
      }
      this.emit('hosts', this.getHosts())
    } finally {
      this.discovering = false
    }
  }

  // ---------- Подключение ----------

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  async connect(rawAddress: string): Promise<void> {
    const address = rawAddress.trim()
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return this.fail('host_unreachable', 'bad address')
    if (!this.d.moonlight.available) return this.fail('moonlight_missing')
    this.teardown()
    const attempt = ++this.attempt
    this.connectedAt = Date.now()
    this.set({ phase: 'connecting', host: { address, name: this.hosts.get(address)?.name ?? address }, error: undefined, errorDetail: undefined, perms: undefined, startedAt: undefined })

    const ws = new WebSocket(`ws://${address}:${this.d.signalingPort ?? SIGNALING_PORT}`, { handshakeTimeout: this.d.connectTimeoutMs ?? 10_000 })
    this.ws = ws
    ws.on('open', () => {
      const s = this.d.settings.get()
      this.send({
        t: 'hello',
        v: PROTOCOL_VERSION,
        deviceId: s.deviceId,
        nickname: s.nickname,
        appVersion: this.d.appVersion,
        trustToken: this.d.secrets.get().hostTokens[address]
      })
    })
    ws.on('message', (data) => {
      if (attempt !== this.attempt) return
      const msg = parseHostMessage(data)
      if (msg) void this.onMessage(attempt, address, msg).catch((e) => this.log(`message ${msg.t}`, e))
    })
    ws.on('error', (e: NodeJS.ErrnoException) => {
      if (attempt !== this.attempt || this.state.phase !== 'connecting') return
      // ECONNREFUSED: ПК отвечает, но Streamly на нём не в режиме хоста. Таймаут — нет связи через Radmin.
      if (e.code === 'ECONNREFUSED') return this.fail('host_not_hosting', `${address}: ${e.code}`)
      this.fail('host_unreachable', `${address}: ${e.code ?? e.message}`)
    })
    ws.on('close', () => {
      if (attempt !== this.attempt) return
      this.ws = null
      if (ACTIVE.includes(this.state.phase)) {
        this.fail(this.state.phase === 'connecting' ? 'host_unreachable' : 'connection_lost')
      }
    })
  }

  private async onMessage(attempt: number, address: string, msg: HostMessage): Promise<void> {
    switch (msg.t) {
      case 'hostInfo':
        this.set({ host: { address, name: msg.hostName } })
        this.send({ t: 'joinRequest' })
        this.set({ phase: 'waitingApproval' })
        return
      case 'joinDenied':
        return this.fail(msg.reason === 'full' ? 'host_full' : msg.reason === 'version' ? 'version_mismatch' : 'denied')
      case 'joinAccepted': {
        if (msg.trustToken) {
          const token = msg.trustToken
          this.d.secrets.update((s) => {
            s.hostTokens[address] = token
          })
        }
        this.d.settings.rememberHost(address, this.state.host?.name ?? address)
        this.set({ phase: 'pairing', perms: msg.perms })
        // Хост — источник истины: если он не знает нас в Apollo, сопрягаемся заново.
        const paired = !msg.needsPair && (await this.isPaired(address))
        if (attempt !== this.attempt) return
        if (paired) return this.launch(attempt, address)
        this.send({ t: 'pairRequest' })
        return
      }
      case 'pairBegin':
        this.pairProc?.kill()
        this.pairProc = this.d.moonlight.pair(address, msg.pin)
        this.send({ t: 'pairSpawned' })
        return
      case 'pairResult': {
        if (!msg.ok) {
          this.pairProc?.kill()
          this.pairProc = null
          if (msg.reason === 'no_request') return this.fail('pair_no_request', this.d.moonlightLog?.(this.connectedAt))
          return this.fail('pair_failed', msg.reason)
        }
        // Окно сопряжения Moonlight показывает «готово» и ждёт клика. Даём ему сохранить
        // сертификат хоста на диск, затем закрываем и убеждаемся, что сопряжение записалось.
        await new Promise((r) => setTimeout(r, this.d.pairSettleMs ?? 1500))
        if (attempt !== this.attempt) return
        this.pairProc?.kill()
        this.pairProc = null
        for (let i = 0; i < 3; i++) {
          if (await this.isPaired(address)) return attempt === this.attempt ? this.launch(attempt, address) : undefined
          if (attempt !== this.attempt) return
          await new Promise((r) => setTimeout(r, 1000))
        }
        return this.fail('pair_failed', 'moonlight did not save pairing')
      }
      case 'permissionsChanged':
        this.set({ perms: msg.perms })
        this.emit('permissions', msg.perms)
        return
      case 'launchGo':
        return this.startStream(attempt)
      case 'sessionState':
        return this.onSessionState(attempt, msg.streaming)
      case 'kicked':
        return this.fail('kicked')
      case 'hostStopping':
        return this.fail('host_stopped')
      case 'pong':
        return
    }
  }

  /** `Moonlight list`: код 0 — сопряжён и хост доступен. Процесс отслеживается, чтобы отмена его закрывала. */
  private async isPaired(address: string, timeoutMs = 20_000): Promise<boolean> {
    this.listProc?.kill()
    const proc = this.d.moonlight.list(address)
    this.listProc = proc
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    const code = await proc.exited
    clearTimeout(timer)
    if (this.listProc === proc) this.listProc = null
    return code === 0
  }

  /** Готовы к стриму: встаём в очередь запусков на хосте и ждём launchGo. */
  private launch(attempt: number, _address: string): void {
    this.set({ phase: 'launching' })
    this.launchAddress = _address
    this.send({ t: 'launchRequest' })
    this.clearTimer('start')
    const requestedAt = Date.now()
    this.timers.start = setTimeout(() => {
      if (attempt !== this.attempt || this.state.phase !== 'launching') return
      // Moonlight запущен, а хост так и не увидел подключение: скорее всего, окно ошибки Moonlight.
      this.fail('stream_timeout', this.d.moonlightLog?.(requestedAt))
    }, this.d.streamStartTimeoutMs ?? 45_000)
  }

  /**
   * Запуск Moonlight по сигналу хоста. «Идёт трансляция» показываем, только когда хост подтвердил
   * подключение в Apollo (sessionState): Moonlight при ошибке не завершается, а висит с окном ошибки.
   */
  private startStream(attempt: number): void {
    if (attempt !== this.attempt || this.state.phase !== 'launching' || !this.launchAddress) return
    const address = this.launchAddress
    if (this.streamProc) {
      this.streamProc.kill()
      this.streamProc = null
    }
    const settings = this.d.settings.get()
    const startedAt = Date.now()
    const proc = this.d.moonlight.stream(address, settings.stream, this.d.nativeResolution?.())
    this.streamProc = proc
    this.streamStartedAt = startedAt
    this.send({ t: 'sessionStarted' })
    void proc.exited.then((code) => {
      this.clearTimer('start')
      this.clearTimer('lost')
      if (attempt !== this.attempt || this.streamProc !== proc) return
      this.streamProc = null
      this.send({ t: 'sessionEnded' })
      if (this.state.phase === 'launching') {
        // Закрылся, так и не начав стрим: ошибка запуска (подробности — в логе Moonlight).
        return this.fail('stream_failed', [`exit ${code}`, this.d.moonlightLog?.(startedAt)].filter(Boolean).join('\n'))
      }
      this.teardown()
      this.set({ phase: 'ended' })
    })
  }

  private onSessionState(attempt: number, streaming: boolean): void {
    if (attempt !== this.attempt || !this.streamProc) return
    if (streaming) {
      this.clearTimer('start')
      this.clearTimer('lost')
      if (this.state.phase !== 'streaming') this.set({ phase: 'streaming', startedAt: this.state.startedAt ?? Date.now() })
      return
    }
    // Хост больше не видит стрим, а Moonlight ещё открыт (например, с окном «соединение потеряно»).
    this.clearTimer('lost')
    this.timers.lost = setTimeout(() => {
      if (attempt === this.attempt && this.state.phase === 'streaming') this.fail('connection_lost', this.d.moonlightLog?.(this.streamStartedAt))
    }, this.d.streamLostGraceMs ?? 8000)
  }

  private clearTimer(name: 'start' | 'lost'): void {
    const t = this.timers[name]
    if (t) clearTimeout(t)
    this.timers[name] = undefined
  }

  /** Отмена подключения или отключение от стрима. */
  async cancel(): Promise<void> {
    this.teardown()
    this.set({ phase: 'idle', error: undefined, errorDetail: undefined })
  }

  async reset(): Promise<void> {
    if (!ACTIVE.includes(this.state.phase)) this.set({ phase: 'idle', error: undefined, errorDetail: undefined })
  }

  private teardown(): void {
    this.attempt++
    this.clearTimer('start')
    this.clearTimer('lost')
    this.pairProc?.kill()
    this.pairProc = null
    this.listProc?.kill()
    this.listProc = null
    if (this.streamProc) {
      this.streamProc.kill()
      this.streamProc = null
      this.send({ t: 'sessionEnded' })
    }
    if (this.ws) {
      this.ws.removeAllListeners('close')
      this.ws.close()
      this.ws = null
    }
  }

  get perms(): InputPerms | undefined {
    return this.state.perms
  }
}
