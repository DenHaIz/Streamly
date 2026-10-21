import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { NO_INPUT, type InputPerms } from '@shared/perms'
import { parseHostMessage, PROTOCOL_VERSION, SIGNALING_PORT, type ClientMessage, type HostMessage } from '@shared/protocol'
import type { ClientState, DiscoveredHost, ErrorCode, HostSource, StreamPolicy, StreamSettings } from '@shared/types'
import type { SecretsService, SettingsService } from '../../settings'
import type { MoonlightProcess } from '../moonlight/runner'
import type { ProbeResult } from '../net/discovery'

export interface MoonlightLike {
  readonly available: boolean
  pair(host: string, pin: string): MoonlightProcess
  list(host: string): MoonlightProcess
  stream(host: string, settings: StreamSettings, native?: { width: number; height: number }, policy?: StreamPolicy): MoonlightProcess
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
  /** Сколько ждать, пока хост увидит стрим после запуска Moonlight. */
  streamStartTimeoutMs?: number
  /** Сколько можно ждать своей очереди на запуск стрима. */
  queueTimeoutMs?: number
  /** Сколько ждать восстановления, если хост перестал видеть стрим. */
  streamLostGraceMs?: number
  /** Сколько может длиться сопряжение целиком. */
  pairTimeoutMs?: number
  /** Без ответов хоста дольше этого соединение считается потерянным. */
  hostSilenceMs?: number
  /** Хвост лога Moonlight с момента since (для подробностей ошибки). */
  moonlightLog?: (since: number) => string | undefined
  /** Пауза перед закрытием окна сопряжения, чтобы Moonlight успел сохранить сертификат хоста. */
  pairSettleMs?: number
  /** Сколько связь должна быть нормальной, прежде чем снять пометку «плохая связь». */
  poorNetworkClearMs?: number
  log?: (msg: string, err?: unknown) => void
}

const ACTIVE: ClientState['phase'][] = ['connecting', 'waitingApproval', 'pairing', 'launching', 'streaming']

type TimerName = 'start' | 'lost' | 'pair' | 'queue'

/** Moonlight пишет в лог «Connection status update: N»: 1 — плохая связь, 0 — нормальная. */
export function parseConnectionStatus(line: string): boolean | undefined {
  const m = /Connection status update: (\d+)/.exec(line)
  if (!m) return undefined
  return m[1] !== '0'
}

/** Разброс задержки: среднее отклонение соседних замеров. */
export function jitter(samples: number[]): number | undefined {
  if (samples.length < 3) return undefined
  let sum = 0
  for (let i = 1; i < samples.length; i++) sum += Math.abs(samples[i] - samples[i - 1])
  return Math.round(sum / (samples.length - 1))
}

/**
 * Сопряжён ли Moonlight с хостом — по выводу `Moonlight list`. Код выхода сам по себе ненадёжен:
 * Moonlight может завершиться с 0 и после окна ошибки. Список приложений Apollo (в том числе
 * заглушка «Permission Denied», если у клиента пока нет прав) означает, что сопряжение есть.
 */
export function parseListOutput(code: number, lines: string[]): boolean {
  if (code !== 0) return false
  const text = lines.join('\n')
  if (/not (been )?paired|failed|error|unable|could not|timed out/i.test(text)) return false
  return true
}

export class ClientController extends EventEmitter {
  private state: ClientState = { phase: 'idle' }
  private ws: WebSocket | null = null
  private pairProc: MoonlightProcess | null = null
  private streamProc: MoonlightProcess | null = null
  private listProc: MoonlightProcess | null = null
  private timers: Partial<Record<TimerName, NodeJS.Timeout>> = {}
  private pingTimer: NodeJS.Timeout | null = null
  private lastPong = 0
  private connectedAt = 0
  private streamStartedAt = 0
  private launchAddress: string | null = null
  /** Адрес хоста, который нас уже допустил (соединение открыто): повторный запуск без нового одобрения. */
  private admittedAt: string | null = null
  /** Мы сами попросили сопряжение: pairBegin без запроса игнорируем. */
  private awaitingPair = false
  private hosts = new Map<string, DiscoveredHost>()
  private discovering = false
  /** Номер попытки: колбэки старых попыток игнорируются. */
  private attempt = 0
  /** Что игрок выключил себе сам (держится до отключения от хоста). */
  private selfOff: InputPerms = { ...NO_INPUT }
  private rttSamples: number[] = []
  /** Поток закрыт ради перезапуска с новыми настройками: после выхода Moonlight сразу встаём в очередь. */
  private restartPending = false
  private poorTimer: NodeJS.Timeout | null = null

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
    } catch (e) {
      this.log('discover failed', e)
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
    // После окончания стрима соединение с хостом держится: снова запускаем стрим без повторного одобрения.
    if (this.state.phase === 'ended' && this.admittedAt === address && this.ws?.readyState === WebSocket.OPEN) {
      this.set({ error: undefined, errorDetail: undefined, startedAt: undefined })
      return this.launch(this.attempt, address)
    }
    this.teardown()
    const attempt = ++this.attempt
    this.connectedAt = Date.now()
    this.set({
      phase: 'connecting',
      host: { address, name: this.hosts.get(address)?.name ?? address },
      error: undefined,
      errorDetail: undefined,
      perms: undefined,
      startedAt: undefined,
      rttMs: undefined,
      jitterMs: undefined,
      policy: undefined,
      selfOff: { ...NO_INPUT },
      hostChat: undefined,
      poorNetwork: false,
      restarting: false
    })
    this.selfOff = { ...NO_INPUT }
    this.rttSamples = []

    const ws = new WebSocket(`ws://${address}:${this.d.signalingPort ?? SIGNALING_PORT}`, { handshakeTimeout: this.d.connectTimeoutMs ?? 10_000 })
    this.ws = ws
    ws.on('open', () => {
      // Замер задержки и сторож: хост, переставший отвечать, обнаруживаем за ~15 с, а не по таймауту TCP.
      this.lastPong = Date.now()
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => {
        if (attempt !== this.attempt) return
        if (Date.now() - this.lastPong > (this.d.hostSilenceMs ?? 15_000)) {
          if (ACTIVE.includes(this.state.phase)) return this.fail('connection_lost', 'host stopped responding')
          return this.teardown()
        }
        this.send({ t: 'ping', ts: Date.now() })
      }, 3000)
      this.send({ t: 'ping', ts: Date.now() })
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
      this.lastPong = Date.now()
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
      this.admittedAt = null
      if (ACTIVE.includes(this.state.phase)) {
        this.fail(this.state.phase === 'connecting' ? 'host_unreachable' : 'connection_lost')
      }
    })
  }

  private async onMessage(attempt: number, address: string, msg: HostMessage): Promise<void> {
    switch (msg.t) {
      case 'hostInfo':
        if (this.state.phase !== 'connecting') return
        this.set({ host: { address, name: msg.hostName } })
        this.send({ t: 'joinRequest' })
        this.set({ phase: 'waitingApproval' })
        return
      case 'joinDenied':
        return this.fail(
          msg.reason === 'full' ? 'host_full' : msg.reason === 'version' ? 'version_mismatch' : msg.reason === 'busy' ? 'host_busy' : 'denied'
        )
      case 'joinAccepted': {
        if (this.state.phase !== 'waitingApproval') return
        if (msg.trustToken) {
          const token = msg.trustToken
          this.d.secrets.update((s) => {
            s.hostTokens[address] = token
          })
        }
        this.admittedAt = address
        this.d.settings.rememberHost(address, this.state.host?.name ?? address)
        this.set({ phase: 'pairing', perms: msg.perms, policy: msg.policy })
        this.sendPrefs()
        // Сопряжение целиком не может длиться бесконечно, что бы ни случилось по дороге.
        this.startTimer('pair', this.d.pairTimeoutMs ?? 90_000, attempt, () => this.fail('pair_failed', 'timeout'))
        // Хост — источник истины: если он не знает нас в Apollo, сопрягаемся заново.
        const paired = !msg.needsPair && (await this.isPaired(address))
        if (attempt !== this.attempt) return
        if (paired) return this.launch(attempt, address)
        this.awaitingPair = true
        this.send({ t: 'pairRequest' })
        return
      }
      case 'pairBegin':
        if (!this.awaitingPair || this.state.phase !== 'pairing') return
        this.awaitingPair = false
        this.pairProc?.kill()
        this.pairProc = this.d.moonlight.pair(address, msg.pin)
        this.send({ t: 'pairSpawned' })
        return
      case 'pairResult': {
        if (this.state.phase !== 'pairing') return
        if (!msg.ok) {
          this.pairProc?.kill()
          this.pairProc = null
          if (msg.reason === 'no_request') return this.fail('pair_no_request', this.d.moonlightLog?.(this.connectedAt))
          return this.fail('pair_failed', [msg.reason, this.d.moonlightLog?.(this.connectedAt)].filter(Boolean).join('\n'))
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
        if (typeof msg.ts === 'number') {
          const rtt = Math.max(0, Date.now() - msg.ts)
          this.rttSamples = [...this.rttSamples, rtt].slice(-10)
          const j = jitter(this.rttSamples)
          if (rtt !== this.state.rttMs || j !== this.state.jitterMs) this.set({ rttMs: rtt, jitterMs: j })
        }
        return
      case 'audioState':
        this.set({ hostChat: { control: msg.chatControl, excluded: msg.chatExcluded } })
        return
    }
  }

  /** Сопряжён ли Moonlight с хостом (по выводу `list`). Процесс отслеживается, чтобы отмена его закрывала. */
  private async isPaired(address: string, timeoutMs = 10_000): Promise<boolean> {
    this.listProc?.kill()
    const proc = this.d.moonlight.list(address)
    this.listProc = proc
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    const code = await proc.exited
    clearTimeout(timer)
    if (this.listProc === proc) this.listProc = null
    return parseListOutput(code, proc.output?.() ?? [])
  }

  private startTimer(name: TimerName, ms: number, attempt: number, fn: () => void): void {
    this.clearTimer(name)
    this.timers[name] = setTimeout(() => {
      this.timers[name] = undefined
      if (attempt === this.attempt) fn()
    }, ms)
  }

  /** Готовы к стриму: встаём в очередь запусков на хосте и ждём launchGo. */
  private launch(attempt: number, address: string): void {
    this.clearTimer('pair')
    this.set({ phase: 'launching' })
    this.launchAddress = address
    this.send({ t: 'launchRequest' })
    // Ожидание своей очереди считается отдельно от запуска Moonlight.
    this.startTimer('queue', this.d.queueTimeoutMs ?? 120_000, attempt, () => {
      if (this.state.phase === 'launching' && !this.streamProc) this.fail('stream_timeout', 'launch queue timeout')
    })
  }

  /**
   * Запуск Moonlight по сигналу хоста. «Идёт трансляция» показываем, только когда хост подтвердил
   * подключение в Apollo (sessionState): Moonlight при ошибке не завершается, а висит с окном ошибки.
   */
  private startStream(attempt: number): void {
    if (attempt !== this.attempt || this.state.phase !== 'launching' || !this.launchAddress) return
    this.clearTimer('queue')
    const address = this.launchAddress
    if (this.streamProc) {
      this.streamProc.kill()
      this.streamProc = null
    }
    const settings = this.d.settings.get()
    const startedAt = Date.now()
    const proc = this.d.moonlight.stream(address, settings.stream, this.d.nativeResolution?.(), this.state.policy)
    this.streamProc = proc
    this.streamStartedAt = startedAt
    proc.onLine?.((line) => {
      const poor = parseConnectionStatus(line)
      if (poor !== undefined && attempt === this.attempt && this.streamProc === proc) this.onConnectionStatus(poor)
    })
    this.emit('streamProcess', proc.child?.pid)
    this.send({ t: 'sessionStarted' })
    this.startTimer('start', this.d.streamStartTimeoutMs ?? 45_000, attempt, () => {
      // Moonlight запущен, а хост так и не увидел подключение: скорее всего, окно ошибки Moonlight.
      if (this.state.phase === 'launching') this.fail('stream_timeout', this.d.moonlightLog?.(startedAt))
    })
    void proc.exited.then((code) => {
      // Таймеры трогаем только для текущего процесса: поздний выход старого Moonlight не должен их сбрасывать.
      if (attempt !== this.attempt || this.streamProc !== proc) return
      this.clearTimer('start')
      this.clearTimer('lost')
      this.streamProc = null
      this.send({ t: 'sessionEnded' })
      this.onConnectionStatus(false, true)
      if (this.restartPending && this.launchAddress && this.ws?.readyState === WebSocket.OPEN) {
        // Перезапуск с новыми настройками: снова в очередь запусков, без нового одобрения.
        this.restartPending = false
        return this.launch(attempt, this.launchAddress)
      }
      this.restartPending = false
      if (this.state.phase === 'launching') {
        // Закрылся, так и не начав стрим: ошибка запуска (подробности — в логе Moonlight).
        return this.fail('stream_failed', [`exit ${code}`, this.d.moonlightLog?.(startedAt)].filter(Boolean).join('\n'))
      }
      // Стрим закончен, а соединение с хостом оставляем: «Подключиться снова» не потребует нового одобрения.
      this.set({ phase: 'ended' })
    })
  }

  private onSessionState(attempt: number, streaming: boolean): void {
    if (attempt !== this.attempt || !this.streamProc) return
    if (streaming) {
      this.clearTimer('start')
      this.clearTimer('lost')
      if (this.state.phase !== 'streaming' || this.state.restarting) {
        this.set({ phase: 'streaming', startedAt: this.state.startedAt ?? Date.now(), restarting: false })
      }
      return
    }
    // Хост больше не видит стрим, а Moonlight ещё открыт (например, с окном «соединение потеряно»).
    this.startTimer('lost', this.d.streamLostGraceMs ?? 8000, attempt, () => {
      if (this.state.phase === 'streaming') this.fail('connection_lost', this.d.moonlightLog?.(this.streamStartedAt))
    })
  }

  private clearTimer(name: TimerName): void {
    const t = this.timers[name]
    if (t) clearTimeout(t)
    this.timers[name] = undefined
  }

  /** Moonlight сообщил о качестве связи. Плохую показываем сразу, нормальную — после паузы, чтобы не мигать. */
  private onConnectionStatus(poor: boolean, immediate = false): void {
    if (this.poorTimer) clearTimeout(this.poorTimer)
    this.poorTimer = null
    const apply = (v: boolean): void => {
      if (this.state.poorNetwork === v) return
      this.set({ poorNetwork: v })
      this.send({ t: 'netStatus', poor: v })
    }
    if (poor || immediate) return apply(poor)
    this.poorTimer = setTimeout(() => apply(false), this.d.poorNetworkClearMs ?? 6000)
  }

  private sendPrefs(): void {
    this.send({ t: 'prefs', muteChat: this.d.settings.get().stream.muteHostChat, selfOff: this.selfOff })
  }

  /** Игрок выключает (или включает) себе клавиатуру, мышь или геймпад. Хост применяет это сразу. */
  setSelfOff(patch: Partial<InputPerms>): void {
    const pick = (k: keyof InputPerms): boolean => (typeof patch[k] === 'boolean' ? (patch[k] as boolean) : this.selfOff[k])
    this.selfOff = { keyboard: pick('keyboard'), mouse: pick('mouse'), gamepad: pick('gamepad') }
    this.set({ selfOff: this.selfOff })
    this.sendPrefs()
  }

  /** Настройки игрока поменялись (например, «не слышать Discord хоста»): сообщаем хосту. */
  prefsChanged(): void {
    if (this.admittedAt) this.sendPrefs()
  }

  /** PID окна трансляции Moonlight (для громкости и меню Alt+F2). */
  get streamPid(): number | undefined {
    return this.streamProc?.child?.pid
  }

  /** Перезапуск трансляции с текущими настройками (быстрые настройки качества). Одобрение хоста не нужно. */
  restartStream(): boolean {
    if (this.state.phase !== 'streaming' || !this.streamProc || !this.launchAddress) return false
    this.restartPending = true
    this.set({ restarting: true })
    const proc = this.streamProc
    if (proc.close) proc.close()
    else proc.kill()
    return true
  }

  /** Отмена подключения или отключение от стрима. */
  async cancel(): Promise<void> {
    this.teardown()
    this.set({ phase: 'idle', error: undefined, errorDetail: undefined })
  }

  /** К списку хостов: закрываем и соединение, которое держалось после стрима. */
  async reset(): Promise<void> {
    if (ACTIVE.includes(this.state.phase)) return
    this.teardown()
    this.set({ phase: 'idle', error: undefined, errorDetail: undefined })
  }

  private teardown(): void {
    this.attempt++
    this.awaitingPair = false
    this.admittedAt = null
    this.restartPending = false
    if (this.poorTimer) clearTimeout(this.poorTimer)
    this.poorTimer = null
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    for (const name of Object.keys(this.timers) as TimerName[]) this.clearTimer(name)
    this.pairProc?.kill()
    this.pairProc = null
    this.listProc?.kill()
    this.listProc = null
    if (this.streamProc) {
      // Мягкое закрытие: Moonlight сообщает Apollo об отключении, и место у хоста освобождается сразу.
      if (this.streamProc.close) this.streamProc.close()
      else this.streamProc.kill()
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
