// Меню Alt+F2, звук хоста, выбор монитора, устойчивость связи: чистые функции.
import { describe, expect, it } from 'vitest'
import { effectivePerms, NO_INPUT, PERM, toApolloPerm } from '@shared/perms'
import { parseClientMessage, parseHostMessage } from '@shared/protocol'
import type { Settings } from '@shared/types'
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
    expect(s.schema).toBe(2)
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
