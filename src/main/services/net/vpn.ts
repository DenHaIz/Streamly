import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { NetStatus, VpnKind, VpnLink, VpnStatus } from '@shared/types'

export const isRadminIp = (ip: string): boolean => /^26\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)

/** Широковещательный адрес сети Radmin. */
export const RADMIN_BROADCAST = '26.255.255.255'

const ipToInt = (ip: string): number | undefined => {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
}
const intToIp = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
const maskOf = (prefix: number): number => (prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0)

/** Адрес внутри подсети link (ip/prefix). */
export function inLink(ip: string, link: Pick<VpnLink, 'ip' | 'prefix'>): boolean {
  const a = ipToInt(ip.replace(/^::ffff:/, ''))
  const b = ipToInt(link.ip)
  if (a === undefined || b === undefined) return false
  const m = maskOf(link.prefix)
  return (a & m) === (b & m)
}

/** Широковещательный адрес подсети: для Radmin — вся 26.0.0.0/8 (так его видят остальные участники сети). */
export function broadcastOf(link: Pick<VpnLink, 'kind' | 'ip' | 'prefix'>): string {
  if (link.kind === 'radmin') return RADMIN_BROADCAST
  const b = ipToInt(link.ip) ?? 0
  return intToIp((b | ~maskOf(link.prefix)) >>> 0)
}

/** Через какую из своих сетей идёт адрес (Radmin — вся 26.0.0.0/8, ZeroTier — подсеть адаптера). */
export function linkFor(ip: string, links: VpnLink[]): VpnLink | undefined {
  const v4 = ip.replace(/^::ffff:/, '')
  return links.find((l) => (l.kind === 'radmin' ? isRadminIp(v4) : inLink(v4, l)))
}

const prefixOf = (a: NetworkInterfaceInfo): number => {
  if (a.cidr) {
    const n = Number(a.cidr.split('/')[1])
    if (Number.isInteger(n) && n >= 0 && n <= 32) return n
  }
  const m = ipToInt(a.netmask) ?? 0
  let n = 0
  while (n < 32 && m & (0x80000000 >>> n)) n++
  return n
}

/**
 * Виртуальные сети, через которые играем: Radmin VPN (адаптер «Radmin VPN», адрес 26.x)
 * и ZeroTier (адаптер «ZeroTier One [id сети]», адрес любой — его выдаёт контроллер сети).
 * Подключение в Windows можно переименовать: для ZeroTier имена адаптеров дополнительно
 * подсказывает помощник по описанию драйвера («ZeroTier Virtual Port») — ztNames.
 */
export function detectNetworks(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
  ztNames: ReadonlySet<string> = new Set()
): NetStatus {
  const links: VpnLink[] = []
  const seen: Record<VpnKind, string | undefined> = { radmin: undefined, zerotier: undefined }
  for (const [name, addrs] of Object.entries(ifaces)) {
    const v4 = (addrs ?? []).filter((a) => a.family === 'IPv4' && !a.internal)
    const zt = /zerotier/i.test(name) || ztNames.has(name)
    const radminAddr = v4.find((a) => isRadminIp(a.address))
    if (radminAddr && !zt) {
      // Как в detectRadmin до 0.6.2: один адрес Radmin (первый найденный), даже если 26.x окажется на двух адаптерах.
      if (!links.some((l) => l.kind === 'radmin')) links.push({ kind: 'radmin', ip: radminAddr.address, prefix: 8, adapterName: name })
      continue
    }
    if (/radmin/i.test(name) && !zt) {
      seen.radmin ??= name
      continue
    }
    if (!zt) continue
    seen.zerotier ??= name
    // Адрес 169.254.x — сеть ещё не выдала адрес (или не одобрила этот ПК).
    for (const a of v4) if (!a.address.startsWith('169.254.')) links.push({ kind: 'zerotier', ip: a.address, prefix: prefixOf(a), adapterName: name })
  }
  const status = (kind: VpnKind): VpnStatus => {
    const l = links.find((x) => x.kind === kind)
    if (l) return { installed: true, connected: true, ip: l.ip, adapterName: l.adapterName }
    const name = seen[kind]
    return name ? { installed: true, connected: false, adapterName: name } : { installed: false, connected: false }
  }
  // Radmin первым: его адрес — основной (старые версии Streamly знают только Radmin).
  links.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'radmin' ? -1 : 1))
  return { radmin: status('radmin'), zerotier: status('zerotier'), links }
}

/** Есть ли хоть одна сеть для игры. */
export const netOnline = (n: NetStatus): boolean => n.links.length > 0
