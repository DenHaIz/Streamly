import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type StreamPolicy } from '@shared/types'
import { buildStreamArgs, pickBitrate, pickResolution } from '../src/main/services/moonlight/runner'
import { diagnoseHost, type PortState } from '../src/main/services/net/diagnose'
import type { NetStatus } from '@shared/types'

const policy: StreamPolicy = { hostAudio: true, maxBitrateKbps: 15000, hostWidth: 1920, hostHeight: 1080, hostFps: 60 }
const arg = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

describe('stream policy from the host', () => {
  it('never streams above the host monitor', () => {
    expect(pickResolution({ width: 2560, height: 1440 }, policy)).toEqual([1920, 1080])
    expect(pickResolution({ width: 1280, height: 720 }, policy)).toEqual([1280, 720])
    expect(pickResolution(undefined, policy)).toEqual([1920, 1080])
    expect(pickResolution({ width: 2560, height: 1440 })).toEqual([2560, 1440])
  })

  it('keeps bitrate under the host cap', () => {
    const s = { ...DEFAULT_SETTINGS.stream }
    expect(pickBitrate({ ...s, bitrateKbps: 40000 }, [1920, 1080], 60, policy)).toBe(15000)
    expect(pickBitrate({ ...s, bitrateKbps: 8000 }, [1920, 1080], 60, policy)).toBe(8000)
    // «Авто» у клиента: оценка как у Moonlight, но не выше потолка
    expect(pickBitrate(s, [1280, 720], 30, policy)).toBeLessThan(15000)
    expect(pickBitrate(s, [3840, 2160], 60, policy)).toBe(15000)
    expect(pickBitrate(s, [1920, 1080], 60)).toBeUndefined()
  })

  it('keeps game audio on the host and caps fps by the host monitor', () => {
    const s = { ...DEFAULT_SETTINGS.stream, fps: 144 }
    const args = buildStreamArgs('26.1.1.1', s, { width: 2560, height: 1440 }, policy)
    expect(args).toContain('--audio-on-host')
    expect(arg(args, '--resolution')).toBe('1920x1080')
    expect(arg(args, '--fps')).toBe('60')
    expect(arg(args, '--bitrate')).toBe('15000')
    expect(buildStreamArgs('26.1.1.1', s, undefined, { ...policy, hostAudio: false })).toContain('--no-audio-on-host')
  })
})

describe('connection test', () => {
  const off = { installed: false, connected: false }
  const net: NetStatus = {
    radmin: { installed: true, connected: true, ip: '26.0.0.2' },
    zerotier: off,
    links: [{ kind: 'radmin', ip: '26.0.0.2', prefix: 8, adapterName: 'Radmin VPN' }]
  }
  const run = (ports: Record<number, PortState>, rtt?: number, extra: Partial<Parameters<typeof diagnoseHost>[1]> = {}, address = '26.0.0.5') =>
    diagnoseHost(address, {
      net,
      moonlightAvailable: true,
      ping: async () => rtt,
      probe: async (_h, p) => ports[p] ?? 'timeout',
      ...extra
    })
  const all = (s: PortState): Record<number, PortState> => ({ 47900: s, 47984: s, 47989: s, 48010: s })

  it('everything open', async () => {
    const r = await run(all('open'), 20)
    expect(r.summary).toBe('allGood')
    expect(r.items.every((i) => i.status === 'ok')).toBe(true)
  })

  it('host PC unreachable over Radmin', async () => {
    const r = await run(all('timeout'), undefined)
    expect(r.summary).toBe('noRoute')
    expect(r.items.find((i) => i.id === 'streamly')?.hint).toBe('noRoute')
  })

  it('host is up but not hosting', async () => {
    const r = await run({ 47900: 'refused', 47984: 'refused', 47989: 'refused', 48010: 'refused' }, 15)
    expect(r.summary).toBe('notHosting')
    expect(r.items.find((i) => i.id === 'apollo')?.hint).toBe('apolloNotRunning')
  })

  it('Apollo blocked by the host firewall while ping is blocked too', async () => {
    const r = await run({ 47900: 'open' }, undefined)
    expect(r.summary).toBe('apolloBlocked')
    expect(r.items.find((i) => i.id === 'ping')?.status).toBe('warn')
    expect(r.items.find((i) => i.id === 'apollo')?.hint).toBe('apolloFirewall')
  })

  it('slow relay connection', async () => {
    const r = await run(all('open'), 140)
    expect(r.summary).toBe('slow')
    expect(r.items.find((i) => i.id === 'ping')?.hint).toBe('highLatency')
  })

  it('no Radmin on this PC', async () => {
    const r = await run(all('open'), 10, { net: { radmin: off, zerotier: off, links: [] } })
    expect(r.summary).toBe('noRadmin')
  })

  it('host over ZeroTier while this PC has no Radmin', async () => {
    const zt: NetStatus = {
      radmin: off,
      zerotier: { installed: true, connected: true, ip: '10.147.17.4' },
      links: [{ kind: 'zerotier', ip: '10.147.17.4', prefix: 24, adapterName: 'ZeroTier One [abc]' }]
    }
    const r = await run(all('open'), 20, { net: zt }, '10.147.17.9')
    expect(r.summary).toBe('allGood')
    expect(r.items.find((i) => i.id === 'zerotier')?.status).toBe('ok')
    expect(r.items.some((i) => i.id === 'radmin')).toBe(false)
    // Адрес Radmin, а Radmin нет — только ZeroTier: подсказка про обе сети.
    const r2 = await run(all('timeout'), undefined, { net: zt })
    expect(r2.summary).toBe('noRadmin')
    expect(r2.items.find((i) => i.id === 'radmin')?.hint).toBe('radminOrZt')
  })
})
