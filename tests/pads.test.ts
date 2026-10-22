import { describe, expect, it } from 'vitest'
import { buildMapping, detectInput, inputKey, isReleased, PAD_STEPS } from '../src/shared/padmap'
import { comboOf } from '../src/shared/hotkeys'
import { padMappingsEnv } from '../src/main/services/moonlight/runner'
import { normalizePadMappings, normalizeSettings } from '../src/main/settings'
import type { PadRawState, Settings } from '../src/shared/types'

const rest: PadRawState = { buttons: [false, false, false, false], axes: [0, 0, -32768, 0], hats: [0] }
const st = (patch: Partial<PadRawState>): PadRawState => ({ ...rest, ...patch })

describe('gamepad mapping wizard', () => {
  it('detects buttons, d-pad directions, sticks and triggers', () => {
    expect(detectInput(rest, rest, 'a')).toBeNull()
    expect(detectInput(rest, st({ buttons: [false, false, true, false] }), 'a')).toBe('b2')
    expect(detectInput(rest, st({ hats: [4] }), 'dpdown')).toBe('h0.4')
    // Диагональ крестовины не считается направлением.
    expect(detectInput(rest, st({ hats: [3] }), 'dpup')).toBeNull()
    // Стик: вправо — ось как есть, наоборот — с тильдой; кнопки на шаге стика не считаются.
    expect(detectInput(rest, st({ axes: [30000, 0, -32768, 0] }), 'leftx')).toBe('a0')
    expect(detectInput(rest, st({ axes: [0, -30000, -32768, 0] }), 'lefty')).toBe('a1~')
    expect(detectInput(rest, st({ buttons: [true, false, false, false] }), 'leftx')).toBeNull()
    // Курок на целую ось (в покое −32768) и половина общей оси (старые геймпады: оба курка на оси Z).
    expect(detectInput(rest, st({ axes: [0, 0, 32767, 0] }), 'lefttrigger')).toBe('a2')
    expect(detectInput(rest, st({ axes: [0, 0, -32768, 32000] }), 'righttrigger')).toBe('+a3')
    expect(detectInput(rest, st({ axes: [0, 0, -32768, -32000] }), 'lefttrigger')).toBe('-a3')
    // Крестовина на осях.
    expect(detectInput(rest, st({ axes: [0, 0, -32768, -32767] }), 'dpup')).toBe('-a3')
  })

  it('waits for release and does not assign one input twice', () => {
    expect(isReleased(rest, rest)).toBe(true)
    expect(isReleased(rest, st({ buttons: [true, false, false, false] }))).toBe(false)
    expect(isReleased(rest, st({ axes: [3000, 0, -32768, 0] }))).toBe(true)
    expect(inputKey('a1~')).toBe(inputKey('a1'))
    expect(inputKey('+a3')).not.toBe(inputKey('-a3'))
  })

  it('builds an SDL mapping string and passes it to Moonlight', () => {
    const guid = '03001234790000000600000000000000'
    const m = buildMapping(guid, 'USB, Gamepad', { a: 'b2', b: 'b1', dpup: 'h0.1', leftx: 'a0', lefttrigger: '-a3' })
    expect(m).toBe(`${guid},USB  Gamepad,a:b2,b:b1,dpup:h0.1,lefttrigger:-a3,leftx:a0,platform:Windows,`)
    expect(PAD_STEPS[0]).toBe('a')
    // Moonlight получает раскладку и её вариант без контрольной суммы имени в GUID.
    const env = padMappingsEnv({ [guid]: m })!.split('\n')
    expect(env).toHaveLength(2)
    expect(env[1].startsWith('03000000790000000600000000000000,USB  Gamepad,a:b2')).toBe(true)
    expect(padMappingsEnv({})).toBeUndefined()
  })

  it('keeps only valid mappings in the settings (an empty one removes it)', () => {
    const guid = '03000000790000000600000000000000'
    expect(normalizePadMappings({ [guid]: `${guid},Pad,a:b0,platform:Windows,`, bad: 'x', [guid.replace('0', 'f')]: '' })).toEqual({
      [guid]: `${guid},Pad,a:b0,platform:Windows,`
    })
    expect(normalizePadMappings({ [guid]: `${guid},Pad\nevil` })).toEqual({})
    const s = normalizeSettings({ nickname: 'A', deviceId: '00000000-0000-4000-8000-000000000000' } as unknown as Settings)
    expect(s.stream.padMappings).toEqual({})
    expect(s.host.encoderPreset).toBe('latency')
  })
})

describe('hotkeys through the helper', () => {
  it('turns accelerators into virtual-key combos', () => {
    expect(comboOf('Alt+F2')).toBe(`${0x71}:2`)
    expect(comboOf('Ctrl+Shift+F2')).toBe(`${0x71}:5`)
    expect(comboOf('Alt+F12')).toBe(`${0x7b}:2`)
    expect(comboOf('Super+Alt+K')).toBe(`${0x4b}:10`)
    expect(comboOf('Ctrl+Alt+Up')).toBe(`${0x26}:3`)
    expect(comboOf('F13')).toBe(`${0x7c}:0`)
    expect(comboOf('')).toBeNull()
    expect(comboOf('Alt+F4')).toBeNull()
  })
})
