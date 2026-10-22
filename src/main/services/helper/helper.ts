import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { PadRawState } from '@shared/types'

/** Устройство ввода глазами Moonlight (SDL). gamepad — у SDL есть раскладка, и Moonlight передаст его хосту. */
export interface PadDevice {
  guid: string
  name: string
  vendor: number
  product: number
  gamepad: boolean
}

/** Состояние маршрутизации звука хоста по данным помощника. */
export interface RouterState {
  enabled: boolean
  virtualFound: boolean
  virtualName: string | null
  active: boolean
  monitoring: boolean
  chatExcluded: boolean
  error: string | null
}

export interface RouterOptions {
  enabled: boolean
  /** Повторять звук виртуальных колонок на настоящие (хост слышит игру). */
  monitor: boolean
  /** Закрепить голосовой чат за настоящими колонками (мимо трансляции). */
  excludeChat: boolean
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface NetAdapter {
  name: string
  description: string
  wifi: boolean
  addresses: string[]
  gateway: boolean
  speedMbps: number
  sent: number
  received: number
}

/** Адаптер, через который ПК выходит в сеть: со шлюзом и не виртуальный (Radmin, Tailscale, ZeroTier). */
export function internetAdapter(list: NetAdapter[]): NetAdapter | undefined {
  return list.find((a) => a.gateway && !/radmin|tailscale|zerotier|hamachi|vpn|virtual|hyper-v/i.test(`${a.name} ${a.description}`))
}

/** Голосовые чаты, которые убираются из трансляции (имена процессов без .exe). */
export const CHAT_APPS = ['Discord', 'DiscordPTB', 'DiscordCanary']
/** Виртуальные колонки, которые Apollo по умолчанию использует, когда звук не остаётся на хосте. */
export const VIRTUAL_SINKS = ['Steam Streaming Speakers']

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Процесс StreamlyHelper.exe (native/helper): громкость, курсор, окна, маршрутизация звука.
 * Запускается при первом обращении, при падении перезапускается (не чаще раза в 5 с).
 * Если помощника нет (сборка без него), вызовы завершаются ошибкой, а приложение работает без этих функций.
 */
/** Слот геймпада XInput (0–3). active — сейчас нажата кнопка, курок или отклонён стик. */
export interface XInputSlot {
  index: number
  connected: boolean
  packet: number
  active: boolean
}

export class Helper extends EventEmitter {
  private proc: ChildProcess | null = null
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private lastStart = 0
  /** Таймауты подряд: помощник, видимо, завис на одном вызове (он выполняет их по очереди). */
  private timeouts = 0
  /** Падения подряд вскоре после запуска: перезапуск маршрутизации звука с нарастающей паузой. */
  private crashes = 0
  private routerOptions: RouterOptions | null = null
  routerState: RouterState | null = null
  /** Сочетания, которые помощник сейчас ловит («id:vk:mods»): после перезапуска помощника отправляются снова. */
  private hotkeyCombos: string[] = []
  private hotkeyRetry: NodeJS.Timeout | null = null

  constructor(
    private readonly exePath: string,
    private readonly log: (msg: string, err?: unknown) => void = () => undefined
  ) {
    super()
  }

  get available(): boolean {
    return existsSync(this.exePath)
  }

  private ensure(): ChildProcess {
    if (this.proc && this.proc.exitCode === null) return this.proc
    if (!this.available) throw new Error('helper missing')
    if (Date.now() - this.lastStart < 5000) throw new Error('helper restarting')
    this.lastStart = Date.now()
    const proc = spawn(this.exePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    createInterface({ input: proc.stdout! }).on('line', (line) => this.onLine(line))
    proc.stderr?.on('data', (d: Buffer) => this.log(`[helper] stderr ${d.toString().trim()}`))
    proc.stdin?.on('error', () => undefined)
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`helper exited (${code})`))
        this.pending.delete(id)
      }
      this.log(`[helper] exited with ${code}`)
      // Проработал больше двух минут — значит, это не падение при старте: счётчик с нуля.
      this.crashes = Date.now() - this.lastStart > 120_000 ? 0 : this.crashes + 1
      // Маршрутизация звука должна пережить падение помощника, но без бесконечного цикла перезапусков.
      const delay = Math.min(5500 * 2 ** Math.max(0, this.crashes - 1), 60_000)
      if (this.routerOptions?.enabled) setTimeout(() => void this.router(this.routerOptions!).catch(() => undefined), delay)
      // Горячие клавиши тоже должны пережить падение помощника.
      if (this.hotkeyCombos.length) this.retryHotkeys(delay)
    })
    proc.on('error', (e) => this.log('[helper] spawn failed', e))
    return proc
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (msg.event === 'log') return this.log(`[helper] ${String(msg.text)}`)
    if (msg.event === 'hotkey') {
      this.emit('hotkey', String(msg.id))
      return
    }
    if (msg.event === 'router') {
      this.routerState = msg.state as RouterState
      this.emit('router', this.routerState)
      return
    }
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    this.timeouts = 0
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(String(msg.error)))
  }

  call<T>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let proc: ChildProcess
      try {
        proc = this.ensure()
      } catch (e) {
        return reject(e as Error)
      }
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`helper ${cmd}: timeout`))
        // Два таймаута подряд: помощник завис, и все следующие вызовы стояли бы за ним. Перезапускаем.
        if (++this.timeouts >= 2 && this.proc === proc) {
          this.log('[helper] not responding: restarting')
          this.timeouts = 0
          proc.kill()
        }
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      proc.stdin?.write(JSON.stringify({ id, cmd, ...args }) + '\n')
    })
  }

  /** Громкость звука процесса (0–1). Возвращает число найденных звуковых сессий. */
  setVolume(pid: number, level: number): Promise<number> {
    return this.call<number>('volume', { pid, level })
  }

  windowRect(pid: number): Promise<Rect | null> {
    return this.call<Rect | null>('windowRect', { pid })
  }

  focus(pid: number): Promise<boolean> {
    return this.call<boolean>('focus', { pid })
  }

  /** Курсор на другой монитор и фокус на окно под ним (Moonlight отпускает мышь). */
  cursorToOtherScreen(pid: number): Promise<boolean> {
    return this.call<boolean>('cursorToOtherScreen', { pid })
  }

  /** Названия видеокарт (WMI Win32_VideoController). */
  gpus(): Promise<string[]> {
    return this.call<string[]>('gpus', {}, 8000)
  }

  netInfo(): Promise<NetAdapter[]> {
    return this.call<NetAdapter[]>('netInfo')
  }

  /** Слоты XInput этого ПК (у хоста — и виртуальные геймпады игроков). */
  xinput(): Promise<XInputSlot[]> {
    return this.call<XInputSlot[]>('xinput', {}, 2000)
  }

  /** Окно процесса не отвечает (Windows считает его зависшим). */
  hung(pid: number): Promise<boolean> {
    return this.call<boolean>('hung', { pid }, 3000)
  }

  /** Активирует окно процесса и нажимает сочетание клавиш (например, ['ctrl', 'alt', 'shift', 's']). */
  sendKeys(pid: number, keys: string[]): Promise<boolean> {
    return this.call<boolean>('sendKeys', { pid, keys })
  }

  async router(opts: RouterOptions): Promise<RouterState> {
    this.routerOptions = opts
    const state = await this.call<RouterState>('router', { ...opts, chatApps: CHAT_APPS, virtualNames: VIRTUAL_SINKS }, 8000)
    this.routerState = state
    this.emit('router', state)
    return state
  }

  /**
   * Горячие клавиши через перехват клавиатуры помощника («id:vk:mods», см. comboOf). Работают и когда Moonlight
   * захватил клавиатуру, а клавиши, которые Apollo вводит у хоста от игроков, не считаются. Пустой список — снять.
   */
  async setHotkeys(combos: string[]): Promise<void> {
    this.hotkeyCombos = combos
    if (this.hotkeyRetry) clearTimeout(this.hotkeyRetry)
    this.hotkeyRetry = null
    if (!combos.length && !this.proc) return
    try {
      await this.call('hotkeys', { combos })
    } catch (e) {
      if (combos.length) this.retryHotkeys(5500)
      throw e
    }
  }

  private retryHotkeys(delay: number): void {
    if (this.hotkeyRetry) clearTimeout(this.hotkeyRetry)
    this.hotkeyRetry = setTimeout(() => {
      this.hotkeyRetry = null
      if (this.hotkeyCombos.length) void this.setHotkeys(this.hotkeyCombos).catch(() => undefined)
    }, delay)
  }

  /** Окно поверх всех (и поверх игры «без рамки»); activate — ещё и сделать активным, обходя запрет Windows. */
  raise(hwnd: number, activate: boolean): Promise<boolean> {
    return this.call<boolean>('raise', { hwnd, activate }, 2000)
  }

  /** Геймпады этого ПК так, как их видит Moonlight (его SDL3 и база раскладок, плюс свои раскладки Streamly). */
  pads(sdl: string, db: string, mappings: string[]): Promise<PadDevice[]> {
    return this.call<PadDevice[]>('pads', { sdl, db, mappings }, 8000)
  }

  /** Сырые кнопки, оси и крестовины геймпада (для мастера раскладки). null — геймпад отключён. */
  padState(sdl: string, db: string, guid: string): Promise<PadRawState | null> {
    return this.call<PadRawState | null>('padState', { sdl, db, guid }, 3000)
  }

  padClose(): Promise<boolean> {
    return this.call<boolean>('padClose', {}, 3000)
  }

  /** Закрывает помощника: он возвращает маршрутизацию звука и выходит сам. */
  stop(): void {
    this.hotkeyCombos = []
    if (this.hotkeyRetry) clearTimeout(this.hotkeyRetry)
    this.hotkeyRetry = null
    this.routerOptions = null
    this.proc?.stdin?.end()
  }
}
