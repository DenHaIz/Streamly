// Замер канала по UDP, слежение за перегрузкой во время игры и выбор кодека: чистая логика без сокетов
// (общая для хоста, клиента и тестов). Сокеты и формат пакетов — в src/main/services/net/probe.ts.
import type { Codec, HostEncoder, NetMemoryEntry, StreamPriority } from './types'

/**
 * Пакет замера по размеру как видеопакет Moonlight через Radmin: для «удалённого» IPv4 Moonlight всегда
 * режет видео на пакеты по 1024 байта (меньше нельзя, больше он сам не даст), плюс заголовки.
 */
export const PROBE_PACKET = 1100
/** Ступени замера: от 6 Мбит/с, каждая в 1,6 раза быстрее, по 400 мс (весь замер — 2–4 с). */
export const PROBE_START_KBPS = 6000
export const PROBE_GROWTH = 1.6
export const PROBE_STEP_MS = 400
export const PROBE_MAX_KBPS = 100_000
/** Хост выполняет не больше стольких ступеней за замер и не быстрее этого (защита от злоупотребления). */
export const PROBE_MAX_STEPS = 10

/**
 * До какой скорости мерить: чтобы понять, хватит ли канала на потолок хоста вместе с избыточными пакетами (FEC)
 * и запасом на всплески (видео идёт пачками по кадру). Без потолка — до 100 Мбит/с.
 */
export function probeTarget(capKbps: number, fecPercent: number): number {
  if (capKbps <= 0) return PROBE_MAX_KBPS
  return Math.min(PROBE_MAX_KBPS, Math.round((capKbps * (1 + fecPercent / 100)) / 0.7))
}

/** Скорости ступеней до цели (последняя — первая, которая не меньше цели). */
export function probeRates(targetKbps: number): number[] {
  const out: number[] = []
  let r = PROBE_START_KBPS
  while (out.length < PROBE_MAX_STEPS) {
    out.push(Math.round(r))
    if (r >= targetKbps || r >= PROBE_MAX_KBPS) break
    r = Math.min(PROBE_MAX_KBPS, r * PROBE_GROWTH)
  }
  return out
}

/** Пакет ступени, как его увидел клиент: когда отправлен (часы хоста) и когда пришёл (часы клиента). */
export interface ProbeSample {
  sentAt: number
  arrivedAt: number
}

export interface StepResult {
  rateKbps: number
  sent: number
  received: number
  /** Доля потерянных пакетов, 0–1. */
  loss: number
  /** Очередь: насколько задержка в конце ступени выше наименьшей за весь замер, мс. */
  queueMs: number
  /** Сколько реально дошло, кбит/с. */
  deliveredKbps: number
}

const median = (a: number[]): number => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[s.length >> 1]
}

/**
 * Итог ступени. Часы хоста и клиента не совпадают, но разница постоянна: задержка «в одну сторону» считается
 * относительно основы (base, медиана первой, медленной ступени) — её рост и есть очередь перед узким местом.
 * Основа — медиана, а не минимум: у ретранслятора Radmin и на Wi-Fi разброс задержки большой, и от минимума
 * он выглядел бы как очередь на любой скорости. Очередь смотрим по последним 40% пакетов: при перегрузке
 * она растёт к концу ступени.
 */
export function analyzeStep(rateKbps: number, sent: number, samples: ProbeSample[], base: number, durationMs: number, size = PROBE_PACKET): StepResult {
  const received = Math.min(samples.length, sent || samples.length)
  const loss = sent > 0 ? Math.max(0, 1 - received / sent) : 1
  const sorted = [...samples].sort((a, b) => a.sentAt - b.sentAt)
  const tail = sorted.slice(Math.floor(sorted.length * 0.6))
  const queueMs = tail.length ? Math.max(0, median(tail.map((s) => s.arrivedAt - s.sentAt)) - base) : 0
  let deliveredKbps = 0
  if (sorted.length > 1) {
    const first = Math.min(...sorted.map((s) => s.arrivedAt))
    const last = Math.max(...sorted.map((s) => s.arrivedAt))
    // Пачка, пришедшая разом, не должна давать «бесконечную» скорость: не меньше 80% длительности ступени.
    const span = Math.max(last - first, durationMs * 0.8, 1)
    deliveredKbps = Math.round((received * size * 8) / span)
  }
  return { rateKbps, sent, received, loss, queueMs: Math.round(queueMs), deliveredKbps }
}

/** Типичная (медианная) задержка «в одну сторону» среди пакетов — основа для очереди. */
export function medianDelay(samples: ProbeSample[]): number | undefined {
  return samples.length ? median(samples.map((s) => s.arrivedAt - s.sentAt)) : undefined
}

/** Порог очереди: больше — канал не успевает, пакеты копятся (и задержка в игре растёт так же). */
export const QUEUE_LIMIT_MS = 40

/**
 * Ступень прошла: потерь почти нет (сверх постоянных потерь сети, например Wi-Fi, которые видны уже на первой
 * ступени) и очередь не растёт.
 */
export function stepOk(r: StepResult, baseLoss: number): boolean {
  return r.loss <= Math.max(0.03, Math.min(baseLoss, 0.1) + 0.03) && r.queueMs <= QUEUE_LIMIT_MS
}

export interface ProbeOutcome {
  /** Оценка пропускной способности канала от хоста, кбит/с. */
  capacityKbps: number
  /** Канал упёрся (была неудачная ступень); false — канал не меньше capacityKbps, дальше не мерили. */
  saturated: boolean
  /** Потери на первой (медленной) ступени, %: постоянные потери сети. */
  baseLossPct: number
  steps: StepResult[]
}

/**
 * Оценка канала по ступеням: самая быстрая ступень до первой неудачной. Если на неудачной дошло больше,
 * чем на последней удачной, — 90% от дошедшего (настоящий канал где-то между ступенями).
 */
export function probeOutcome(steps: StepResult[]): ProbeOutcome | null {
  if (!steps.length || steps[0].received === 0) return null
  const baseLoss = steps[0].loss
  let lastOk: StepResult | undefined
  for (const s of steps) {
    if (stepOk(s, baseLoss)) {
      lastOk = s
      continue
    }
    const fromBad = Math.round(Math.min(s.rateKbps, s.deliveredKbps) * 0.9)
    return { capacityKbps: Math.max(lastOk?.rateKbps ?? 0, fromBad), saturated: true, baseLossPct: Math.round(baseLoss * 1000) / 10, steps }
  }
  return { capacityKbps: lastOk!.rateKbps, saturated: false, baseLossPct: Math.round(baseLoss * 1000) / 10, steps }
}

/** Доля канала под видео в зависимости от приоритета: чем больше запас, тем короче очередь и ниже задержка. */
export const PRIORITY_SHARE: Record<StreamPriority, number> = { latency: 0.7, balanced: 0.8, quality: 0.9 }
export const MIN_BITRATE = 2500

/** Битрейт видео по каналу: доля канала минус избыточные пакеты (FEC) и звук, кратно 500 кбит/с. */
export function bitrateForCapacity(capacityKbps: number, fecPercent: number, priority: StreamPriority): number {
  const video = (capacityKbps * PRIORITY_SHARE[priority]) / (1 + fecPercent / 100) - 256
  return Math.max(MIN_BITRATE, Math.floor(video / 500) * 500)
}

export const NET_MEMORY_TTL_MS = 14 * 24 * 3600_000
/** На сколько можно подняться выше прошлого удачного битрейта за одно подключение. */
export const NET_MEMORY_STEP = 1.15

/**
 * Стартовый битрейт с учётом прошлых подключений: после проблем поднимаемся осторожно, на 15% за раз,
 * но не ниже половины сегодняшнего замера — один неудачный вечер не должен надолго занижать качество.
 */
export function startBitrate(probeKbps: number | undefined, mem: NetMemoryEntry | undefined, now: number): number | undefined {
  const fresh = mem && mem.limited && now - mem.at < NET_MEMORY_TTL_MS ? mem : undefined
  const fromMem = fresh ? Math.max(MIN_BITRATE, Math.round((fresh.kbps * NET_MEMORY_STEP) / 500) * 500) : undefined
  if (probeKbps === undefined) return fromMem
  if (fromMem === undefined) return probeKbps
  const floor = Math.max(MIN_BITRATE, Math.floor((probeKbps * 0.5) / 500) * 500)
  return Math.min(probeKbps, Math.max(fromMem, floor))
}

/**
 * Слежение за перегрузкой по маленьким UDP-пакетам до хоста и обратно (5 в секунду).
 * Канал забивается раньше, чем Moonlight начинает терять кадры: сначала растёт очередь и с ней задержка.
 * Основа — 10-й процентиль задержки за последнюю минуту (не минимум: случайно быстрый пакет на сети
 * с большим разбросом давал бы ложную «очередь»); перегрузка — когда медиана за 2 с выше основы на 50 мс
 * или теряется четверть пакетов, и так 8 с подряд. Короткие всплески (поиск сетей Wi-Fi раз в минуту,
 * загрузка у хоста) не считаются: ради них перезапускать трансляцию хуже, чем переждать.
 */
export class CongestionWatch {
  private samples: { at: number; rtt: number | null }[] = []
  private since = 0
  static readonly QUEUE_MS = 50
  static readonly LOSS = 0.25
  static readonly HOLD_MS = 8000

  /** rtt === null — ответ не пришёл. */
  add(at: number, rtt: number | null): void {
    this.samples.push({ at, rtt })
    const cut = at - 60_000
    while (this.samples.length && this.samples[0].at < cut) this.samples.shift()
  }

  reset(): void {
    this.samples = []
    this.since = 0
  }

  /** Не идёт игра (запуск, перезапуск): отсчёт «3 с подряд» начинается заново. */
  clearHold(): void {
    this.since = 0
  }

  /** Основа: 10-й процентиль задержки за минуту, мс. */
  baseMs(): number | undefined {
    const list = this.samples.filter((s) => s.rtt !== null).map((s) => s.rtt as number)
    if (!list.length) return undefined
    list.sort((a, b) => a - b)
    return list[Math.floor(list.length * 0.1)]
  }

  /** Очередь сейчас (медиана за 2 с минус основа) и потери за 3 с. */
  current(at: number): { queueMs: number; loss: number; count: number } {
    const base = this.baseMs()
    const recent = this.samples.filter((s) => s.at >= at - 2000 && s.rtt !== null).map((s) => s.rtt as number)
    const window = this.samples.filter((s) => s.at >= at - 3000)
    const lost = window.filter((s) => s.rtt === null).length
    return {
      queueMs: base === undefined || !recent.length ? 0 : Math.max(0, median(recent) - base),
      loss: window.length ? lost / window.length : 0,
      count: window.length
    }
  }

  /** Перегрузка держится не меньше HOLD_MS. */
  congested(at: number): boolean {
    const c = this.current(at)
    // Потеряны все пинги — это не перегрузка, а пропавший путь UDP (файрвол, хост закрыл токен): судить не по чему.
    // При настоящем обрыве Moonlight сам сообщит о плохой связи или закроется, и сработает переподключение.
    const bad = c.count >= 8 && c.loss < 1 && (c.queueMs >= CongestionWatch.QUEUE_MS || c.loss >= CongestionWatch.LOSS)
    if (!bad) {
      this.since = 0
      return false
    }
    if (!this.since) this.since = at
    return at - this.since >= CongestionWatch.HOLD_MS
  }
}

export interface DecoderCaps {
  h264: boolean
  hevc: boolean
  av1: boolean
}

/**
 * Кодек при настройке «авто». Moonlight сам выбирает HEVC, если игрок его декодирует аппаратно, а AV1 обходит.
 * AV1 даёт ту же картинку при ещё меньшем битрейте, но на слабых каналах через Radmin не проверен —
 * берём его только по выбору игрока («Качество») и если обе видеокарты умеют AV1 аппаратно. HEVC — когда оба умеют.
 * constrained (канал ограничивает качество) пока только для журнала.
 * Неизвестно (старый хост, нет помощника) или 4:4:4 — решает Moonlight.
 * Возвращает 'auto', если выбирать нечего.
 */
export function chooseCodec(o: { setting: Codec; host?: HostEncoder; client?: DecoderCaps; constrained: boolean; priority: StreamPriority; yuv444: boolean }): Codec {
  if (o.setting !== 'auto' || !o.host || !o.client || o.yuv444) return o.setting
  // Кодирование на процессоре: H.264 заметно быстрее HEVC и AV1.
  if (o.host.vendor === 'software') return 'H.264'
  if (o.priority === 'quality' && o.host.av1 && o.client.av1) return 'AV1'
  if (o.host.hevc && o.client.hevc) return 'HEVC'
  return 'auto'
}

/** Битрейт, который Moonlight взял бы сам для такого разрешения и частоты (20 Мбит/с на 1080p60). */
export function naturalBitrate(width: number, height: number, fps: number): number {
  return Math.round((20000 * ((width * height) / (1920 * 1080)) * Math.max(fps, 30)) / 60)
}
