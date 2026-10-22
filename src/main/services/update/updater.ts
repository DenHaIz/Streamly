import { EventEmitter } from 'node:events'
import type { UpdateState } from '@shared/types'

/** Часть electron-updater, которой пользуемся (в тестах — подделка). */
export interface UpdaterBackend {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- события electron-updater с разными аргументами
  on(event: string, cb: (...args: any[]) => void): unknown
}

export interface UpdateDeps {
  backend: UpdaterBackend | null
  currentVersion: string
  /** Автопроверка включена в настройках. */
  autoCheck: () => boolean
  /** Версия, которую попросили не предлагать. */
  skipped: () => string
  /** Перед установкой: остановить хостинг и трансляцию (Streamly закроется). */
  beforeInstall: () => Promise<void>
  log?: (msg: string, err?: unknown) => void
  /** Первая проверка после запуска и интервал между проверками. */
  firstCheckMs?: number
  intervalMs?: number
}

/** Описание релиза с GitHub приходит HTML-ом: оставляем текст со списками. */
export function notesToText(notes: unknown): string | undefined {
  const raw = Array.isArray(notes)
    ? notes.map((n: { note?: unknown }) => (typeof n?.note === 'string' ? n.note : '')).join('\n')
    : typeof notes === 'string'
      ? notes
      : ''
  const text = raw
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/(p|li|h\d|ul|ol|div)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\*\*/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text ? text.slice(0, 2500) : undefined
}

/** Версия a новее b (x.y.z, без пререлизов). */
export function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

/**
 * Обновление через GitHub Releases (electron-updater, latest.yml в релизе).
 * Ничего не происходит без пользователя: Streamly только проверяет и сообщает о новой версии,
 * скачивание и установка — по кнопке. Скачанное, но не установленное обновление ставится при выходе.
 */
export class UpdateService extends EventEmitter {
  private state: UpdateState
  private timer: NodeJS.Timeout | null = null
  private checking: Promise<UpdateState> | null = null
  /** Проверку запустил пользователь: ошибки показываем, а не только пишем в лог. */
  private manual = false
  private lastError = ''

  constructor(private readonly d: UpdateDeps) {
    super()
    this.state = { status: d.backend ? 'idle' : 'unsupported', current: d.currentVersion }
    const b = d.backend
    if (!b) return
    b.autoDownload = false
    b.autoInstallOnAppQuit = false
    b.allowPrerelease = false
    b.allowDowngrade = false
    b.on('update-available', ((info: { version: string; releaseNotes?: unknown }) => {
      this.set({ status: 'available', version: info.version, notes: notesToText(info.releaseNotes), error: undefined })
    }) as never)
    b.on('update-not-available', (() => this.set({ status: 'latest', version: undefined, notes: undefined, error: undefined })) as never)
    b.on('download-progress', ((p: { percent: number; bytesPerSecond: number }) => {
      const percent = Math.floor(p.percent)
      if (percent !== this.state.percent) this.set({ status: 'downloading', percent, bytesPerSecond: Math.round(p.bytesPerSecond) })
    }) as never)
    b.on('update-downloaded', ((info: { version: string }) => {
      // Пользователь сам выбрал скачать: если не нажмёт «Перезапустить», поставится при выходе.
      b.autoInstallOnAppQuit = true
      this.set({ status: 'ready', version: info.version, percent: 100 })
    }) as never)
    b.on('error', ((e: Error) => this.onError(e)) as never)
  }

  getState(): UpdateState {
    return this.state
  }

  private set(next: Partial<UpdateState>): void {
    this.state = { ...this.state, ...next }
    this.emit('state', this.state)
  }

  private onError(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e)
    // electron-updater сообщает об ошибке дважды: событием и отказом промиса.
    const line = msg.split('\n')[0]
    if (line !== this.lastError) this.d.log?.(`[update] ${line.slice(0, 300)}`)
    this.lastError = line
    setTimeout(() => this.lastError === line && (this.lastError = ''), 2000)
    const wasDownloading = this.state.status === 'downloading'
    // В релизе нет latest.yml (старые релизы) или нет сети при автопроверке — не тревожим пользователя.
    if (!this.manual && !wasDownloading) return this.set({ status: this.state.version ? 'available' : 'idle' })
    this.set({ status: 'error', error: friendlyError(msg) })
  }

  /** Периодическая проверка в фоне (если включена в настройках). */
  start(): void {
    if (!this.d.backend || this.timer) return
    const tick = (): void => {
      if (this.d.autoCheck()) void this.check(false)
    }
    this.timer = setTimeout(() => {
      tick()
      this.timer = setInterval(tick, this.d.intervalMs ?? 6 * 3600_000)
    }, this.d.firstCheckMs ?? 30_000)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Проверка новой версии. Уже скачанное или скачиваемое обновление не перепроверяем. */
  check(manual = true): Promise<UpdateState> {
    const b = this.d.backend
    if (!b) return Promise.resolve(this.state)
    if (this.state.status === 'downloading' || this.state.status === 'ready') return Promise.resolve(this.state)
    if (this.checking) return this.checking
    this.manual = manual
    if (manual) this.set({ status: 'checking', error: undefined })
    this.checking = b
      .checkForUpdates()
      .catch((e: unknown) => this.onError(e))
      .then(() => {
        this.checking = null
        // checkForUpdates может завершиться без событий (например, в режиме разработки).
        if (this.state.status === 'checking') this.set({ status: 'latest' })
        this.set({ checkedAt: Date.now() })
        return this.state
      })
    return this.checking
  }

  /** Новая версия, которую стоит показать в интерфейсе (пропущенную — только после ручной проверки). */
  get offered(): string | undefined {
    const v = this.state.version
    if (!v || !newer(v, this.d.currentVersion)) return undefined
    if (this.state.status === 'available' && v === this.d.skipped() && !this.manual) return undefined
    return v
  }

  async download(): Promise<void> {
    const b = this.d.backend
    if (!b || (this.state.status !== 'available' && this.state.status !== 'error') || !this.state.version) return
    this.manual = true
    this.set({ status: 'downloading', percent: 0, error: undefined })
    await b.downloadUpdate().catch((e: unknown) => this.onError(e))
  }

  /** Закрыть Streamly и поставить обновление (тихо, в ту же папку) с автозапуском после установки. */
  async install(): Promise<void> {
    const b = this.d.backend
    if (!b || this.state.status !== 'ready') return
    this.d.log?.(`[update] installing ${this.state.version}`)
    await this.d.beforeInstall().catch((e: unknown) => this.d.log?.('[update] cleanup before install failed', e))
    b.quitAndInstall(true, true)
  }
}

function friendlyError(msg: string): string {
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|net::ERR_/i.test(msg)) return 'network'
  if (/latest\.yml|404|Cannot find/i.test(msg)) return 'noRelease'
  if (/sha512|checksum/i.test(msg)) return 'checksum'
  if (/ENOSPC/i.test(msg)) return 'disk'
  return 'other'
}
