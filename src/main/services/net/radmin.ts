import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { RadminStatus } from '@shared/types'

export const isRadminIp = (ip: string): boolean => /^26\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)

/**
 * Ищет адаптер Radmin VPN. Windows называет подключение «Radmin VPN» (имя можно переименовать),
 * поэтому смотрим и на имя, и на адрес из сети 26.0.0.0/8.
 */
export function detectRadmin(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): RadminStatus {
  let byName: string | undefined
  for (const [name, addrs] of Object.entries(ifaces)) {
    const v4 = (addrs ?? []).find((a) => a.family === 'IPv4' && !a.internal && isRadminIp(a.address))
    if (v4) return { installed: true, connected: true, ip: v4.address, adapterName: name }
    if (/radmin/i.test(name)) byName = name
  }
  return byName ? { installed: true, connected: false, adapterName: byName } : { installed: false, connected: false }
}

/** Широковещательный адрес сети Radmin. */
export const RADMIN_BROADCAST = '26.255.255.255'
