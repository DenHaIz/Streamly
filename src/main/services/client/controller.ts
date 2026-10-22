import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { NO_INPUT, type InputPerms } from '@shared/perms'
import { parseHostMessage, PROTOCOL_VERSION, SIGNALING_PORT, type ClientMessage, type HostMessage } from '@shared/protocol'
import type { ClientState, DiscoveredHost, ErrorCode, HostSource, QualityProfile, StreamPolicy, StreamSettings } from '@shared/types'
import type { SecretsService, SettingsService } from '../../settings'
import { streamParams, type MoonlightProcess } from '../moonlight/runner'
import { autoProfile, lowerProfile, relaySuspect } from './quality'
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
  nativeResolution?: () => { width: number; height: number; fps?: number } | undefined
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
  /** Автоподбор: сколько связь должна оставаться плохой, прежде чем снизить качество. */
  autoLowerAfterMs?: number
  /** Автоподбор: сколько связь должна быть хорошей после снижения, чтобы вернуть замеренное качество. */
  autoRaiseAfterMs?: number
  /** Сколько держать соединение с хостом после окончания стрима (место у хоста занято). */
  endedIdleMs?: number
  /** Сколько ждать результата замера скорости (старый хост замер не поддерживает). */
  speedTestTimeoutMs?: number
  /** Подключён ли этот ПК к сети по Wi-Fi (для подсказок). */
  wifi?: () => Promise<boolean>
  /** Окно Moonlight не отвечает (зависло). */
  isHung?: (pid: number) => Promise<boolean>
  /** Как часто проверять, не завис ли Moonlight. */
  hungCheckMs?: number
  /** Сколько пытаться вернуться к хосту после обрыва сигнального соединения. */
  resumeWindowMs?: number
  log?: (msg: string, err?: unknown) => void
}

const ACTIVE: ClientState['phase'][] = ['connecting', 'waitingApproval', 'pairing', 'launching', 'streaming']

type TimerName = 'start' | 'lost' | 'pair' | 'queue' | 'hello' | 'idle' | 'resume'

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
  /** Код из ссылки-приглашения (для hello). */
  private inviteCode: string | undefined
  /** Качество, подобранное автоматически для текущего подключения. */
  private auto: QualityProfile | null = null
  /** Замер уже был в этом подключении (удачный или нет): при перезапусках не повторяем. */
  private measured = false
  private autoLowerTimer: NodeJS.Timeout | null = null
  private lastAutoLower = 0
  /** Автопереподключения после обрыва за последние минуты. */
  private reconnects: number[] = []
  private speed: { bytes: number; first: number; last: number; firstBytes: number; sentAt: number; done?: (mbps?: number) => void } | null = null
  /** Качество по замеру канала (до автоматических снижений). */
  private measuredAuto: QualityProfile | null = null
  private autoRaiseTimer: NodeJS.Timeout | null = null
  /** Предыдущий Moonlight ещё закрывается: новый запускаем только после его выхода. */
  private closing: Promise<unknown> | null = null
  /** Токен возвращения к хосту после короткого обрыва (выдаётся при допуске). */
  private resume: { address: string; token: string } | null = null
  private resuming = false
  private resumeStarted = 0
  private resumeTimer: NodeJS.Timeout | null = null
  private hungTimer: NodeJS.Timeout | null = null
  private identifyTimer: NodeJS.Timeout | null = null
  private inputRequestTimer: NodeJS.Timeout | null = null

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

  async connect(rawAddress: string, opts: { inviteCode?: string } = {}): Promise<void> {
    const address = rawAddress.trim()
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return this.fail('host_unreachable', 'bad address')
    if (!this.d.moonlight.available) return this.fail('moonlight_missing')
    if (ACTIVE.includes(this.state.phase) && this.state.host?.address === address) return
    // После окончания стрима соединение с хостом держится: снова запускаем стрим без повторного одобрения.
    if (this.state.phase === 'ended' && this.admittedAt === address && this.ws?.readyState === WebSocket.OPEN) {
      this.clearTimer('idle')
      this.set({ error: undefined, errorDetail: undefined, startedAt: undefined })
      return this.launch(this.attempt, address)
    }
    this.teardown()
    const attempt = ++this.attempt
    this.connectedAt = Date.now()
    this.inviteCode = opts.inviteCode
    this.auto = null
    this.measuredAuto = null
    this.measured = false
    this.reconnects = []
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
      restarting: false,
      reconnecting: false,
      measuring: false,
      speedMbps: undefined,
      active: undefined,
      pads: undefined,
      padIdentify: undefined,
      signalLost: false,
      capLowered: undefined,
      autoLowered: false,
      relaySuspect: false,
      inputRequest: undefined,
      inputPaused: false
    })
    this.selfOff = { ...NO_INPUT }
    this.rttSamples = []

    this.openSocket(address, attempt)
  }

  /** Сигнальное соединение с хостом (новое подключение или возвращение после обрыва). */
  private openSocket(address: string, attempt: number): void {
    const resuming = this.resuming
    const ws = new WebSocket(`ws://${address}:${this.d.signalingPort ?? SIGNALING_PORT}`, {
      handshakeTimeout: resuming ? 4000 : (this.d.connectTimeoutMs ?? 10_000)
    })
    this.ws = ws
    ws.on('open', () => {
      // Порт открыт, но хост молчит (не Streamly или завис): не ждём бесконечно.
      this.startTimer('hello', this.d.connectTimeoutMs ?? 10_000, attempt, () => {
        if (this.resuming) return ws.terminate()
        if (this.state.phase === 'connecting') this.fail('host_not_hosting', 'no answer to hello')
      })
      // Замер задержки и сторож: хост, переставший отвечать, обнаруживаем за ~15 с, а не по таймауту TCP.
      this.lastPong = Date.now()
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => {
        if (attempt !== this.attempt || this.ws !== ws) return
        if (Date.now() - this.lastPong > (this.d.hostSilenceMs ?? 15_000)) {
          // Во время игры сначала пробуем переподключиться (трансляция Moonlight идёт отдельно).
          if (this.canResume(address)) return ws.terminate()
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
        trustToken: this.d.secrets.get().hostTokens[address],
        inviteCode: this.inviteCode,
        resumeToken: this.resume?.address === address ? this.resume.token : undefined
      })
    })
    ws.on('message', (data, isBinary) => {
      if (attempt !== this.attempt || this.ws !== ws) return
      this.lastPong = Date.now()
      if (isBinary) return this.onSpeedChunk(data as Buffer)
      const msg = parseHostMessage(data)
      if (msg) void this.onMessage(attempt, address, msg).catch((e) => this.log(`message ${msg.t}`, e))
    })
    ws.on('error', (e: NodeJS.ErrnoException) => {
      if (attempt !== this.attempt || this.state.phase !== 'connecting' || this.resuming) return
      // ECONNREFUSED: ПК отвечает, но Streamly на нём не в режиме хоста. Таймаут — нет связи через Radmin.
      if (e.code === 'ECONNREFUSED') return this.fail('host_not_hosting', `${address}: ${e.code}`)
      this.fail('host_unreachable', `${address}: ${e.code ?? e.message}`)
    })
    ws.on('close', () => {
      if (attempt !== this.attempt || this.ws !== ws) return
      this.ws = null
      this.admittedAt = null
      this.clearTimer('hello')
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = null
      // Повторная попытка возвращения (хост ещё не ответил или соединение снова сорвалось).
      if (this.resuming) {
        this.resumeTimer = setTimeout(() => this.resumeTry(address, attempt), 2000)
        return
      }
      // Обрыв во время игры: Moonlight продолжает показывать игру, а мы возвращаемся к хосту по токену.
      if (this.canResume(address)) return this.beginResume(address, attempt)
      if (ACTIVE.includes(this.state.phase)) {
        this.fail(this.state.phase === 'connecting' ? 'host_unreachable' : 'connection_lost')
      }
    })
  }

  /** Можно ли вернуться к хосту без подтверждения: Moonlight запущен (идёт игра или её запуск), хост выдал токен. */
  private canResume(address: string): boolean {
    return (this.state.phase === 'streaming' || this.state.phase === 'launching') && !!this.streamProc && this.resume?.address === address
  }

  private beginResume(address: string, attempt: number): void {
    this.resuming = true
    this.resumeStarted = Date.now()
    this.log('signaling lost: reconnecting while the stream keeps going')
    this.set({ signalLost: true })
    // Общий срок: хост мог не узнать нас (перезапускался) и ждать подтверждения — дольше не ждём.
    this.startTimer('resume', this.d.resumeWindowMs ?? 20_000, attempt, () => {
      if (!this.resuming) return
      this.resuming = false
      this.fail('connection_lost', 'signaling lost and the host did not come back')
    })
    this.resumeTry(address, attempt)
  }

  private resumeTry(address: string, attempt: number): void {
    this.resumeTimer = null
    if (attempt !== this.attempt || !this.resuming) return
    if ((!this.streamProc && !this.restartPending) || Date.now() - this.resumeStarted > (this.d.resumeWindowMs ?? 20_000)) {
      this.resuming = false
      return this.fail('connection_lost', 'signaling lost and the host did not come back')
    }
    this.openSocket(address, attempt)
  }

  private async onMessage(attempt: number, address: string, msg: HostMessage): Promise<void> {
    switch (msg.t) {
      case 'hostInfo':
        if (this.state.phase !== 'connecting' && !this.resuming) return
        this.clearTimer('hello')
        this.set({ host: { address, name: msg.hostName } })
        this.send({ t: 'joinRequest' })
        if (!this.resuming) this.set({ phase: 'waitingApproval' })
        return
      case 'joinDenied':
        return this.fail(
          msg.reason === 'full' ? 'host_full' : msg.reason === 'version' ? 'version_mismatch' : msg.reason === 'busy' ? 'host_busy' : 'denied'
        )
      case 'joinAccepted': {
        if (this.state.phase !== 'waitingApproval' && !this.resuming) return
        if (msg.resumeToken) this.resume = { address, token: msg.resumeToken }
        if (this.resuming) {
          // Вернулись к хосту: трансляция всё это время шла, ничего не перезапускаем.
          this.resuming = false
          this.clearTimer('resume')
          if (this.resumeTimer) clearTimeout(this.resumeTimer)
          this.resumeTimer = null
          this.admittedAt = address
          this.log('back with the host after a short drop')
          this.set({ signalLost: false, perms: msg.perms, policy: msg.policy })
          this.sendPrefs()
          // Трансляция шла всё это время: только проверяем, не снизил ли хост потолок, пока нас не было.
          if (this.streamProc) return this.checkCap()
          // Moonlight закрылся ради перезапуска во время обрыва — запускаем сейчас.
          if (this.restartPending && this.launchAddress) {
            this.restartPending = false
            return this.launch(attempt, this.launchAddress)
          }
          return
        }
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
        const pp = this.pairProc
        this.pairProc = null
        if (pp) {
          if (pp.close) pp.close()
          else pp.kill()
          await Promise.race([pp.exited, new Promise((r) => setTimeout(r, 3000))])
          if (attempt !== this.attempt) return
        }
        for (let i = 0; i < 3; i++) {
          if (await this.isPaired(address)) return attempt === this.attempt ? this.launch(attempt, address) : undefined
          if (attempt !== this.attempt) return
          if (i < 2) await new Promise((r) => setTimeout(r, 1000))
          if (attempt !== this.attempt) return
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
          const relay = relaySuspect(this.rttSamples, this.state.speedMbps)
          if (rtt !== this.state.rttMs || j !== this.state.jitterMs || relay !== this.state.relaySuspect) {
            this.set({ rttMs: rtt, jitterMs: j, relaySuspect: relay })
          }
        }
        return
      case 'audioState':
        this.set({ hostChat: { control: msg.chatControl, excluded: msg.chatExcluded } })
        return
      case 'inputRequestResult':
        if (this.inputRequestTimer) clearTimeout(this.inputRequestTimer)
        this.inputRequestTimer = null
        if (msg.granted) return this.set({ inputRequest: undefined })
        this.set({ inputRequest: 'denied' })
        this.inputRequestTimer = setTimeout(() => this.set({ inputRequest: undefined }), 10_000)
        return
      case 'inputPaused':
        this.set({ inputPaused: msg.paused })
        return
      case 'speedEnd':
        return this.onSpeedEnd(msg.bytes)
      case 'resetGamepad':
        this.log('host asked to reconnect gamepads')
        this.resetGamepad()
        return
      case 'policyUpdate':
        // Хост пересчитал потолок битрейта (пришли или ушли игроки).
        this.set({ policy: msg.policy })
        return this.checkCap()
      case 'pads':
        this.set({ pads: msg.list })
        return
      case 'padIdentified':
        if (this.identifyTimer) clearTimeout(this.identifyTimer)
        this.identifyTimer = null
        this.set({ padIdentify: msg.slot ? 'done' : 'notFound' })
        // Результат виден несколько секунд, потом снова обычная подсказка.
        this.identifyTimer = setTimeout(() => this.set({ padIdentify: undefined }), 8000)
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

  /**
   * Готовы к стриму: встаём в очередь запусков на хосте и ждём launchGo.
   * С автоподбором качества сначала замеряем канал (один раз за подключение).
   */
  private launch(attempt: number, address: string): void {
    this.clearTimer('pair')
    this.set({ phase: 'launching' })
    this.launchAddress = address
    if (this.d.settings.get().stream.autoQuality && !this.measured) {
      this.measured = true
      void this.measure(attempt).then(() => {
        if (attempt === this.attempt && this.state.phase === 'launching') this.requestLaunch(attempt)
      })
      return
    }
    this.requestLaunch(attempt)
  }

  private requestLaunch(attempt: number): void {
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
  private async startStream(attempt: number): Promise<void> {
    if (attempt !== this.attempt || this.state.phase !== 'launching' || !this.launchAddress) return
    this.clearTimer('queue')
    // Прежний Moonlight ещё закрывается (отключение и сразу новое подключение): два окна одного клиента
    // с одним сертификатом мешают друг другу, ждём его выхода (не дольше нескольких секунд).
    if (this.closing) {
      await Promise.race([this.closing, new Promise((r) => setTimeout(r, 4500))])
      if (attempt !== this.attempt || this.state.phase !== 'launching') return
    }
    const address = this.launchAddress
    if (this.streamProc) {
      this.streamProc.kill()
      this.streamProc = null
    }
    const stream = this.effectiveStream(address)
    const startedAt = Date.now()
    const native = this.d.nativeResolution?.()
    const proc = this.d.moonlight.stream(address, stream, native, this.state.policy)
    this.streamProc = proc
    const params = streamParams(stream, native, this.state.policy)
    this.set({
      active: {
        width: params.size?.[0] ?? 0,
        height: params.size?.[1] ?? 0,
        fps: params.fps,
        bitrateKbps: params.bitrateKbps ?? 0,
        auto: !!this.auto
      }
    })
    void this.d
      .wifi?.()
      .then((wifi) => attempt === this.attempt && this.state.wifi !== wifi && this.set({ wifi }))
      .catch(() => undefined)
    this.streamStartedAt = startedAt
    proc.onLine?.((line) => {
      const poor = parseConnectionStatus(line)
      if (poor !== undefined && attempt === this.attempt && this.streamProc === proc) this.onConnectionStatus(poor)
    })
    this.emit('streamProcess', proc.child?.pid)
    this.watchHung(attempt, proc)
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
      if (this.hungTimer) clearInterval(this.hungTimer)
      this.hungTimer = null
      this.streamProc = null
      this.send({ t: 'sessionEnded' })
      this.onConnectionStatus(false, true)
      if (this.resuming) {
        // Перезапуск (качество, геймпад, сторож) во время обрыва: запустим, когда хост снова нас пустит.
        if (this.restartPending && this.launchAddress) return
        // Игрок сам закрыл Moonlight, пока связь с хостом восстанавливалась: возвращаться больше незачем.
        this.log('Moonlight closed during a signaling drop: not coming back')
        this.teardown()
        return this.set({ phase: 'idle', signalLost: false, restarting: false, reconnecting: false })
      }
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
      this.set({ phase: 'ended', restarting: false, reconnecting: false })
      // Но не навсегда: открытое соединение занимает место у хоста.
      this.startTimer('idle', this.d.endedIdleMs ?? 10 * 60_000, attempt, () => {
        if (this.state.phase !== 'ended') return
        this.log('closing idle connection to the host')
        this.teardown()
      })
    })
  }

  /**
   * Сторож: окно Moonlight не отвечает 15 с подряд (зависло на декодере или драйвере) — перезапускаем
   * трансляцию сами (из бюджета автопереподключений), иначе игрок смотрел бы на застывший кадр.
   */
  private watchHung(attempt: number, proc: MoonlightProcess): void {
    if (this.hungTimer) clearInterval(this.hungTimer)
    this.hungTimer = null
    const isHung = this.d.isHung
    const pid = proc.child?.pid
    if (!isHung || !pid) return
    let count = 0
    this.hungTimer = setInterval(() => {
      if (attempt !== this.attempt || this.streamProc !== proc) return
      void isHung(pid)
        .then((hung) => {
          if (attempt !== this.attempt || this.streamProc !== proc) return
          // Считаем только во время игры: при запуске окно бывает занято загрузкой.
          if (this.state.phase !== 'streaming' || this.resuming) {
            count = 0
            return
          }
          count = hung ? count + 1 : 0
          if (count < 3 || this.state.phase !== 'streaming') return
          count = 0
          const now = Date.now()
          this.reconnects = this.reconnects.filter((t) => now - t < 180_000)
          if (this.reconnects.length >= 2) return this.fail('stream_failed', 'Moonlight is not responding')
          this.reconnects.push(now)
          this.log('Moonlight is not responding: restarting the stream')
          this.set({ reconnecting: true })
          this.restartPending = true
          // Зависшее окно не обработает WM_CLOSE: только kill.
          proc.kill()
        })
        .catch(() => undefined)
    }, this.d.hungCheckMs ?? 5000)
  }

  /**
   * Битрейт заметно выше потолка хоста (хост перераспределил канал, пока мы запускались или были без связи) —
   * перезапускаем трансляцию. Повышение потолка подхватится при следующем запуске: ради него игру не прерываем.
   */
  private checkCap(): void {
    const cap = this.state.policy?.maxBitrateKbps ?? 0
    const cur = this.state.active?.bitrateKbps ?? 0
    if (this.state.phase !== 'streaming' || this.resuming || cap <= 0 || cur <= cap * 1.2) return
    this.log(`host lowered the bitrate cap to ${cap} kbps: restarting the stream`)
    this.set({ capLowered: cap })
    this.restartStream(true)
  }

  private onSessionState(attempt: number, streaming: boolean): void {
    if (attempt !== this.attempt || !this.streamProc) return
    if (streaming) {
      this.clearTimer('start')
      this.clearTimer('lost')
      if (this.state.phase !== 'streaming' || this.state.restarting || this.state.reconnecting) {
        this.set({ phase: 'streaming', startedAt: this.state.startedAt ?? Date.now(), restarting: false, reconnecting: false })
        this.checkCap()
      }
      return
    }
    // Хост больше не видит стрим, а Moonlight ещё открыт (например, с окном «соединение потеряно»).
    // Сначала пробуем переподключиться сами (до 2 раз за 3 минуты), потом показываем ошибку.
    const onLost = (): void => {
      // Пока восстанавливается связь с хостом, судить рано: решим, когда он снова пришлёт состояние.
      if (this.resuming) return this.startTimer('lost', 4000, attempt, onLost)
      if (this.state.phase !== 'streaming') return
      const now = Date.now()
      this.reconnects = this.reconnects.filter((t) => now - t < 180_000)
      if (this.reconnects.length < 2 && this.ws?.readyState === WebSocket.OPEN && this.streamProc) {
        this.reconnects.push(now)
        this.log('stream lost: reconnecting')
        this.set({ reconnecting: true })
        this.restartStream(true)
        return
      }
      this.fail('connection_lost', this.d.moonlightLog?.(this.streamStartedAt))
    }
    this.startTimer('lost', this.d.streamLostGraceMs ?? 8000, attempt, onLost)
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
    if (poor) {
      this.scheduleAutoLower()
      if (this.autoRaiseTimer) clearTimeout(this.autoRaiseTimer)
      this.autoRaiseTimer = null
    } else {
      if (this.autoLowerTimer) clearTimeout(this.autoLowerTimer)
      this.autoLowerTimer = null
      if (!immediate) this.scheduleAutoRaise()
    }
    if (poor || immediate) return apply(poor)
    this.poorTimer = setTimeout(() => apply(false), this.d.poorNetworkClearMs ?? 6000)
  }

  /** Автоподбор: если связь остаётся плохой, снижаем качество на ступень (не чаще раза в минуту). */
  private scheduleAutoLower(): void {
    if (this.autoLowerTimer || !this.d.settings.get().stream.autoQuality) return
    const attempt = this.attempt
    this.autoLowerTimer = setTimeout(() => {
      this.autoLowerTimer = null
      if (attempt !== this.attempt || !this.state.poorNetwork || this.state.phase !== 'streaming') return
      if (Date.now() - this.lastAutoLower < 60_000) return this.scheduleAutoLower()
      const base = this.d.settings.get().stream
      const next = lowerProfile(this.auto ?? { resolution: base.resolution, fps: base.fps, bitrateKbps: this.state.active?.bitrateKbps ?? base.bitrateKbps }, base)
      if (!next) return
      this.auto = next
      this.lastAutoLower = Date.now()
      this.log(`auto quality: lowering to ${next.resolution} ${next.fps}fps ${next.bitrateKbps}kbps`)
      this.set({ autoLowered: true })
      this.restartStream()
    }, this.d.autoLowerAfterMs ?? 15_000)
  }

  /**
   * Автоподбор: качество снижали из-за плохой связи, а теперь она несколько минут хорошая —
   * возвращаем замеренное качество (не чаще чем через 10 минут после снижения).
   */
  private scheduleAutoRaise(): void {
    if (this.autoRaiseTimer || !this.state.autoLowered || !this.measuredAuto) return
    const attempt = this.attempt
    this.autoRaiseTimer = setTimeout(() => {
      this.autoRaiseTimer = null
      if (attempt !== this.attempt || this.state.poorNetwork || this.state.phase !== 'streaming' || !this.measuredAuto) return
      if (Date.now() - this.lastAutoLower < 10 * 60_000) return this.scheduleAutoRaise()
      this.auto = this.measuredAuto
      this.log('auto quality: connection is stable again, back to the measured quality')
      this.set({ autoLowered: false })
      this.restartStream()
    }, this.d.autoRaiseAfterMs ?? 5 * 60_000)
  }

  /** Настройки трансляции для этого хоста: автоподбор, своё качество хоста или общие настройки. */
  private effectiveStream(address: string): StreamSettings {
    const s = this.d.settings.get()
    if (s.stream.autoQuality && this.auto) return { ...s.stream, ...this.auto }
    return { ...s.stream, ...(s.hostQuality[address] ?? {}) }
  }

  /** Замер скорости канала от хоста: хост присылает несколько мегабайт, считаем время прихода. */
  private measure(attempt: number): Promise<void> {
    this.set({ measuring: true })
    return new Promise<void>((resolve) => {
      const finish = (mbps?: number): void => {
        clearTimeout(timer)
        this.speed = null
        if (attempt !== this.attempt) return resolve()
        const s = this.d.settings.get().stream
        if (mbps && mbps > 0) {
          this.auto = autoProfile(mbps, s, this.state.policy?.maxBitrateKbps ?? 0)
          this.measuredAuto = this.auto
          this.log(`speed test: ${mbps.toFixed(1)} Mbit/s -> ${this.auto.resolution} ${this.auto.fps}fps ${this.auto.bitrateKbps}kbps`)
        }
        this.set({ measuring: false, speedMbps: mbps ? Math.round(mbps) : undefined, relaySuspect: relaySuspect(this.rttSamples, mbps) })
        resolve()
      }
      // Старый хост не отвечает на замер: через несколько секунд стартуем с обычными настройками.
      const timer = setTimeout(() => finish(this.speedResult()), this.d.speedTestTimeoutMs ?? 6000)
      this.speed = { bytes: 0, first: 0, last: 0, firstBytes: 0, sentAt: performance.now(), done: finish }
      this.send({ t: 'speedTest' })
    })
  }

  private onSpeedChunk(chunk: Buffer): void {
    const sp = this.speed
    if (!sp) return
    const now = performance.now()
    if (!sp.first) {
      // Первый кусок не считаем: в нём задержка сети, а не скорость.
      sp.first = now
      sp.firstBytes = chunk.length
    }
    sp.bytes += chunk.length
    sp.last = now
  }

  private speedResult(): number | undefined {
    const sp = this.speed
    if (!sp || sp.last <= sp.first) return undefined
    const bytes = sp.bytes - sp.firstBytes
    if (bytes < 256 * 1024) return undefined
    // Куски могут прийти одной пачкой (занятый процесс, склеенные чтения TCP): тогда время между первым
    // и последним почти нулевое. Берём и время от запроса за вычетом задержки — оценка будет скромнее.
    const rtt = this.rttSamples.length ? [...this.rttSamples].sort((a, b) => a - b)[this.rttSamples.length >> 1] : 0
    const elapsed = Math.max(sp.last - sp.first, sp.last - sp.sentAt - rtt, 50)
    return (bytes * 8) / (elapsed / 1000) / 1e6
  }

  private onSpeedEnd(bytes: number): void {
    const sp = this.speed
    if (!sp?.done) return
    sp.done(bytes > 0 ? this.speedResult() : undefined)
  }

  /** «Какой геймпад мой»: хост ждёт нажатия на геймпаде игрока (до 10 с). */
  identifyPad(): void {
    if (!this.admittedAt || this.state.padIdentify === 'waiting') return
    this.set({ padIdentify: 'waiting' })
    this.send({ t: 'identifyPad' })
    if (this.identifyTimer) clearTimeout(this.identifyTimer)
    this.identifyTimer = setTimeout(() => this.state.padIdentify === 'waiting' && this.set({ padIdentify: 'notFound' }), 13_000)
  }

  /** Игрок просит у хоста ввод, который тот выключил. */
  requestInput(perms: Partial<InputPerms>): void {
    if (!this.admittedAt || this.state.inputRequest === 'pending') return
    const want: InputPerms = { keyboard: !!perms.keyboard, mouse: !!perms.mouse, gamepad: !!perms.gamepad }
    if (!want.keyboard && !want.mouse && !want.gamepad) return
    if (this.inputRequestTimer) clearTimeout(this.inputRequestTimer)
    this.set({ inputRequest: 'pending' })
    this.send({ t: 'inputRequest', perms: want })
    // Хост может так и не ответить: через минуту кнопку можно нажать снова.
    this.inputRequestTimer = setTimeout(() => this.set({ inputRequest: undefined }), 60_000)
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
  restartStream(silent = false): boolean {
    if (this.state.phase !== 'streaming' || !this.streamProc || !this.launchAddress) return false
    this.restartPending = true
    if (!silent) this.set({ restarting: true })
    const proc = this.streamProc
    if (proc.close) proc.close()
    else proc.kill()
    return true
  }

  /**
   * Переподключить геймпады: двойной или зависший геймпад. Виртуальные геймпады у хоста живут, пока идёт
   * сессия Apollo, поэтому быстро перезапускаем трансляцию: Moonlight заново находит свои геймпады,
   * а хост создаёт новые.
   */
  resetGamepad(): boolean {
    if (this.state.phase !== 'streaming') return false
    this.log('reconnecting gamepads')
    return this.restartStream()
  }

  /** Выход из Streamly: закрываем Moonlight и ждём, пока он завершится (иначе останется висеть без нас). */
  async shutdown(): Promise<void> {
    const proc = this.streamProc
    this.teardown()
    this.set({ phase: 'idle', error: undefined, errorDetail: undefined })
    if (!proc) return
    const exited = await Promise.race([proc.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 4000))])
    if (!exited) proc.kill()
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
    if (this.autoLowerTimer) clearTimeout(this.autoLowerTimer)
    this.autoLowerTimer = null
    if (this.autoRaiseTimer) clearTimeout(this.autoRaiseTimer)
    this.autoRaiseTimer = null
    if (this.hungTimer) clearInterval(this.hungTimer)
    this.hungTimer = null
    if (this.identifyTimer) clearTimeout(this.identifyTimer)
    this.identifyTimer = null
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    this.resumeTimer = null
    this.resuming = false
    this.resume = null
    if (this.inputRequestTimer) clearTimeout(this.inputRequestTimer)
    this.inputRequestTimer = null
    this.speed?.done?.()
    this.speed = null
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    for (const name of Object.keys(this.timers) as TimerName[]) this.clearTimer(name)
    this.pairProc?.kill()
    this.pairProc = null
    this.listProc?.kill()
    this.listProc = null
    if (this.streamProc) {
      // Мягкое закрытие: Moonlight сообщает Apollo об отключении, и место у хоста освобождается сразу.
      const proc = this.streamProc
      if (proc.close) proc.close()
      else proc.kill()
      this.streamProc = null
      const closing: Promise<unknown> = proc.exited.finally(() => {
        if (this.closing === closing) this.closing = null
      })
      this.closing = closing
      this.send({ t: 'sessionEnded' })
    }
    if (this.ws) {
      // Уходим сами: хост не держит за нами место, как при обрыве.
      this.send({ t: 'leave' })
      this.ws.removeAllListeners('close')
      this.ws.close()
      this.ws = null
    }
  }

  get perms(): InputPerms | undefined {
    return this.state.perms
  }
}
