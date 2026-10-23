import { randomBytes } from 'node:crypto'
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram'
import {
  analyzeStep,
  medianDelay,
  PROBE_MAX_KBPS,
  PROBE_MAX_STEPS,
  PROBE_PACKET,
  PROBE_STEP_MS,
  probeOutcome,
  probeRates,
  stepOk,
  type ProbeOutcome,
  type ProbeSample,
  type StepResult
} from '@shared/netprobe'

/**
 * UDP-пакеты замера идут через порт поиска хоста (47901): для него уже есть правило файрвола.
 * Формат: «SPRB», тип (1 байт), дальше по типу:
 *  R — клиент регистрирует свой адрес: токен (16 символов), выданный хостом по сигнальному соединению;
 *  A — хост подтверждает регистрацию: токен;
 *  D — данные ступени: номер ступени (1), номер пакета (4), время отправки у хоста (8), нули до PROBE_PACKET;
 *  P — пинг клиента: токен, номер (4), время (8); Q — тот же пакет обратно от хоста.
 */
const MAGIC = Buffer.from('SPRB')
const TOKEN_LEN = 16
const PING_LEN = 5 + TOKEN_LEN + 12

const kindOf = (b: Buffer): string | null => (b.length >= 5 && b.subarray(0, 4).equals(MAGIC) ? String.fromCharCode(b[4]) : null)
const tokenOf = (b: Buffer): string => b.subarray(5, 5 + TOKEN_LEN).toString('latin1')

function packet(kind: string, token: string): Buffer {
  const b = Buffer.alloc(5 + TOKEN_LEN)
  MAGIC.copy(b)
  b[4] = kind.charCodeAt(0)
  b.write(token, 5, 'latin1')
  return b
}

const plain = (ip: string): string => ip.replace(/^::ffff:/, '')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Пакет замера? (Порт поиска получает и запросы поиска.) */
export function isProbePacket(b: Buffer): boolean {
  return kindOf(b) !== null
}

interface HostPeer {
  address: string
  port?: number
  busy: boolean
  steps: number
  pingCount: number
  pingWindow: number
}

/**
 * Хост: отвечает на регистрацию и пинги, по запросу игрока отправляет ему ступень с заданной скоростью.
 * Всё только для допущенных игроков (токен выдаётся по сигнальному соединению) и только на их адрес.
 */
export class ProbeHost {
  private readonly peers = new Map<string, HostPeer>()

  constructor(private readonly send: (buf: Buffer, port: number, address: string) => void) {}

  /** Новый токен для игрока с этим адресом (старый токен игрока закрывается). */
  open(address: string, prev?: string): string {
    if (prev) this.peers.delete(prev)
    const token = randomBytes(12).toString('base64url').slice(0, TOKEN_LEN)
    this.peers.set(token, { address: plain(address), busy: false, steps: 0, pingCount: 0, pingWindow: 0 })
    return token
  }

  close(token: string | undefined): void {
    if (token) this.peers.delete(token)
  }

  clear(): void {
    this.peers.clear()
  }

  /** Обработать пакет замера. false — это не пакет замера. */
  onPacket(msg: Buffer, rinfo: RemoteInfo): boolean {
    const kind = kindOf(msg)
    if (!kind) return false
    if (msg.length < 5 + TOKEN_LEN) return true
    const p = this.peers.get(tokenOf(msg))
    if (!p || p.address !== plain(rinfo.address)) return true
    if (kind === 'R') {
      p.port = rinfo.port
      this.send(packet('A', tokenOf(msg)), rinfo.port, rinfo.address)
    } else if (kind === 'P' && msg.length === PING_LEN && rinfo.port === p.port) {
      // Не больше 30 пингов в секунду: ответ того же размера, что и запрос, — усиления нет.
      const now = Date.now()
      if (now - p.pingWindow > 1000) {
        p.pingWindow = now
        p.pingCount = 0
      }
      if (++p.pingCount > 30) return true
      const reply = Buffer.from(msg)
      reply[4] = 'Q'.charCodeAt(0)
      this.send(reply, rinfo.port, rinfo.address)
    }
    return true
  }

  /** Сколько ступеней осталось этому игроку в текущем замере. */
  canStep(token: string): boolean {
    const p = this.peers.get(token)
    return !!p && !!p.port && !p.busy && p.steps < PROBE_MAX_STEPS
  }

  /** Новый замер (раз в 20 с — следит хост): счётчик ступеней с нуля. */
  resetSteps(token: string): void {
    const p = this.peers.get(token)
    if (p) p.steps = 0
  }

  /**
   * Ступень: пакеты по PROBE_PACKET байт со скоростью kbps в течение ms. Отправляем по часам, а не по таймеру:
   * сколько должно было уйти к этому моменту, столько и досылаем (таймеры Windows шагают по ~15 мс —
   * получаются пачки, как у настоящего видео, где кадр уходит пачкой). Возвращает число отправленных пакетов.
   */
  async step(token: string, id: number, kbps: number, ms: number): Promise<number> {
    const p = this.peers.get(token)
    if (!p || !p.port || p.busy) return 0
    p.busy = true
    p.steps++
    const rate = Math.max(500, Math.min(PROBE_MAX_KBPS, kbps))
    const dur = Math.max(100, Math.min(1000, ms))
    const perMs = rate / (PROBE_PACKET * 8)
    const template = Buffer.alloc(PROBE_PACKET)
    MAGIC.copy(template)
    template[4] = 'D'.charCodeAt(0)
    template[5] = id & 0xff
    let seq = 0
    const start = performance.now()
    try {
      for (;;) {
        const now = performance.now()
        const elapsed = now - start
        const due = Math.min(Math.floor(elapsed * perMs), Math.ceil(dur * perMs))
        while (seq < due) {
          if (!this.peers.has(token)) return seq
          const b = Buffer.from(template)
          b.writeUInt32LE(seq, 6)
          b.writeDoubleLE(performance.now(), 10)
          this.send(b, p.port, p.address)
          seq++
        }
        if (elapsed >= dur) return seq
        await sleep(2)
      }
    } finally {
      p.busy = false
    }
  }
}

/**
 * Клиент: свой UDP-сокет до порта поиска хоста. Принимает ступени замера и отвечает пингами для слежения
 * за перегрузкой во время игры.
 */
export class ProbeClient {
  private socket: Socket | null = null
  private readonly steps = new Map<number, ProbeSample[]>()
  private registered: (() => void) | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private pingSeq = 0
  private readonly pending = new Map<number, number>()

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly token: string
  ) {}

  /** Открыть сокет и зарегистрироваться у хоста. false — хост не ответил (UDP не проходит). */
  start(timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
      const s = createSocket('udp4')
      this.socket = s
      let done = false
      const finish = (ok: boolean): void => {
        if (done) return
        done = true
        clearInterval(retry)
        clearTimeout(timer)
        this.registered = null
        resolve(ok)
      }
      s.on('error', () => finish(false))
      s.on('message', (msg, rinfo) => this.onMessage(msg, rinfo))
      this.registered = () => finish(true)
      const reg = packet('R', this.token)
      const sendReg = (): void => {
        try {
          s.send(reg, this.port, this.host)
        } catch {
          /* сокет закрыт */
        }
      }
      const retry = setInterval(sendReg, 250)
      const timer = setTimeout(() => finish(false), timeoutMs)
      s.bind(0, () => {
        // Ступень приходит пачками по ~15 мс (до 75 КБ): маленький буфер сокета дал бы ложные потери.
        try {
          s.setRecvBufferSize(4 * 1024 * 1024)
        } catch {
          /* система не дала — работаем с обычным */
        }
        sendReg()
      })
    })
  }

  private onMessage(msg: Buffer, rinfo: RemoteInfo): void {
    if (plain(rinfo.address) !== this.host) return
    const kind = kindOf(msg)
    if (kind === 'A') {
      if (tokenOf(msg) === this.token) this.registered?.()
    } else if (kind === 'D' && msg.length >= 18) {
      const list = this.steps.get(msg[5])
      if (list) list.push({ sentAt: msg.readDoubleLE(10), arrivedAt: performance.now() })
    } else if (kind === 'Q' && msg.length === PING_LEN && tokenOf(msg) === this.token) {
      const seq = msg.readUInt32LE(5 + TOKEN_LEN)
      const sent = this.pending.get(seq)
      if (sent === undefined) return
      this.pending.delete(seq)
      this.onPing?.(Math.max(0, performance.now() - sent))
    }
  }

  /** Начать сбор пакетов ступени. */
  expect(id: number): void {
    this.steps.set(id, [])
  }

  samples(id: number): ProbeSample[] {
    return this.steps.get(id) ?? []
  }

  private onPing?: (rtt: number | null) => void

  /** Пинги до хоста каждые intervalMs; ответ не пришёл за 1 с — потеря (null). */
  startPings(intervalMs: number, cb: (rtt: number | null) => void): void {
    this.stopPings()
    this.onPing = cb
    this.pingTimer = setInterval(() => {
      const now = performance.now()
      for (const [seq, at] of this.pending) {
        if (now - at > 1000) {
          this.pending.delete(seq)
          cb(null)
        }
      }
      const b = Buffer.alloc(PING_LEN)
      MAGIC.copy(b)
      b[4] = 'P'.charCodeAt(0)
      b.write(this.token, 5, 'latin1')
      const seq = this.pingSeq++ >>> 0
      b.writeUInt32LE(seq, 5 + TOKEN_LEN)
      b.writeDoubleLE(now, 5 + TOKEN_LEN + 4)
      this.pending.set(seq, now)
      try {
        this.socket?.send(b, this.port, this.host)
      } catch {
        /* сокет закрыт */
      }
    }, intervalMs)
  }

  stopPings(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    this.pending.clear()
    this.onPing = undefined
  }

  close(): void {
    this.stopPings()
    this.steps.clear()
    try {
      this.socket?.close()
    } catch {
      /* уже закрыт */
    }
    this.socket = null
  }
}

/** Запрос ступени у хоста (по сигнальному соединению): ответ — сколько пакетов ушло и с какой скоростью. */
export type AskStep = (id: number, kbps: number, ms: number) => Promise<{ sent: number; kbps: number } | null>

/**
 * Замер канала ступенями: от 6 Мбит/с, пока ступень проходит (почти без потерь и без роста очереди)
 * и пока не набрана цель. Возвращает null, если не пришло ни одного пакета (UDP не проходит).
 */
export async function measureChannel(pc: ProbeClient, ask: AskStep, targetKbps: number, cancelled: () => boolean): Promise<ProbeOutcome | null> {
  const results: StepResult[] = []
  let base: number | undefined
  const rates = probeRates(targetKbps)
  for (let i = 0; i < rates.length; i++) {
    if (cancelled()) return null
    pc.expect(i)
    const r = await ask(i, rates[i], PROBE_STEP_MS)
    if (!r || cancelled()) break
    // Опоздавшие пакеты ступени (очередь в сети).
    await sleep(200)
    const samples = pc.samples(i)
    // Основа очереди — первая (медленная) ступень.
    if (base === undefined) base = medianDelay(samples)
    const res = analyzeStep(r.kbps, r.sent, samples, base ?? 0, PROBE_STEP_MS)
    results.push(res)
    if (res.received === 0 || !stepOk(res, results[0].loss)) break
    // Хост ограничил скорость (кто-то уже играет): выше мерить нечем.
    if (r.kbps < rates[i]) break
  }
  return probeOutcome(results)
}
