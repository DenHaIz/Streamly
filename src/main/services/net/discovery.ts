import { createSocket, type Socket } from 'node:dgram'
import {
  DISCOVERY_MAGIC,
  DISCOVERY_PORT,
  DISCOVERY_REPLY,
  parseDiscoveryReply,
  SIGNALING_PORT,
  type DiscoveryReply
} from '@shared/protocol'
import { run } from '../../elevate'
import { isRadminIp, RADMIN_BROADCAST } from './radmin'

/** Можно ли принимать запросы с этого адреса: только сеть Radmin и локальная машина. */
export function isAllowedPeer(ip: string, extra: string[] = []): boolean {
  const v4 = ip.replace(/^::ffff:/, '')
  return isRadminIp(v4) || v4 === '127.0.0.1' || extra.includes(v4)
}

/** Хост: отвечает на UDP-запросы поиска. */
export class DiscoveryResponder {
  private socket: Socket | null = null

  constructor(
    private readonly info: () => Omit<DiscoveryReply, 'magic' | 'port'>,
    private readonly port = DISCOVERY_PORT,
    private readonly extraAllowed: string[] = []
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = createSocket({ type: 'udp4', reuseAddr: true })
      s.on('message', (msg, rinfo) => {
        if (msg.length > 64 || msg.toString() !== DISCOVERY_MAGIC) return
        if (!isAllowedPeer(rinfo.address, this.extraAllowed)) return
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

/** Соседи из ARP-таблицы в сети Radmin: с кем этот ПК недавно общался через VPN. */
export async function radminNeighbors(localIp: string): Promise<string[]> {
  const res = await run('arp', ['-a', '-N', localIp], 5000)
  const found = new Set<string>()
  for (const m of res.stdout.matchAll(/\b(26\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g)) {
    const ip = m[1]
    if (ip !== localIp && !ip.endsWith('.255')) found.add(ip)
  }
  return [...found]
}

export interface ProbeResult extends DiscoveryReply {
  address: string
}

/**
 * Клиент: ищет хосты. Шлёт broadcast на всю сеть Radmin и unicast каждому известному адресу
 * (соседи из ARP, недавние хосты). Ответы собирает в течение windowMs.
 */
export function probeHosts(opts: {
  localIp?: string
  targets: string[]
  broadcast: boolean
  windowMs?: number
  port?: number
  onFound?: (r: ProbeResult) => void
}): Promise<ProbeResult[]> {
  const port = opts.port ?? DISCOVERY_PORT
  return new Promise((resolve) => {
    const results = new Map<string, ProbeResult>()
    const s = createSocket('udp4')
    let closed = false
    const timers: NodeJS.Timeout[] = []
    const finish = (): void => {
      if (closed) return
      closed = true
      timers.forEach(clearTimeout)
      try {
        s.close()
      } catch {
        /* уже закрыт */
      }
      resolve([...results.values()])
    }
    s.on('error', finish)
    s.on('message', (msg, rinfo) => {
      const r = parseDiscoveryReply(msg)
      if (!r || results.has(rinfo.address)) return
      const res = { ...r, address: rinfo.address }
      results.set(rinfo.address, res)
      opts.onFound?.(res)
    })
    s.bind(0, opts.localIp, () => {
      const payload = Buffer.from(DISCOVERY_MAGIC)
      const send = (ip: string): void => {
        if (closed) return
        try {
          s.send(payload, port, ip, () => undefined)
        } catch {
          /* сокет закрылся между проверкой и отправкой */
        }
      }
      if (opts.broadcast) {
        s.setBroadcast(true)
        send(RADMIN_BROADCAST)
        send('255.255.255.255')
      }
      for (const ip of new Set(opts.targets)) send(ip)
      // Повтор на случай потери первого пакета.
      timers.push(
        setTimeout(() => {
          if (opts.broadcast) send(RADMIN_BROADCAST)
          for (const ip of new Set(opts.targets)) send(ip)
        }, 600),
        setTimeout(finish, opts.windowMs ?? 2500)
      )
    })
  })
}
