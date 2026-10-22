import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** taskkill по полному пути: PATH у пользователя может быть каким угодно. */
const TASKKILL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
import { APOLLO_APP } from '@shared/protocol'
import type { StreamPolicy, StreamSettings } from '@shared/types'

export interface MoonlightProcess {
  readonly child: ChildProcess
  readonly exited: Promise<number>
  kill(): void
  /**
   * Закрыть окно как крестиком: Moonlight корректно завершает сессию, и хост сразу видит отключение
   * (при kill Apollo ждёт таймаута). Если процесс не закрылся за несколько секунд — kill.
   */
  close?(): void
  /** Строки вывода процесса (stdout и stderr). */
  output?(): string[]
  /** Подписка на новые строки вывода. */
  onLine?(cb: (line: string) => void): void
}

const RES: Record<Exclude<StreamSettings['resolution'], 'auto'>, [number, number]> = {
  '720': [1280, 720],
  '1080': [1920, 1080],
  '1440': [2560, 1440],
  '4K': [3840, 2160]
}

/**
 * Разрешение «авто»: экран клиента, но не больше монитора хоста (выше него картинка
 * только растягивается, а нагрузка на кодирование и сеть растёт).
 */
export function pickResolution(native?: { width: number; height: number }, policy?: StreamPolicy): [number, number] | undefined {
  if (!native) return policy?.hostWidth ? [policy.hostWidth, policy.hostHeight] : undefined
  if (policy?.hostWidth && policy.hostHeight && native.width * native.height > policy.hostWidth * policy.hostHeight) {
    return [policy.hostWidth, policy.hostHeight]
  }
  return [native.width, native.height]
}

/** Битрейт примерно как у Moonlight «авто» (20 Мбит/с на 1080p60), но не выше потолка хоста. */
export function pickBitrate(s: StreamSettings, size: [number, number] | undefined, fps: number, policy?: StreamPolicy): number | undefined {
  const cap = policy?.maxBitrateKbps ?? 0
  if (s.bitrateKbps > 0) return cap > 0 ? Math.min(s.bitrateKbps, cap) : s.bitrateKbps
  if (cap <= 0) return undefined
  const [w, h] = size ?? [1920, 1080]
  const auto = Math.round((20000 * ((w * h) / (1920 * 1080)) * Math.max(fps, 30)) / 60)
  return Math.max(2000, Math.min(auto, cap))
}

/** Итоговые параметры трансляции: разрешение, частота и битрейт с учётом условий хоста. */
export function streamParams(
  s: StreamSettings,
  native?: { width: number; height: number; fps?: number },
  policy?: StreamPolicy
): { size?: [number, number]; fps: number; bitrateKbps?: number } {
  const size = s.resolution === 'auto' ? pickResolution(native, policy) : RES[s.resolution]
  // Частоту выше, чем у монитора хоста, Apollo всё равно не захватит, а выше экрана игрока — тот не покажет.
  let fps = policy?.hostFps && policy.hostFps >= 30 ? Math.min(s.fps, policy.hostFps) : s.fps
  if (native?.fps && native.fps >= 30) fps = Math.min(fps, native.fps)
  return { size, fps, bitrateKbps: pickBitrate(s, size, fps, policy) }
}

/**
 * Свои раскладки геймпадов для SDL внутри Moonlight (переменная SDL_GAMECONTROLLERCONFIG, по строке на геймпад).
 * Каждая раскладка ещё и с обнулённой контрольной суммой имени в GUID: SDL сравнивает GUID и без неё,
 * если имя устройства у Moonlight прочиталось иначе.
 */
export function padMappingsEnv(mappings: Record<string, string> | undefined): string | undefined {
  const lines: string[] = []
  for (const [guid, m] of Object.entries(mappings ?? {})) {
    lines.push(m)
    const noCrc = `${guid.slice(0, 4)}0000${guid.slice(8)}`
    if (noCrc !== guid) lines.push(noCrc + m.slice(guid.length))
  }
  return lines.length ? lines.join('\n') : undefined
}

/** Аргументы `Moonlight.exe stream` с учётом условий хоста (звук, потолок битрейта, монитор хоста). */
export function buildStreamArgs(host: string, s: StreamSettings, native?: { width: number; height: number }, policy?: StreamPolicy): string[] {
  const args = ['stream', host, APOLLO_APP]
  const { size, fps, bitrateKbps: bitrate } = streamParams(s, native, policy)
  if (s.resolution === 'auto') {
    if (size) args.push('--resolution', `${size[0]}x${size[1]}`)
  } else {
    args.push(`--${s.resolution}`)
  }
  args.push('--fps', String(fps))
  if (bitrate) args.push('--bitrate', String(bitrate))
  if (s.codec !== 'auto') args.push('--video-codec', s.codec)
  if (s.packetSize > 0) args.push('--packet-size', String(s.packetSize))
  args.push('--display-mode', s.displayMode)
  args.push('--capture-system-keys', s.captureSystemKeys)
  args.push(s.vsync ? '--vsync' : '--no-vsync')
  args.push(s.framePacing ? '--frame-pacing' : '--no-frame-pacing')
  args.push(s.perfOverlay ? '--performance-overlay' : '--no-performance-overlay')
  // Звук решает хост: при совместной игре он должен слышать игру сам (см. HostSettings.keepHostAudio).
  args.push(policy?.hostAudio === false ? '--no-audio-on-host' : '--audio-on-host')
  args.push(s.absoluteMouse ? '--absolute-mouse' : '--no-absolute-mouse')
  // HDR и 4:4:4 Moonlight включает, только если их поддерживают оба ПК («if supported»).
  args.push(s.hdr ? '--hdr' : '--no-hdr')
  args.push(s.yuv444 ? '--yuv444' : '--no-yuv444')
  // Геймпад работает и когда окно трансляции не в фокусе: меню Alt+F2, второй монитор.
  args.push('--background-gamepad')
  // Рабочий стол общий для всех: уход одного игрока не должен закрывать его у остальных.
  // «Один геймпад»: все геймпады игрока управляют первым — против двойных устройств (Steam Input, DS4Windows).
  args.push('--no-quit-after', '--no-game-optimization', s.singleGamepad ? '--no-multi-controller' : '--multi-controller', '--keep-awake')
  return args
}

/** Последние строки вывода одного запуска Moonlight. */
interface RunLog {
  command: string
  startedAt: number
  lines: string[]
}

const MAX_LOG_LINES = 400

/**
 * Запуск портативного Moonlight-qt. Портативный режим включается файлом portable.dat
 * в рабочей папке процесса, поэтому все настройки и сертификат сопряжения лежат в dataDir.
 *
 * Вывод Moonlight забираем сами (stdout/stderr): при перенаправленном stderr Moonlight
 * не создаёт свой лог-файл и пишет всё в поток. Последний запуск сохраняется в moonlight-last.log.
 */
export class MoonlightRunner {
  private readonly runs: RunLog[] = []

  constructor(
    private readonly exePath: string,
    private readonly dataDir: string
  ) {}

  get available(): boolean {
    return existsSync(this.exePath)
  }

  private ensureDataDir(): void {
    mkdirSync(this.dataDir, { recursive: true })
    const marker = join(this.dataDir, 'portable.dat')
    if (!existsSync(marker)) writeFileSync(marker, '')
  }

  private spawn(args: string[], env?: Record<string, string>): MoonlightProcess {
    this.ensureDataDir()
    const run: RunLog = { command: args.slice(0, 2).join(' '), startedAt: Date.now(), lines: [] }
    const subscribers: Array<(line: string) => void> = []
    this.runs.push(run)
    if (this.runs.length > 6) this.runs.shift()
    const child = spawn(this.exePath, args, { cwd: this.dataDir, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : undefined })
    // Потоки обязательно читаем, иначе при заполнении буфера Moonlight зависнет на записи.
    // У каждого потока свой остаток: строка, разрезанная между кусками, не теряется.
    const collector = (): ((chunk: Buffer | null) => void) => {
      let rest = ''
      return (chunk) => {
        const text = rest + (chunk ? chunk.toString('utf8') : '\n')
        const parts = text.split(/\r?\n/)
        rest = parts.pop() ?? ''
        for (const line of parts) {
          if (!line.trim()) continue
          run.lines.push(line)
          for (const cb of subscribers) cb(line)
        }
        if (run.lines.length > MAX_LOG_LINES) run.lines.splice(0, run.lines.length - MAX_LOG_LINES)
      }
    }
    const out = collector()
    const err = collector()
    child.stdout?.on('data', out)
    child.stderr?.on('data', err)
    const exited = new Promise<number>((resolve) => {
      // 'close' приходит после того, как потоки дочитаны: вывод `list` к этому моменту полный.
      let done = false
      const finish = (code: number | null): void => {
        if (done) return
        done = true
        out(null)
        err(null)
        this.saveLog(run, code)
        resolve(code ?? -1)
      }
      child.once('close', finish)
      // Если потоки держит кто-то ещё (дочерний процесс Moonlight), 'close' может не прийти: страховка.
      child.once('exit', (code) => setTimeout(() => finish(code), 2000))
      child.once('error', (e) => {
        run.lines.push(`spawn error: ${e.message}`)
        resolve(-1)
      })
    })
    const kill = (): void => {
      if (child.exitCode === null && !child.killed) child.kill()
    }
    return {
      child,
      exited,
      kill,
      close: () => {
        if (child.exitCode !== null || child.killed || !child.pid) return
        // taskkill без /F отправляет окну WM_CLOSE: Moonlight завершает сессию, как по крестику.
        spawn(TASKKILL, ['/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }).on('error', kill)
        setTimeout(kill, 4000)
      },
      output: () => [...run.lines],
      onLine: (cb) => {
        subscribers.push(cb)
      }
    }
  }

  private saveLog(run: RunLog, code: number | null): void {
    if (run.command.startsWith('list')) return
    try {
      const head = `# moonlight ${run.command} · ${new Date(run.startedAt).toISOString()} · exit ${code}`
      writeFileSync(join(this.dataDir, 'moonlight-last.log'), [head, ...run.lines].join('\n'))
    } catch {
      /* лог не критичен */
    }
  }

  /** Окно сопряжения Moonlight с заранее известным PIN. Результат определяет хост, процесс закрываем сами. */
  pair(host: string, pin: string): MoonlightProcess {
    return this.spawn(['pair', host, '--pin', pin])
  }

  /** `list` без GUI: код выхода 0 значит, что клиент сопряжён и хост доступен. */
  list(host: string): MoonlightProcess {
    return this.spawn(['list', host])
  }

  /**
   * Хвост вывода самого свежего запуска pair/stream, начатого после since: строки с ошибками
   * и предупреждениями (или просто последние строки) — для подробностей в окне ошибки.
   */
  logTail(since: number, maxLines = 14): string | undefined {
    const run = [...this.runs].reverse().find((r) => r.startedAt >= since - 2000 && !r.command.startsWith('list'))
    if (!run || !run.lines.length) return undefined
    const important = run.lines.filter((l) => /error|fail|warn|unable|cannot|could not|timed out|refused|denied/i.test(l))
    return (important.length ? important : run.lines).slice(-maxLines).join('\n')
  }

  stream(host: string, settings: StreamSettings, native?: { width: number; height: number }, policy?: StreamPolicy): MoonlightProcess {
    const pads = padMappingsEnv(settings.padMappings)
    return this.spawn(buildStreamArgs(host, settings, native, policy), pads ? { SDL_GAMECONTROLLERCONFIG: pads } : undefined)
  }
}
