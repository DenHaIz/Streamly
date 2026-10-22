// Раскладка геймпада для SDL (внутри Moonlight) по нажатиям: мастер «Настроить кнопки».
// Формат раскладки SDL: «GUID,имя,a:b0,b:b1,…,platform:Windows,». Элементы: bN — кнопка, hN.M — крестовина
// (M: 1 вверх, 2 вправо, 4 вниз, 8 влево), aN — ось, +aN/−aN — половина оси, aN~ — ось наоборот.
import type { PadRawState } from './types'

export type PadTarget =
  | 'a'
  | 'b'
  | 'x'
  | 'y'
  | 'dpup'
  | 'dpdown'
  | 'dpleft'
  | 'dpright'
  | 'leftshoulder'
  | 'rightshoulder'
  | 'lefttrigger'
  | 'righttrigger'
  | 'back'
  | 'start'
  | 'leftstick'
  | 'rightstick'
  | 'leftx'
  | 'lefty'
  | 'rightx'
  | 'righty'
  | 'guide'

/** Шаги мастера по порядку. Для стиков — «вправо» и «вниз» (так SDL считает положительное направление). */
export const PAD_STEPS: PadTarget[] = [
  'a',
  'b',
  'x',
  'y',
  'dpup',
  'dpdown',
  'dpleft',
  'dpright',
  'leftshoulder',
  'rightshoulder',
  'lefttrigger',
  'righttrigger',
  'back',
  'start',
  'leftstick',
  'rightstick',
  'leftx',
  'lefty',
  'rightx',
  'righty',
  'guide'
]

const STICKS = new Set<PadTarget>(['leftx', 'lefty', 'rightx', 'righty'])
/** Насколько ось должна отойти от покоя, чтобы считаться нажатой (из 32768). */
const MOVED = 16000

/** Элемент раскладки, который сейчас отличается от состояния покоя (или null — всё отпущено). */
export function detectInput(rest: PadRawState, now: PadRawState, target: PadTarget): string | null {
  const stick = STICKS.has(target)
  if (!stick) {
    for (let i = 0; i < now.buttons.length; i++) if (now.buttons[i] && !rest.buttons[i]) return `b${i}`
    for (let i = 0; i < now.hats.length; i++) {
      const v = now.hats[i]
      if (v !== (rest.hats[i] ?? 0) && [1, 2, 4, 8].includes(v)) return `h${i}.${v}`
    }
  }
  for (let i = 0; i < now.axes.length; i++) {
    const from = rest.axes[i] ?? 0
    const to = now.axes[i]
    if (Math.abs(to - from) < MOVED) continue
    if (stick) return to > from ? `a${i}` : `a${i}~`
    // Курок на целую ось: в покое у края, нажат — у другого края.
    if (Math.abs(from) > 24000) return from < 0 ? `a${i}` : `a${i}~`
    return to > from ? `+a${i}` : `-a${i}`
  }
  return null
}

/** Всё ли отпущено (можно ждать следующего нажатия). */
export function isReleased(rest: PadRawState, now: PadRawState): boolean {
  if (now.buttons.some((b, i) => b && !rest.buttons[i])) return false
  if (now.hats.some((h, i) => h !== (rest.hats[i] ?? 0))) return false
  return now.axes.every((a, i) => Math.abs(a - (rest.axes[i] ?? 0)) < MOVED / 2)
}

/** Один и тот же элемент (кнопка, направление крестовины, ось или её половина) не назначается дважды. */
export function inputKey(el: string): string {
  return el.replace('~', '')
}

/** Строка раскладки SDL. */
export function buildMapping(guid: string, name: string, binds: Partial<Record<PadTarget, string>>): string {
  const safe = name.replace(/[,\r\n]/g, ' ').trim().slice(0, 60) || 'Gamepad'
  const parts = PAD_STEPS.filter((t) => binds[t]).map((t) => `${t}:${binds[t]}`)
  return `${guid},${safe},${parts.join(',')},platform:Windows,`
}
