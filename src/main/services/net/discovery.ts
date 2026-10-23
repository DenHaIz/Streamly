import { createSocket, type RemoteInfo, type Socket } from 'node:dgram'
import {
  DISCOVERY_MAGIC,
  DISCOVERY_PORT,
  DISCOVERY_REPLY,
  parseDiscoveryReply,
  SIGNALING_PORT,
  type DiscoveryReply
} from '@shared/protocol'
import type { VpnLink } from '@shared/types'
import { run } from '../../elevate'
import { isProbePacket } from './probe'
import { broadcastOf, inLink, isRadminIp, linkFor } from './vpn'

/**
 * Можно ли принимать запросы с этого адреса: сеть Radmin, подсети своих адаптеров ZeroTier и локальная машина.
 * Обычная локальная сеть (Wi-Fi, провайдер) — нет.
 */
export function isAllowedPeer(ip: string, extra: string[] = [], links: VpnLink[] = []): boolean {
  const v4 = ip.replace(/^::ffff:/, '')
  return isRadminIp(v4) || v4 === '127.0.0.1' || extra.includes(v4) || links.some((l) => l.kind === 'zerotier' && inLink(v4, l))
}

/** Хост: отвечает на UDP-запросы поиска. */
export class DiscoveryResponder {
  private socket: Socket | null = null

  constructor(
    private readonly info: () => Omit<DiscoveryReply, 'magic' | 'port'>,
    private readonly port = DISCOVERY_PORT,
    private readonly extraAllowed: () => string[] = () => [],
    /** Пакеты замера канала (тот же порт: правило файрвола уже есть). */
    private readonly onProbe?: (msg: Buffer, rinfo: RemoteInfo) => void,
    /** Свои сети: из подсетей ZeroTier тоже отвечаем (сеть может появиться, пока хост работает). */
    private readonly links: () => VpnLink[] = () => []
  ) {}

  /** Порт, на котором слушает ответчик (0 в настройке — выбранный системой). */
  get boundPort(): number | undefined {
    try {
      return this.socket?.address().port
    } catch {
      return undefined
    }
  }

  /** Отправить пакет с порта поиска (замер канала). */
  send(buf: Buffer, port: number, address: string): void {
    try {
      this.socket?.send(buf, port, address)
    } catch {
      /* сокет закрыт */
    }
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = createSocket({ type: 'udp4', reuseAddr: true })
      s.on('message', (msg, rinfo) => {
        if (!isAllowedPeer(rinfo.address, this.extraAllowed(), this.links())) return
        if (this.onProbe && isProbePacket(msg)) return this.onProbe(msg, rinfo)
        if (msg.length > 64 || msg.toString() !== DISCOVERY_MAGIC) return
        const reply: DiscoveryReply = { magic: DISCOVERY_REPLY, port: SIGNALING_PORT, ...this.info() }
        s.send(JSON.stringify(reply), rinfo.port, rinfo.address)
      })
      s.once('error', reject)
      s.bind(this.port, () => {
        s.off('error', reject)
        s.on('error', () => undefined)
        this.socket = s
        resolve()
      })
    })
  }

  stop(): void {
    this.socket?.close()
    this.socket = null
  }
}

/** Соседи из ARP-таблицы в сети (Radmin или ZeroTier): с кем этот ПК недавно общался через неё. */
export async function vpnNeighbors(link: VpnLink): Promise<string[]> {
  const res = await run('arp', ['-a', '-N', link.ip], 5000)
  return neighborsFromArp(res.stdout, link)
}

/** Адреса из вывода `arp -a`, лежащие в сети link (кроме своего и широковещательных). */
export function neighborsFromArp(stdout: string, link: VpnLink): string[] {
  const found = new Set<string>()
  const bcast = broadcastOf(link)
  for (const m of stdout.matchAll(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g)) {
    const ip = m[1]
    if (ip === link.ip || ip === bcast || ip.endsWith('.255') || !linkFor(ip, [link])) continue
    found.add(ip)
  }
  return [...found]
}

export interface ProbeResult extends DiscoveryReply {
  address: string
}

/**
 * Клиент: ищет хосты. В каждой своей сети (Radmin, ZeroTier) шлёт broadcast с её адреса и unicast
 * каждому известному адресу (соседи из ARP, недавние хосты) — с адреса той сети, в которой он лежит:
 * с адреса другой сети ответ не дошёл бы. Адреса вне своих сетей (отладка по LAN) — с сокета без привязки.
 * Ответы собирает в течение windowMs.
 */
export function probeHosts(opts: {
  links: VpnLink[]
  targets: string[]
  windowMs?: number
  port?: number
  onFound?: (r: ProbeResult) => void
}): Promise<ProbeResult[]> {
  const port = opts.port ?? DISCOVERY_PORT
  const payload = Buffer.from(DISCOVERY_MAGIC)
  const results = new Map<string, ProbeResult>()
  const groups: { link: VpnLink | null; targets: string[] }[] = opts.links.map((link) => ({ link, targets: [] }))
  const loose: string[] = []
  for (const ip of new Set(opts.targets)) {
    const l = linkFor(ip, opts.links)
    const g = l && groups.find((x) => x.link === l)
    if (g) g.targets.push(ip)
    else loose.push(ip)
  }
  if (loose.length || !groups.length) groups.push({ link: null, targets: loose })

  return new Promise((resolve) => {
    let closed = false
    const sockets: Socket[] = []
    const timers: NodeJS.Timeout[] = []
    const senders: ((first: boolean) => void)[] = []
    const finish = (): void => {
      if (closed) return
      closed = true
      timers.forEach(clearTimeout)
      for (const s of sockets) {
        try {
          s.close()
        } catch {
          /* уже закрыт */
        }
      }
      resolve([...results.values()])
    }
    let pending = groups.length
    const ready = (): void => {
      if (--pending > 0 || closed) return
      senders.forEach((f) => f(true))
      // Повтор на случай потери первого пакета (как до 0.6.2 — без общего broadcast 255.255.255.255).
      timers.push(
        setTimeout(() => senders.forEach((f) => f(false)), 600),
        setTimeout(finish, opts.windowMs ?? 2500)
      )
    }
    for (const g of groups) {
      const s = createSocket('udp4')
      sockets.push(s)
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        ready()
      }
      // Ошибка одного сокета (адрес сети только что пропал) не мешает искать в остальных.
      s.on('error', settle)
      s.on('message', (msg, rinfo) => {
        const r = parseDiscoveryReply(msg)
        if (!r || results.has(rinfo.address)) return
        const res = { ...r, address: rinfo.address }
        results.set(rinfo.address, res)
        opts.onFound?.(res)
      })
      s.bind(0, g.link?.ip, () => {
        const send = (ip: string): void => {
          if (closed) return
          try {
            s.send(payload, port, ip, () => undefined)
          } catch {
            /* сокет закрылся между проверкой и отправкой */
          }
        }
        let broadcast = false
        if (g.link) {
          try {
            s.setBroadcast(true)
            broadcast = true
          } catch {
            /* остаётся unicast */
          }
        }
        const link = g.link
        senders.push((first) => {
          if (link && broadcast) {
            send(broadcastOf(link))
            if (first) send('255.255.255.255')
          }
          g.targets.forEach(send)
        })
        settle()
      })
    }
  })
}
