// Меню Alt+F2, звук хоста, выбор монитора, устойчивость связи: чистые функции.
import { describe, expect, it } from 'vitest'
import { effectivePerms, NO_INPUT, PERM, toApolloPerm } from '@shared/perms'
import { parseClientMessage, parseHostMessage } from '@shared/protocol'
import { SETTINGS_SCHEMA, type Settings } from '@shared/types'
import { parseDisplayDevices } from '../src/main/services/apollo/displays'
import { jitter, parseConnectionStatus } from '../src/main/services/client/controller'
import { buildStreamArgs } from '../src/main/services/moonlight/runner'
import { normalizeSettings } from '../src/main/settings'

const LOG = `[2026-10-20 21:00:01.123]: Info: Apollo version: v0.4.6
[2026-10-20 21:00:01.456]: Info: Currently available display devices:
[
  {
    "device_id": "{11111111-2222-3333-4444-555555555555}",
    "display_name": "\\\\\\\\.\\\\DISPLAY1",
    "edid": null,
    "friendly_name": "ROG PG279Q",
    "info": {
      "hdr_state": null,
      "origin_point": { "x": 0, "y": 0 },
      "primary": true,
      "refresh_rate": { "type": "rational", "value": { "denominator": 1000, "numerator": 164956 } },
      "resolution": { "height": 1440, "width": 2560 },
      "resolution_scale": { "type": "double", "value": 1.0 }
    }
  },
  {
    "device_id": "{66666666-7777-8888-9999-000000000000}",
    "display_name": "\\\\\\\\.\\\\DISPLAY2",
    "edid": null,
    "friendly_name": "DELL [U2419H]",
    "info": {
      "hdr_state": null,
      "origin_point": { "x": 2560, "y": 0 },
      "primary": false,
      "refresh_rate": { "type": "double", "value": 59.95 },
      "resolution": { "height": 1080, "width": 1920 },
      "resolution_scale": { "type": "double", "value": 1.0 }
    }
  },
  { "device_id": "{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}", "display_name": "", "edid": null, "friendly_name": "TV (off)", "info": null },
  { "device_id": "{bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee}", "display_name": "\\\\\\\\.\\\\DISPLAY9", "edid": null, "friendly_name": "SudoMaker Virtual Display", "info": { "primary": false, "resolution": { "height": 1080, "width": 1920 }, "refresh_rate": { "type": "double", "value": 60 } } }
]
[2026-10-20 21:00:01.789]: Info: Configuration UI available at [https://localhost:47990]`

describe('host monitors from the Apollo log', () => {
  it('lists active physical monitors with their Apollo ids', () => {
    const list = parseDisplayDevices(LOG)
    expect(list).toEqual([
      { id: '{11111111-2222-3333-4444-555555555555}', name: 'ROG PG279Q', displayName: '\\\\.\\DISPLAY1', primary: true, width: 2560, height: 1440, fps: 165 },
      { id: '{66666666-7777-8888-9999-000000000000}', name: 'DELL [U2419H]', displayName: '\\\\.\\DISPLAY2', primary: false, width: 1920, height: 1080, fps: 60 }
    ])
  })

  it('takes the latest list and survives a broken log', () => {
    const older = LOG.replace('ROG PG279Q', 'Old name')
    expect(parseDisplayDevices(older + '\n' + LOG)[0].name).toBe('ROG PG279Q')
    expect(parseDisplayDevices('nothing here')).toEqual([])
    expect(parseDisplayDevices('Currently available display devices:\n[ { "device_id": ')).toEqual([])
  })
})

describe('connection quality', () => {
  it('reads Moonlight connection status lines', () => {
    expect(parseConnectionStatus('00:01:02 - SDL Info (0): Connection status update: 1')).toBe(true)
    expect(parseConnectionStatus('00:01:09 - SDL Info (0): Connection status update: 0')).toBe(false)
    expect(parseConnectionStatus('Received first video packet')).toBeUndefined()
  })

  it('measures jitter from latency samples', () => {
    expect(jitter([20, 21])).toBeUndefined()
    expect(jitter([20, 20, 20, 20])).toBe(0)
    expect(jitter([20, 60, 20, 60])).toBe(40)
  })
})

describe('protocol: in-game menu and host audio', () => {
  it('validates player preferences and network reports', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'prefs', muteChat: true, selfOff: { keyboard: false, mouse: false, gamepad: true } }))).toBeTruthy()
    expect(parseClientMessage(JSON.stringify({ t: 'prefs', muteChat: 'yes', selfOff: NO_INPUT }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ t: 'prefs', muteChat: true, selfOff: { keyboard: 1 } }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ t: 'netStatus', poor: true }))).toBeTruthy()
    expect(parseClientMessage(JSON.stringify({ t: 'netStatus' }))).toBeNull()
    expect(parseHostMessage(JSON.stringify({ t: 'audioState', chatControl: true, chatExcluded: false }))).toBeTruthy()
    expect(parseHostMessage(JSON.stringify({ t: 'audioState', chatControl: true }))).toBeNull()
  })

  it('a player can only take away their own input, never add', () => {
    const granted = { keyboard: true, mouse: false, gamepad: true }
    expect(effectivePerms(granted, { keyboard: false, mouse: false, gamepad: true })).toEqual({ keyboard: true, mouse: false, gamepad: false })
    expect(effectivePerms({ ...NO_INPUT }, { keyboard: false, mouse: false, gamepad: false })).toEqual(NO_INPUT)
    expect(toApolloPerm(effectivePerms(granted, { ...NO_INPUT, gamepad: true })) & PERM.inputController).toBe(0)
  })
})

describe('settings migration', () => {
  const base = (patch: Record<string, unknown>): Settings => ({ nickname: 'A', deviceId: '00000000-0000-4000-8000-000000000000', ...patch }) as unknown as Settings

  it('moves 0.1 users to borderless full screen and keeps the virtual monitor choice', () => {
    const s = normalizeSettings(base({ stream: { displayMode: 'fullscreen' }, host: { useVirtualDisplay: true } }))
    expect(s.schema).toBe(SETTINGS_SCHEMA)
    expect(s.stream.displayMode).toBe('borderless')
    expect(s.host.display).toBe('virtual')
    expect(s.stream.volume).toBe(100)
    expect(s.stream.muteHostChat).toBe(true)
    // После переноса явный выбор полного экрана сохраняется.
    expect(normalizeSettings({ ...s, stream: { ...s.stream, displayMode: 'fullscreen' } }).stream.displayMode).toBe('fullscreen')
  })

  it('accepts only known monitor ids', () => {
    expect(normalizeSettings(base({ host: { display: '{11111111-2222-3333-4444-555555555555}' } })).host.display).toBe('{11111111-2222-3333-4444-555555555555}')
    expect(normalizeSettings(base({ host: { display: '\\\\.\\DISPLAY1' } })).host.display).toBe('primary')
    expect(normalizeSettings(base({ stream: { volume: 250 } })).stream.volume).toBe(100)
  })
})

describe('moonlight args with audio routing', () => {
  it('asks Apollo not to keep the sound on the host when the host routes it', () => {
    const s = normalizeSettings({ nickname: 'A', deviceId: '00000000-0000-4000-8000-000000000000' } as unknown as Settings).stream
    const args = buildStreamArgs('26.1.1.1', s, undefined, { hostAudio: false, maxBitrateKbps: 0, hostWidth: 0, hostHeight: 0, hostFps: 0 })
    expect(args).toContain('--no-audio-on-host')
    expect(args).toContain('borderless')
  })
})

// ---------------------------------------------------------------- 0.3
import { makeInviteLink, parseInviteLink } from '@shared/protocol'
import { autoBitrateCap, migratePreset, PRESETS } from '@shared/quality'
import { parseEncoder } from '../src/main/services/apollo/displays'
import { autoProfile, lowerProfile, relaySuspect } from '../src/main/services/client/quality'
import { streamParams } from '../src/main/services/moonlight/runner'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsService } from '../src/main/settings'

describe('invite links', () => {
  it('round-trips and is found inside a chat message', () => {
    const link = makeInviteLink('26.14.88.201', 'Дима & Co', 'abcDEF123_-xyz')
    expect(parseInviteLink(link)).toEqual({ address: '26.14.88.201', name: 'Дима & Co', code: 'abcDEF123_-xyz' })
    expect(parseInviteLink(`Заходи!\n${link}\nЖду`)?.address).toBe('26.14.88.201')
  })

  it('rejects junk', () => {
    expect(parseInviteLink('streamly://join/999.1.1.1?name=x')).toBeNull()
    expect(parseInviteLink('https://example.com')).toBeNull()
    expect(parseInviteLink('streamly://join/26.1.1.1?name=<script>&code=no')).toEqual({ address: '26.1.1.1', name: 'Player', code: undefined })
  })
})

describe('host encoder from the Apollo log', () => {
  it('reads the last encoder probe', () => {
    const log = `Info: Found H.264 encoder: libx264 [software]
Info: Found H.264 encoder: h264_nvenc [nvenc]
Info: Found HEVC encoder: hevc_nvenc [nvenc]
Info: Found AV1 encoder: av1_nvenc [nvenc]`
    expect(parseEncoder(log)).toEqual({ vendor: 'nvenc', hevc: true, av1: true })
    expect(parseEncoder('Info: Found H.264 encoder: libx264 [software]')).toEqual({ vendor: 'software', hevc: false, av1: false })
    expect(parseEncoder('nothing')).toBeUndefined()
  })
})

describe('auto quality', () => {
  const base = { resolution: 'auto' as const, fps: 60 }
  it('uses 60% of the measured channel, within the host cap', () => {
    expect(autoProfile(100, base, 30000)).toEqual({ resolution: 'auto', fps: 60, bitrateKbps: 30000 })
    expect(autoProfile(20, base, 30000)).toEqual({ resolution: '1080', fps: 60, bitrateKbps: 12000 })
    expect(autoProfile(8, base, 30000)).toEqual({ resolution: '720', fps: 60, bitrateKbps: 5000 })
    expect(autoProfile(3, base, 30000)).toEqual({ resolution: '720', fps: 30, bitrateKbps: 2500 })
    // Никогда не выше того, что игрок выбрал сам.
    expect(autoProfile(200, { resolution: '1080', fps: 60 }, 0).resolution).toBe('1080')
  })

  it('steps down by 30% until the floor', () => {
    expect(lowerProfile({ resolution: 'auto', fps: 60, bitrateKbps: 20000 }, base)).toEqual({ resolution: '1080', fps: 60, bitrateKbps: 14000 })
    expect(lowerProfile({ resolution: '720', fps: 30, bitrateKbps: 2500 }, base)).toBeNull()
  })

  it('suspects the Radmin relay from latency and speed', () => {
    expect(relaySuspect([10, 12, 11, 9])).toBe(false)
    expect(relaySuspect([95, 90, 110])).toBe(true)
    // Очередь за собственным видеопотоком раздувает отдельные замеры: прямое соединение остаётся прямым.
    expect(relaySuspect([12, 400, 350, 15, 600])).toBe(false)
    expect(relaySuspect([40, 45, 38], 6)).toBe(true)
  })
})

describe('presets tuned for an RTX host', () => {
  it('migrates 0.2 presets and the bitrate cap', () => {
    expect(migratePreset({ resolution: '720', fps: 30, bitrateKbps: 5000 })).toEqual(PRESETS.economy)
    expect(migratePreset({ resolution: '1080', fps: 60, bitrateKbps: 15000 })).toEqual({ resolution: '1080', fps: 60, bitrateKbps: 15000 })
    const s = normalizeSettings({
      schema: 2,
      nickname: 'A',
      deviceId: '00000000-0000-4000-8000-000000000000',
      stream: { resolution: 'auto', fps: 60, bitrateKbps: 40000 },
      host: { maxBitrateKbps: 20000 }
    } as unknown as Settings)
    expect(s.stream).toMatchObject(PRESETS.high)
    expect(s.host.maxBitrateKbps).toBe(-1)
    expect(s.host.encoderPreset).toBe('balanced')
    expect(s.host.encoderCustom.nvPreset).toBe(3)
  })

  it('auto cap shares the upload between players', () => {
    // Одному — как в 0.1 (20 Мбит/с), дальше канал хоста делится.
    expect(autoBitrateCap(1)).toBe(20000)
    expect(autoBitrateCap(2)).toBe(15000)
    expect(autoBitrateCap(3)).toBe(12000)
    expect(autoBitrateCap(4)).toBe(10000)
  })

  it('0.5.1 settings: the high loss protection default turns back into normal, a fresh install starts with normal', () => {
    const base = { nickname: 'A', deviceId: '00000000-0000-4000-8000-000000000000' }
    expect(normalizeSettings({ ...base, schema: 3, host: { lossProtection: 'high', maxBitrateKbps: -1 } } as unknown as Settings).host).toMatchObject({
      lossProtection: 'normal',
      maxBitrateKbps: -1
    })
    // Выбор, сделанный уже в новой версии, сохраняется.
    expect(normalizeSettings({ ...base, schema: 4, host: { lossProtection: 'high' } } as unknown as Settings).host.lossProtection).toBe('high')
    expect(normalizeSettings({ ...base } as unknown as Settings).host.lossProtection).toBe('normal')
  })

  it('never streams more FPS than the player screen shows', () => {
    const st = normalizeSettings({ nickname: 'A', deviceId: '00000000-0000-4000-8000-000000000000' } as unknown as Settings).stream
    expect(streamParams({ ...st, ...PRESETS.high }, { width: 1920, height: 1080, fps: 60 }, { hostAudio: true, maxBitrateKbps: 30000, hostWidth: 2560, hostHeight: 1440, hostFps: 165 }).fps).toBe(60)
    expect(streamParams({ ...st, ...PRESETS.high }, { width: 2560, height: 1440, fps: 144 }, { hostAudio: true, maxBitrateKbps: 30000, hostWidth: 2560, hostHeight: 1440, hostFps: 165 }).fps).toBe(120)
  })
})

describe('protocol 0.3', () => {
  it('validates new messages', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'inputRequest', perms: { keyboard: true, mouse: false, gamepad: false } }))).toBeTruthy()
    expect(parseClientMessage(JSON.stringify({ t: 'inputRequest', perms: 'all' }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ t: 'speedTest' }))).toBeTruthy()
    const hello = { t: 'hello', v: 1, deviceId: '00000000-0000-4000-8000-000000000000', nickname: 'A', appVersion: '0.3.0' }
    expect(parseClientMessage(JSON.stringify({ ...hello, inviteCode: 'abcDEF123_-xyz' }))).toBeTruthy()
    expect(parseClientMessage(JSON.stringify({ ...hello, inviteCode: 'bad code!' }))).toBeNull()
    expect(parseHostMessage(JSON.stringify({ t: 'speedEnd', bytes: 4194304 }))).toBeTruthy()
    expect(parseHostMessage(JSON.stringify({ t: 'speedEnd', bytes: -1 }))).toBeNull()
    expect(parseHostMessage(JSON.stringify({ t: 'inputPaused', paused: true }))).toBeTruthy()
    expect(parseHostMessage(JSON.stringify({ t: 'inputRequestResult', granted: false }))).toBeTruthy()
    const policy = { hostAudio: true, maxBitrateKbps: 30000, hostWidth: 0, hostHeight: 0, hostFps: 0 }
    const accepted = { t: 'joinAccepted', perms: NO_INPUT, needsPair: false }
    expect(parseHostMessage(JSON.stringify({ ...accepted, policy: { ...policy, encoder: { vendor: 'nvenc', hevc: true, av1: true } } }))).toBeTruthy()
    expect(parseHostMessage(JSON.stringify({ ...accepted, policy: { ...policy, encoder: { vendor: 'x' } } }))).toBeNull()
  })
})

describe('per-host quality', () => {
  it('adds and removes host entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'streamly-hq-'))
    try {
      const s = new SettingsService(dir, 'ru')
      s.update({ hostQuality: { '26.1.1.1': PRESETS.economy } })
      expect(s.get().hostQuality['26.1.1.1']).toEqual(PRESETS.economy)
      s.update({ hostQuality: { '26.1.1.1': null } } as never)
      expect(s.get().hostQuality).toEqual({})
      s.update({ hostQuality: { 'not-an-ip': PRESETS.high } })
      expect(s.get().hostQuality).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
