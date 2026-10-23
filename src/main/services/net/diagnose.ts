import { Socket } from 'node:net'
import { SIGNALING_PORT } from '@shared/protocol'
import type { CheckItem, CheckReport, NetStatus } from '@shared/types'
import { run } from '../../elevate'
import { isRadminIp, linkFor } from './vpn'

export type PortState = 'open' | 'refused' | 'timeout'

/** Пробует открыть TCP-соединение: открыт порт, отклонён (ПК отвечает, но никто не слушает) или нет ответа. */
export function probePort(host: string, port: number, timeoutMs = 2500): Promise<PortState> {
  return new Promise((resolve) => {
    const s = new Socket()
    const done = (r: PortState): void => {
      s.destroy()
      resolve(r)
    }
    s.setTimeout(timeoutMs, () => done('timeout'))
    s.once('connect', () => done('open'))
    s.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'ECONNREFUSED' ? 'refused' : 'timeout'))
    s.connect(port, host)
  })
}

/** Средняя задержка по ping (мс) или undefined, если ответа нет (ICMP часто закрыт файрволом Windows). */
export async function pingHost(host: string): Promise<number | undefined> {
  const res = await run('ping', ['-n', '3', '-w', '1500', host], 10_000)
  // «время=12мс», «time=12ms», «time<1ms» — вывод зависит от языка Windows.
  const times = [...res.stdout.matchAll(/[=<]\s*(\d+)\s*(?:ms|мс)/gi)].map((m) => Number(m[1]))
  if (!times.length) return undefined
  return Math.round(times.reduce((a, b) => a + b, 0) / times.length)
}

/** Задержка, выше которой Radmin, скорее всего, гонит трафик через ретранслятор. */
export const RELAY_RTT_MS = 80

const APOLLO_PORTS = [47984, 47989, 48010]

export interface DiagnoseDeps {
  net: NetStatus
  moonlightAvailable: boolean
  probe?: typeof probePort
  ping?: typeof pingHost
}

/**
 * Проверка связи клиента с хостом: что именно не так и что исправить.
 * Ключи пунктов и подсказок переводятся в интерфейсе (diag.checks.*, diag.hints.*).
 */
export async function diagnoseHost(address: string, d: DiagnoseDeps): Promise<CheckReport> {
  const probe = d.probe ?? probePort
  const ping = d.ping ?? pingHost
  const items: CheckItem[] = []
  const add = (id: string, status: CheckItem['status'], hint?: string, value?: string): void => {
    items.push({ id, status, hint: status === 'ok' ? undefined : hint, value })
  }

  // Через какую сеть идём к хосту: адрес Radmin (26.x) или подсеть своего ZeroTier.
  const link = linkFor(address, d.net.links)
  const viaZt = link?.kind === 'zerotier'
  const online = viaZt || d.net.radmin.connected || (!isRadminIp(address) && d.net.links.length > 0)
  if (viaZt) add('zerotier', 'ok', 'zerotier', link.ip)
  else add('radmin', d.net.radmin.connected ? 'ok' : 'fail', d.net.links.length ? 'radminOrZt' : 'radmin', d.net.radmin.ip ?? d.net.links[0]?.ip)
  add('radminAddress', link || isRadminIp(address) ? 'ok' : 'warn', d.net.zerotier.connected ? 'notInZtNetwork' : 'notRadminAddress', address)
  add('moonlight', d.moonlightAvailable ? 'ok' : 'fail', 'moonlight')

  const [rtt, streamly, ...apollo] = await Promise.all([
    ping(address),
    probe(address, SIGNALING_PORT),
    ...APOLLO_PORTS.map((p) => probe(address, p))
  ])
  if (rtt === undefined) add('ping', 'warn', 'pingBlocked')
  else add('ping', rtt > RELAY_RTT_MS ? 'warn' : 'ok', 'highLatency', `${rtt} ms`)

  const reachable = rtt !== undefined || streamly !== 'timeout' || apollo.some((s) => s !== 'timeout')
  add(
    'streamly',
    streamly === 'open' ? 'ok' : 'fail',
    streamly === 'refused' ? 'notHosting' : reachable ? 'streamlyFirewall' : 'noRoute',
    String(SIGNALING_PORT)
  )
  const closed = APOLLO_PORTS.filter((_, i) => apollo[i] !== 'open')
  add(
    'apollo',
    closed.length === 0 ? 'ok' : 'fail',
    apollo.every((s) => s === 'refused') ? 'apolloNotRunning' : reachable ? 'apolloFirewall' : 'noRoute',
    closed.length ? closed.join(', ') : APOLLO_PORTS.join(', ')
  )

  let summary = 'allGood'
  if (!online) summary = 'noRadmin'
  else if (!reachable) summary = 'noRoute'
  else if (streamly === 'refused') summary = 'notHosting'
  else if (streamly !== 'open') summary = 'streamlyBlocked'
  else if (closed.length) summary = 'apolloBlocked'
  else if (!d.moonlightAvailable) summary = 'moonlightMissing'
  else if (rtt !== undefined && rtt > RELAY_RTT_MS) summary = 'slow'
  return { target: address, items, summary }
}
