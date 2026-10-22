// Горячие клавиши: общая проверка для настроек (основной процесс) и записи сочетания в интерфейсе.

/** Системные сочетания Windows, которые нельзя занимать. */
const RESERVED = new Set(['Alt+F4', 'Alt+Tab', 'Alt+Space', 'Alt+Escape', 'Ctrl+Escape', 'Ctrl+Alt+Delete', 'Ctrl+Shift+Escape'])

/**
 * Сочетание клавиш в формате Electron: модификаторы и одна клавиша. Без модификатора — только F13–F24
 * (обычную клавишу или F1–F12 игра бы потеряла). Пустая строка — сочетание выключено.
 */
export function isAccelerator(v: unknown): v is string {
  if (v === '') return true
  if (typeof v !== 'string' || v.length > 40 || RESERVED.has(v)) return false
  const parts = v.split('+')
  const key = parts.pop()!
  const mods = parts
  if (new Set(mods).size !== mods.length || !mods.every((m) => ['Ctrl', 'Alt', 'Shift', 'Super'].includes(m))) return false
  if (!/^(F([1-9]|1\d|2[0-4])|[A-Z0-9]|Space|Tab|Insert|Delete|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus|[-=[\];',./\\`])$/.test(key)) return false
  if (!mods.length) return /^F(1[3-9]|2[0-4])$/.test(key)
  // Одиночный Shift с буквой — это просто заглавная буква в чате.
  return !(mods.length === 1 && mods[0] === 'Shift' && !/^F/.test(key))
}

const CODES: Record<string, string> = {
  Space: 'Space',
  Tab: 'Tab',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`'
}

/** Клавиша из KeyboardEvent.code в названии Electron (null — модификатор или неподдерживаемая). */
export function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code
  return CODES[code] ?? null
}

/** Сочетание из нажатия: модификаторы в порядке Ctrl, Alt, Shift, Super. */
export function acceleratorFromEvent(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  const key = keyFromCode(e.code)
  if (!key) return null
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[]
  return [...mods, key].join('+')
}
