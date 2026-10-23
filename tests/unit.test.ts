import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fromApolloPerm, PERM, PERM_BASE, toApolloPerm } from '@shared/perms'
import { parseClientMessage, parseDiscoveryReply, parseHostMessage, sanitizeNickname } from '@shared/protocol'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { broadcastOf, detectNetworks, isRadminIp, linkFor } from '../src/main/services/net/vpn'
import { isAllowedPeer, neighborsFromArp } from '../src/main/services/net/discovery'
import { makeInviteLink, parseInviteLink } from '@shared/protocol'
import { normalizeSettings } from '../src/main/settings'
import { deepMerge } from '../src/main/store'
import { buildStreamArgs } from '../src/main/services/moonlight/runner'
import { parseListOutput } from '../src/main/services/client/controller'
import ru from '../src/renderer/src/i18n/ru.json'
import en from '../src/renderer/src/i18n/en.json'

describe('perms', () => {
  it('maps input toggles to Apollo bits and back', () => {
    const all = toApolloPerm({ keyboard: true, mouse: true, gamepad: true })
    expect(all & PERM_BASE).toBe(PERM_BASE)
    expect(all & PERM.inputKbd).toBeTruthy()
    expect(all & PERM.inputController).toBeTruthy()
    expect(fromApolloPerm(all)).toEqual({ keyboard: true, mouse: true, gamepad: true })
    const none = toApolloPerm({ keyboard: false, mouse: false, gamepad: false })
    expect(none).toBe(PERM_BASE)
    expect(fromApolloPerm(none)).toEqual({ keyboard: false, mouse: false, gamepad: false })
    expect(fromApolloPerm(toApolloPerm({ keyboard: false, mouse: true, gamepad: false }))).toEqual({ keyboard: false, mouse: true, gamepad: false })
  })
})

describe('protocol', () => {
  it('accepts valid messages and rejects junk', () => {
    const id = '6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b'
    expect(parseClientMessage(JSON.stringify({ t: 'hello', v: 1, deviceId: id, nickname: 'Вася', appVersion: '0.1.0' }))?.t).toBe('hello')
    // deviceId — ключ словаря друзей: «__proto__» и прочее не по формату UUID отклоняется.
    expect(parseClientMessage(JSON.stringify({ t: 'hello', v: 1, deviceId: '__proto__', nickname: 'X', appVersion: '1' }))).toBeNull()
    expect(parseClientMessage(Buffer.from(JSON.stringify({ t: 'joinRequest' })))?.t).toBe('joinRequest')
    expect(parseClientMessage('{"t":"hello","v":1}')).toBeNull()
    expect(parseClientMessage('{"t":"evil"}')).toBeNull()
    expect(parseClientMessage('not json')).toBeNull()
    expect(parseClientMessage('[1,2]')).toBeNull()
    expect(parseClientMessage('x'.repeat(10000))).toBeNull()
    expect(parseHostMessage('{"t":"pairBegin","pin":"0042"}')).toEqual({ t: 'pairBegin', pin: '0042' })
    expect(parseHostMessage('{"t":"pairBegin","pin":"42"}')).toBeNull()
    expect(parseHostMessage('{"t":"hello"}')).toBeNull()
    const policy = { hostAudio: true, maxBitrateKbps: 20000, hostWidth: 1920, hostHeight: 1080, hostFps: 60 }
    const perms = { keyboard: true, mouse: true, gamepad: false }
    expect(parseHostMessage(JSON.stringify({ t: 'joinAccepted', perms, needsPair: false, policy }))?.t).toBe('joinAccepted')
    // Хост не может подсунуть Moonlight мусор вместо чисел
    expect(parseHostMessage(JSON.stringify({ t: 'joinAccepted', perms, needsPair: false, policy: { ...policy, hostWidth: '1920x1080 --evil' } }))).toBeNull()
    expect(parseHostMessage(JSON.stringify({ t: 'joinAccepted', perms: { keyboard: 'yes' }, needsPair: false, policy }))).toBeNull()
    expect(parseHostMessage(JSON.stringify({ t: 'joinDenied', reason: 'whatever' }))).toBeNull()
    expect(parseHostMessage(JSON.stringify({ t: 'hostInfo', v: 1, hostName: 'x'.repeat(200), slotsUsed: 0, maxSlots: 4 }))).toBeNull()
  })

  it('parses discovery replies', () => {
    expect(parseDiscoveryReply(JSON.stringify({ magic: 'STREAMLY_HOST_V1', hostName: 'Дима', slotsUsed: 1, maxSlots: 4, port: 47900 }))?.hostName).toBe('Дима')
    expect(parseDiscoveryReply('{"magic":"nope"}')).toBeNull()
  })

  it('sanitizes nicknames', () => {
    expect(sanitizeNickname('  <b>Вася</b>  ')).toBe('bВася/b')
    expect(sanitizeNickname('')).toBe('Player')
    expect(sanitizeNickname('a'.repeat(50))).toHaveLength(24)
  })
})

describe('radmin and zerotier', () => {
  const base = { netmask: '255.0.0.0', mac: '00:00:00:00:00:00', internal: false, cidr: null }
  const off = { installed: false, connected: false }
  const zt = { ...base, netmask: '255.255.255.0', address: '10.147.17.4', family: 'IPv4' as const }

  it('detects Radmin adapter by 26.x address or name', () => {
    expect(isRadminIp('26.1.2.3')).toBe(true)
    expect(isRadminIp('192.168.0.26')).toBe(false)
    const n = detectNetworks({
      Ethernet: [{ ...base, address: '192.168.1.5', family: 'IPv4' }],
      'Radmin VPN': [{ ...base, address: '26.44.1.9', family: 'IPv4' }]
    })
    expect(n.radmin).toEqual({ installed: true, connected: true, ip: '26.44.1.9', adapterName: 'Radmin VPN' })
    expect(n.zerotier).toEqual(off)
    expect(n.links).toEqual([{ kind: 'radmin', ip: '26.44.1.9', prefix: 8, adapterName: 'Radmin VPN' }])
    expect(detectNetworks({ 'Radmin VPN': [{ ...base, address: 'fe80::1', family: 'IPv6', scopeid: 1 }] }).radmin).toEqual({
      installed: true,
      connected: false,
      adapterName: 'Radmin VPN'
    })
    const none = detectNetworks({ Ethernet: [{ ...base, address: '10.0.0.2', family: 'IPv4' }] })
    expect(none).toEqual({ radmin: off, zerotier: off, links: [] })
  })

  it('detects ZeroTier by adapter name (or the name the helper found by driver), Radmin stays first', () => {
    const n = detectNetworks({
      'ZeroTier One [8056c2e21c000001]': [zt],
      'Radmin VPN': [{ ...base, address: '26.44.1.9', family: 'IPv4' }]
    })
    expect(n.links.map((l) => l.kind)).toEqual(['radmin', 'zerotier'])
    expect(n.zerotier).toEqual({ installed: true, connected: true, ip: '10.147.17.4', adapterName: 'ZeroTier One [8056c2e21c000001]' })
    expect(n.links[1].prefix).toBe(24)
    // Переименованное подключение — по подсказке помощника.
    expect(detectNetworks({ 'Игры': [zt] }).links).toEqual([])
    expect(detectNetworks({ 'Игры': [zt] }, new Set(['Игры'])).zerotier.ip).toBe('10.147.17.4')
    // Сеть ещё не выдала адрес (169.254.x): установлен, но не подключён.
    expect(detectNetworks({ 'ZeroTier One [x]': [{ ...zt, address: '169.254.3.4', netmask: '255.255.0.0' }] }).zerotier).toEqual({
      installed: true,
      connected: false,
      adapterName: 'ZeroTier One [x]'
    })
  })

  it('maps addresses to networks, broadcast and ARP neighbours', () => {
    const links = detectNetworks({ 'ZeroTier One [a]': [zt], 'Radmin VPN': [{ ...base, address: '26.44.1.9', family: 'IPv4' }] }).links
    expect(linkFor('26.1.1.1', links)?.kind).toBe('radmin')
    expect(linkFor('::ffff:10.147.17.200', links)?.kind).toBe('zerotier')
    expect(linkFor('10.147.18.2', links)).toBeUndefined()
    expect(linkFor('192.168.1.10', links)).toBeUndefined()
    expect(broadcastOf(links[0])).toBe('26.255.255.255')
    expect(broadcastOf(links[1])).toBe('10.147.17.255')
    const arp = 'Interface: 10.147.17.4 --- 0x1a\n  10.147.17.9   aa-bb  dynamic\n  10.147.17.255  ff-ff  static\n  224.0.0.22  01-00  static\n  192.168.1.1 aa  dynamic'
    expect(neighborsFromArp(arp, links[1])).toEqual(['10.147.17.9'])
  })

  it('allows Radmin, own ZeroTier subnets and loopback peers only', () => {
    expect(isAllowedPeer('::ffff:26.5.5.5')).toBe(true)
    expect(isAllowedPeer('127.0.0.1')).toBe(true)
    expect(isAllowedPeer('192.168.1.10')).toBe(false)
    expect(isAllowedPeer('192.168.1.10', ['192.168.1.10'])).toBe(true)
    const links = detectNetworks({ 'ZeroTier One [a]': [zt] }).links
    expect(isAllowedPeer('10.147.17.9', [], links)).toBe(true)
    expect(isAllowedPeer('10.147.18.9', [], links)).toBe(false)
    // Без своего ZeroTier частные адреса не пускаем.
    expect(isAllowedPeer('10.147.17.9')).toBe(false)
  })

  it('invite carries the ZeroTier address next to Radmin; old links still parse', () => {
    const link = makeInviteLink('26.1.2.3', 'Дима', 'abcDEF123_-xyz', ['26.1.2.3', '10.147.17.4'])
    expect(parseInviteLink(link)).toEqual({ address: '26.1.2.3', name: 'Дима', code: 'abcDEF123_-xyz', alt: ['10.147.17.4'] })
    expect(makeInviteLink('26.1.2.3', 'Дима', 'abcDEF123_-xyz', ['26.1.2.3'])).not.toContain('alt=')
    expect(parseInviteLink('streamly://join/26.1.2.3?name=x&alt=999.1.1.1,10.0.0.1,26.1.2.3')?.alt).toEqual(['10.0.0.1'])
  })
})

describe('settings', () => {
  const base = (): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), language: 'ru', nickname: 'Test', deviceId: '00000000-0000-4000-8000-000000000000' })

  it('merges partial patches without unknown keys', () => {
    const merged = deepMerge(base(), { stream: { fps: 120 }, evil: 1 } as never)
    expect(merged.stream.fps).toBe(120)
    expect(merged.stream.codec).toBe('auto')
    expect('evil' in merged).toBe(false)
  })

  it('clamps invalid values', () => {
    const s = base()
    const bad = { ...s, theme: 'neon', host: { ...s.host, maxPlayers: 99 }, stream: { ...s.stream, fps: 61, packetSize: 50, bitrateKbps: -5 } } as unknown as Settings
    const n = normalizeSettings(bad)
    expect(n.theme).toBe('system')
    expect(n.host.maxPlayers).toBe(4)
    expect(n.stream.fps).toBe(60)
    expect(n.stream.packetSize).toBe(1024)
    expect(n.stream.bitrateKbps).toBe(500)
  })
})

describe('moonlight args', () => {
  it('builds stream command line', () => {
    const args = buildStreamArgs('26.1.1.1', { ...DEFAULT_SETTINGS.stream, bitrateKbps: 20000, codec: 'HEVC', packetSize: 1200 }, { width: 2560, height: 1440 })
    expect(args.slice(0, 3)).toEqual(['stream', '26.1.1.1', 'Desktop'])
    expect(args).toContain('--resolution')
    expect(args[args.indexOf('--resolution') + 1]).toBe('2560x1440')
    expect(args[args.indexOf('--bitrate') + 1]).toBe('20000')
    expect(args[args.indexOf('--video-codec') + 1]).toBe('HEVC')
    expect(args[args.indexOf('--packet-size') + 1]).toBe('1200')
    expect(args).toContain('--no-quit-after')
    const fixed = buildStreamArgs('26.1.1.1', { ...DEFAULT_SETTINGS.stream, resolution: '1080' })
    expect(fixed).toContain('--1080')
    expect(fixed).not.toContain('--bitrate')
  })
})

describe('i18n', () => {
  const keys = (o: object, prefix = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v as object, `${prefix}${k}.`) : [`${prefix}${k}`]))

  it('ru and en have the same keys', () => {
    expect(keys(ru).sort()).toEqual(keys(en).sort())
  })

  it('every error code has a title and a hint in both languages', () => {
    // Коды берём прямо из объявления ErrorCode, чтобы новый код без перевода ронял тест.
    const src = readFileSync(join(__dirname, '../src/shared/types.ts'), 'utf8')
    const union = /export type ErrorCode =([\s\S]*?)\n\n/.exec(src)![1]
    const codes = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(codes.length).toBeGreaterThan(15)
    for (const lang of [ru, en] as unknown as Record<string, Record<string, string>>[]) {
      for (const c of codes) {
        expect(lang.errors[c], `errors.${c}`).toBeTruthy()
        expect(lang.errorHints[c], `errorHints.${c}`).toBeTruthy()
      }
    }
  })
})

describe('moonlight list output', () => {
  it('decides pairing from the output, not only the exit code', () => {
    expect(parseListOutput(0, ['Desktop', 'Steam Big Picture'])).toBe(true)
    expect(parseListOutput(0, ['Permission Denied'])).toBe(true)
    expect(parseListOutput(0, ['Computer 26.1.1.1 has not been paired. Please open Moonlight to pair before streaming.'])).toBe(false)
    expect(parseListOutput(0, ['Failed to connect to 26.1.1.1'])).toBe(false)
    expect(parseListOutput(-1, [])).toBe(false)
  })
})
