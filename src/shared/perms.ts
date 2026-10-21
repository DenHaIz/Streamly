// Битовая маска прав клиента в Apollo (src/crypto.h в ClassicOldSong/Apollo).
export const PERM = {
  inputController: 0x0000100,
  inputTouch: 0x0000200,
  inputPen: 0x0000400,
  inputMouse: 0x0000800,
  inputKbd: 0x0001000,
  clipboardSet: 0x0010000,
  clipboardRead: 0x0020000,
  list: 0x1000000,
  view: 0x2000000,
  launch: 0x4000000
} as const

/** Минимум, чтобы клиент мог видеть список приложений, запускать «Desktop» и смотреть стрим. */
export const PERM_BASE = PERM.list | PERM.view | PERM.launch

/** Права, которые хост переключает в интерфейсе. */
export interface InputPerms {
  keyboard: boolean
  mouse: boolean
  gamepad: boolean
}

export const NO_INPUT: InputPerms = { keyboard: false, mouse: false, gamepad: false }

/** Маска для допущенного клиента: базовые права плюс выбранный ввод. Мышь включает тач и перо. */
export function toApolloPerm(p: InputPerms): number {
  let perm = PERM_BASE
  if (p.keyboard) perm |= PERM.inputKbd
  if (p.mouse) perm |= PERM.inputMouse | PERM.inputTouch | PERM.inputPen
  if (p.gamepad) perm |= PERM.inputController
  return perm
}

export function fromApolloPerm(perm: number): InputPerms {
  return {
    keyboard: (perm & PERM.inputKbd) !== 0,
    mouse: (perm & PERM.inputMouse) !== 0,
    gamepad: (perm & PERM.inputController) !== 0
  }
}
