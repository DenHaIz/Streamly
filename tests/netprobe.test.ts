import { describe, expect, it } from 'vitest'
import {
  analyzeStep,
  bitrateForCapacity,
  chooseCodec,
  CongestionWatch,
  naturalBitrate,
  PROBE_PACKET,
  PROBE_STEP_MS,
  probeOutcome,
  probeRates,
  probeTarget,
  medianDelay,
  startBitrate,
  type ProbeSample
} from '../src/shared/netprobe'
import { measureChannel, ProbeClient, ProbeHost } from '../src/main/services/net/probe'
import { createSocket } from 'node:dgram'
import { lowerProfile } from '../src/main/services/client/quality'
import { normalizeNetMemory, normalizeSettings } from '../src/main/settings'
import type { Settings } from '../src/shared/types'

/**
 * Канал с узким местом: ступень со скоростью rate через канал capKbps. Пока rate ≤ cap — всё доходит
 * с постоянной задержкой; выше — очередь растёт, а то, что не влезло в буфер (bufferMs), теряется.
 */
function bottleneck(rate: number, capKbps: number, opts: { randomLoss?: number; bufferMs?: number; delay?: number; jitter?: number } = {}): { sent: number; samples: ProbeSample[] } {
  const sent = Math.floor((rate * PROBE_STEP_MS) / (PROBE_PACKET * 8))
  const samples: ProbeSample[] = []
  const service = (PROBE_PACKET * 8) / capKbps // мс на пакет
  const buffer = opts.bufferMs ?? 150
  let free = 0
  for (let i = 0; i < sent; i++) {
    const sentAt = (i * PROBE_STEP_MS) / sent
    if (opts.randomLoss && (i * 7919) % 100 < opts.randomLoss * 100) continue
    const start = Math.max(sentAt, free)
    if (start - sentAt > buffer) continue
    free = start + service
    // Разброс задержки сети (ретранслятор, Wi-Fi): не зависит от скорости.
    const jitter = opts.jitter ? ((i * 104729) % 1000) / 1000 * opts.jitter : 0
    samples.push({ sentAt: 1000 + sentAt, arrivedAt: 5000 + (opts.delay ?? 20) + free + jitter })
  }
  return { sent, samples }
}

function run(capKbps: number, target: number, opts: { randomLoss?: number; jitter?: number } = {}) {
  const steps = []
  let base: number | undefined
  for (const rate of probeRates(target)) {
    const { sent, samples } = bottleneck(rate, capKbps, opts)
    if (base === undefined) base = medianDelay(samples)
    const r = analyzeStep(rate, sent, samples, base ?? 0, PROBE_STEP_MS)
    steps.push(r)
    const out = probeOutcome(steps)
    if (out?.saturated) return out
  }
  return probeOutcome(steps)
}

describe('UDP channel probe', () => {
  it('plans steps up to the host cap with FEC and headroom', () => {
    expect(probeTarget(20000, 20)).toBe(34286)
    expect(probeRates(probeTarget(20000, 20))).toEqual([6000, 9600, 15360, 24576, 39322])
    expect(probeRates(probeTarget(0, 20)).at(-1)).toBe(100000)
  })

  it('finds the bottleneck: the fastest step without loss or a growing queue', () => {
    const slow = run(15000, probeTarget(20000, 20))!
    expect(slow.saturated).toBe(true)
    expect(slow.capacityKbps).toBeGreaterThanOrEqual(13000)
    expect(slow.capacityKbps).toBeLessThanOrEqual(15400)
    // На таком канале видео — около 10 Мбит/с (80% канала минус FEC 20% и звук), а не потолок хоста 20.
    expect(bitrateForCapacity(slow.capacityKbps, 20, 'balanced')).toBeLessThanOrEqual(10000)

    const fast = run(200000, probeTarget(20000, 20))!
    expect(fast.saturated).toBe(false)
    expect(fast.capacityKbps).toBe(39322)
    expect(bitrateForCapacity(fast.capacityKbps, 20, 'balanced')).toBeGreaterThanOrEqual(20000)

    // Совсем слабый канал (4 Мбит/с): уже первая ступень не проходит — оценка по тому, что дошло.
    const weak = run(4000, probeTarget(20000, 20))!
    expect(weak.saturated).toBe(true)
    expect(weak.capacityKbps).toBeGreaterThan(2500)
    expect(weak.capacityKbps).toBeLessThanOrEqual(4000)
  })

  it('tells constant losses (Wi-Fi) from congestion', () => {
    // 2% потерь на любой скорости: канал при этом широкий, замер не должен упасть до первой ступени.
    const wifi = run(200000, probeTarget(20000, 20), { randomLoss: 0.02 })!
    expect(wifi.capacityKbps).toBe(39322)
    expect(wifi.baseLossPct).toBeGreaterThan(0)
  })

  it('does not take network jitter (Radmin relay) for a queue', () => {
    // Разброс до 100 мс на широком канале: от минимума это выглядело бы как очередь 50 мс, но замер не должен упереться.
    const relay = run(200000, probeTarget(20000, 20), { jitter: 100 })!
    expect(relay.saturated).toBe(false)
    // А настоящее узкое место с тем же разбросом находится.
    const slow = run(15000, probeTarget(20000, 20), { jitter: 100 })!
    expect(slow.saturated).toBe(true)
    expect(slow.capacityKbps).toBeLessThanOrEqual(15400)
  })

  it('gives less of the channel to video when latency matters more', () => {
    expect(bitrateForCapacity(30000, 20, 'latency')).toBeLessThan(bitrateForCapacity(30000, 20, 'balanced'))
    expect(bitrateForCapacity(30000, 20, 'balanced')).toBeLessThan(bitrateForCapacity(30000, 20, 'quality'))
    expect(bitrateForCapacity(1000, 20, 'balanced')).toBe(2500)
  })

  it('runs over real UDP sockets: host paces steps, client collects them and pings', async () => {
    const hostSock = createSocket('udp4')
    await new Promise<void>((r) => hostSock.bind(0, '127.0.0.1', () => r()))
    const port = hostSock.address().port
    const probe = new ProbeHost((b, p, a) => hostSock.send(b, p, a))
    hostSock.on('message', (m, rinfo) => probe.onPacket(m, rinfo))
    const token = probe.open('127.0.0.1')
    // Чужой токен не регистрируется.
    const stranger = new ProbeClient('127.0.0.1', port, 'x'.repeat(16))
    expect(await stranger.start(400)).toBe(false)
    stranger.close()

    const pc = new ProbeClient('127.0.0.1', port, token)
    expect(await pc.start()).toBe(true)
    const out = await measureChannel(
      pc,
      async (id, kbps, ms) => ({ sent: await probe.step(token, id, kbps, ms), kbps }),
      probeTarget(5000, 20),
      () => false
    )
    expect(out).not.toBeNull()
    expect(out!.steps[0].received).toBeGreaterThan(0)
    expect(out!.capacityKbps).toBeGreaterThanOrEqual(6000)

    const rtts: (number | null)[] = []
    pc.startPings(20, (r) => rtts.push(r))
    await new Promise((r) => setTimeout(r, 300))
    expect(rtts.filter((r) => r !== null).length).toBeGreaterThan(3)
    // Хост закрыл токен (игрок ушёл): ответов больше нет — пинги считаются потерянными.
    probe.close(token)
    rtts.length = 0
    await new Promise((r) => setTimeout(r, 1300))
    expect(rtts.some((r) => r === null)).toBe(true)
    expect(await probe.step(token, 0, 6000, 100)).toBe(0)
    pc.close()
    hostSock.close()
  }, 15000)
})

describe('congestion watch', () => {
  it('flags a queue that holds for 3 seconds, not a single spike', () => {
    const w = new CongestionWatch()
    let t = 0
    for (; t < 10_000; t += 200) w.add(t, 30)
    expect(w.congested(t)).toBe(false)
    // Один всплеск.
    w.add(t, 300)
    expect(w.congested(t)).toBe(false)
    // Очередь 4 с (поиск сетей Wi-Fi, загрузка у хоста) — переждать, а не перезапускать игру.
    for (let i = 0; i < 20; i++) {
      t += 200
      w.add(t, 120)
      expect(w.congested(t)).toBe(false)
    }
    for (let i = 0; i < 20; i++) {
      t += 200
      w.add(t, 30)
      w.congested(t)
    }
    // Очередь держится: 90 мс сверх основы 30.
    for (let i = 0; i < 50; i++) {
      t += 200
      w.add(t, 120)
      w.congested(t)
    }
    expect(w.current(t).queueMs).toBeGreaterThanOrEqual(45)
    expect(w.congested(t)).toBe(true)
    // Отсчёт сбрасывается, когда игра не идёт.
    w.clearHold()
    expect(w.congested(t)).toBe(false)
  })

  it('does not flag constant jitter as congestion', () => {
    const w = new CongestionWatch()
    let t = 0
    // Задержка 30–90 мс вразброс (ретранслятор): медиана выше минимума на 30, но выше 10-го процентиля меньше чем на 45.
    for (let i = 0; i < 300; i++) {
      t += 200
      w.add(t, 30 + ((i * 37) % 61))
      w.congested(t)
    }
    expect(w.congested(t)).toBe(false)
  })

  it('flags lost pings', () => {
    const w = new CongestionWatch()
    let t = 0
    for (; t < 4000; t += 200) w.add(t, 20)
    for (let i = 0; i < 50; i++) {
      t += 200
      w.add(t, i % 2 ? 20 : null)
      w.congested(t)
    }
    expect(w.current(t).loss).toBeGreaterThanOrEqual(0.25)
    expect(w.congested(t)).toBe(true)
  })

  it('does not take a lost UDP path (all pings lost) for congestion', () => {
    const w = new CongestionWatch()
    let t = 0
    for (; t < 4000; t += 200) w.add(t, 20)
    for (let i = 0; i < 25; i++) {
      t += 200
      w.add(t, null)
      w.congested(t)
    }
    expect(w.congested(t)).toBe(false)
  })
})

describe('memory of the channel to a host', () => {
  it('climbs back carefully after trouble, 15% per connection', () => {
    const now = Date.now()
    expect(startBitrate(18000, undefined, now)).toBe(18000)
    expect(startBitrate(18000, { kbps: 10000, at: now, limited: true }, now)).toBe(11500)
    expect(startBitrate(9000, { kbps: 10000, at: now, limited: true }, now)).toBe(9000)
    // Но не ниже половины сегодняшнего замера: один плохой вечер не держит качество низким неделями.
    expect(startBitrate(18000, { kbps: 3000, at: now, limited: true }, now)).toBe(9000)
    // Без предела (связь не упиралась) или старая запись — решает замер.
    expect(startBitrate(18000, { kbps: 10000, at: now, limited: false }, now)).toBe(18000)
    expect(startBitrate(18000, { kbps: 10000, at: now - 30 * 24 * 3600_000, limited: true }, now)).toBe(18000)
    // Замер не удался: стартуем по памяти.
    expect(startBitrate(undefined, { kbps: 10000, at: now, limited: true }, now)).toBe(11500)
  })

  it('keeps only valid entries in the settings and turns auto quality on once', () => {
    const now = Date.now()
    expect(normalizeNetMemory({ '26.1.2.3': { kbps: 9000, at: now, limited: true }, bad: { kbps: 1, at: now }, '26.1.2.4': { kbps: 9000 } })).toEqual({
      '26.1.2.3': { kbps: 9000, at: now, limited: true }
    })
    const old = normalizeSettings({ schema: 5, nickname: 'A', stream: { autoQuality: false } } as unknown as Settings)
    expect(old.stream.autoQuality).toBe(true)
    expect(old.stream.priority).toBe('balanced')
    // Кто выбрал качество сам (например, «Экономно» для слабого канала), автоподбор не получает.
    expect(normalizeSettings({ schema: 5, nickname: 'A', stream: { autoQuality: false, bitrateKbps: 6000, resolution: '720', fps: 60 } } as unknown as Settings).stream.autoQuality).toBe(false)
    expect(
      normalizeSettings({ schema: 5, nickname: 'A', stream: { autoQuality: false }, hostQuality: { '26.1.2.3': { resolution: '720', fps: 60, bitrateKbps: 6000 } } } as unknown as Settings).stream.autoQuality
    ).toBe(false)
    // Выключенный после обновления автоподбор остаётся выключенным.
    expect(normalizeSettings({ ...old, stream: { ...old.stream, autoQuality: false } }).stream.autoQuality).toBe(false)
  })

  it('lowers by a given step', () => {
    expect(lowerProfile({ resolution: 'auto', fps: 60, bitrateKbps: 20000 }, { resolution: 'auto', fps: 60 }, 0.75)?.bitrateKbps).toBe(15000)
    expect(lowerProfile({ resolution: 'auto', fps: 60, bitrateKbps: 20000 }, { resolution: 'auto', fps: 60 })?.bitrateKbps).toBe(14000)
  })
})

describe('codec choice', () => {
  const nv = { vendor: 'nvenc' as const, hevc: true, av1: true }
  const all = { h264: true, hevc: true, av1: true }
  it('picks HEVC when both sides decode it, AV1 only when the player chose quality', () => {
    expect(chooseCodec({ setting: 'auto', host: nv, client: all, constrained: false, priority: 'balanced', yuv444: false })).toBe('HEVC')
    // На слабом канале AV1 через Radmin не проверен: по умолчанию HEVC.
    expect(chooseCodec({ setting: 'auto', host: nv, client: all, constrained: true, priority: 'balanced', yuv444: false })).toBe('HEVC')
    expect(chooseCodec({ setting: 'auto', host: nv, client: all, constrained: false, priority: 'quality', yuv444: false })).toBe('AV1')
    // Игрок без аппаратного AV1 — HEVC; без HEVC — решает Moonlight.
    expect(chooseCodec({ setting: 'auto', host: nv, client: { ...all, av1: false }, constrained: true, priority: 'quality', yuv444: false })).toBe('HEVC')
    expect(chooseCodec({ setting: 'auto', host: nv, client: { h264: true, hevc: false, av1: false }, constrained: true, priority: 'balanced', yuv444: false })).toBe('auto')
    // Хост без AV1 (RTX 30 и старше).
    expect(chooseCodec({ setting: 'auto', host: { ...nv, av1: false }, client: all, constrained: true, priority: 'quality', yuv444: false })).toBe('HEVC')
  })

  it('leaves the choice to the player or Moonlight when it should', () => {
    expect(chooseCodec({ setting: 'H.264', host: nv, client: all, constrained: true, priority: 'quality', yuv444: false })).toBe('H.264')
    expect(chooseCodec({ setting: 'auto', host: undefined, client: all, constrained: true, priority: 'quality', yuv444: false })).toBe('auto')
    expect(chooseCodec({ setting: 'auto', host: nv, client: undefined, constrained: true, priority: 'quality', yuv444: false })).toBe('auto')
    expect(chooseCodec({ setting: 'auto', host: nv, client: all, constrained: true, priority: 'quality', yuv444: true })).toBe('auto')
    // Кодирование процессором: H.264 быстрее.
    expect(chooseCodec({ setting: 'auto', host: { vendor: 'software', hevc: true, av1: false }, client: all, constrained: false, priority: 'balanced', yuv444: false })).toBe('H.264')
    expect(naturalBitrate(1920, 1080, 60)).toBe(20000)
  })
})
