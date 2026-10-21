import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { APOLLO_APP } from '@shared/protocol'
import type { StreamPolicy, StreamSettings } from '@shared/types'

export interface MoonlightProcess {
  readonly child: ChildProcess
  readonly exited: Promise<number>
  kill(): void
  /** Строки вывода процесса (stdout и stderr). */
  output?(): string[]
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

/** Аргументы `Moonlight.exe stream` с учётом условий хоста (звук, потолок битрейта, монитор хоста). */
export function buildStreamArgs(host: string, s: StreamSettings, native?: { width: number; height: number }, policy?: StreamPolicy): string[] {
  const args = ['stream', host, APOLLO_APP]
  const size = s.resolution === 'auto' ? pickResolution(native, policy) : RES[s.resolution]
  if (s.resolution === 'auto') {
    if (size) args.push('--resolution', `${size[0]}x${size[1]}`)
  } else {
    args.push(`--${s.resolution}`)
  }
  // Частоту выше, чем у монитора хоста, Apollo всё равно не захватит.
  const fps = policy?.hostFps && policy.hostFps >= 30 ? Math.min(s.fps, policy.hostFps) : s.fps
  args.push('--fps', String(fps))
  const bitrate = pickBitrate(s, size, fps, policy)
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
  // Рабочий стол общий для всех: уход одного игрока не должен закрывать его у остальных.
  args.push('--no-quit-after', '--no-game-optimization', '--multi-controller', '--keep-awake')
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

  private spawn(args: string[]): MoonlightProcess {
    this.ensureDataDir()
    const run: RunLog = { command: args.slice(0, 2).join(' '), startedAt: Date.now(), lines: [] }
    this.runs.push(run)
    if (this.runs.length > 6) this.runs.shift()
    const child = spawn(this.exePath, args, { cwd: this.dataDir, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
    // Потоки обязательно читаем, иначе при заполнении буфера Moonlight зависнет на записи.
    const collect = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) run.lines.push(line)
      }
      if (run.lines.length > MAX_LOG_LINES) run.lines.splice(0, run.lines.length - MAX_LOG_LINES)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const exited = new Promise<number>((resolve) => {
      child.once('exit', (code) => {
        this.saveLog(run, code)
        resolve(code ?? -1)
      })
      child.once('error', (e) => {
        run.lines.push(`spawn error: ${e.message}`)
        resolve(-1)
      })
    })
    return {
      child,
      exited,
      kill: () => {
        if (child.exitCode === null && !child.killed) child.kill()
      },
      output: () => [...run.lines]
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
    return this.spawn(buildStreamArgs(host, settings, native, policy))
  }
}
