import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  safeStorage,
  screen,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type NativeImage
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync, readFileSync } from 'node:fs'
import { constants as osConstants, cpus, setPriority, totalmem } from 'node:os'
import { join } from 'node:path'
import { EVENT_CHANNEL, IPC, type BridgeEvent, type BridgeEvents, type JoinDecision, type NavTarget } from '@shared/ipc'
import { inviteMessage } from '@shared/invite'
import type { InputPerms } from '@shared/perms'
import type { ClientState, DeepPartial, HostDisplay, HostState, HotkeyName, HotkeyStatus, Invite, PadDeviceView, RadminStatus, Settings } from '@shared/types'
import { comboOf } from '@shared/hotkeys'
import { parseInviteLink } from '@shared/protocol'
import { SecretsService, SettingsService } from './settings'
import { JsonFile, type Cipher } from './store'
import { Helper, internetAdapter } from './services/helper/helper'
import { ApolloApi } from './services/apollo/api'
import { ApolloInstaller } from './services/apollo/installer'
import { HostController } from './services/host/controller'
import { ClientController } from './services/client/controller'
import { MoonlightRunner } from './services/moonlight/runner'
import { detectRadmin } from './services/net/radmin'
import { probeHosts, radminNeighbors } from './services/net/discovery'
import { diagnoseHost, probePort } from './services/net/diagnose'
import { UpdateService } from './services/update/updater'
import { DailyLog, LOG_RETENTION_DAYS, writeLogArchive, type ZipEntry } from './logger'

// Отдельный профиль позволяет запустить второй экземпляр на одном ПК (хост и клиент для отладки).
const profile = process.env.STREAMLY_PROFILE
if (profile) app.setPath('userData', `${app.getPath('userData')}-${profile.replace(/[^\w-]/g, '')}`)
const primaryInstance = !!profile || app.requestSingleInstanceLock()
if (!primaryInstance) {
  app.quit()
  process.exit(0)
}

// Ссылки streamly://join/... открывают Streamly (в установленной версии; установщик тоже регистрирует схему).
if (app.isPackaged) app.setAsDefaultProtocolClient('streamly')
/** Приглашение, с которым Streamly запустили (ссылка в аргументах), — отдаётся интерфейсу при старте. */
let pendingInvite: Invite | null = parseInviteLink(process.argv.join(' '))
/** Текст буфера обмена, приглашение из которого уже предлагали (чтобы не спрашивать дважды). */
let offeredClipboard = ''

/** Адрес для отладки без Radmin (например, IP в обычной локальной сети). */
const DEV_IP = process.env.STREAMLY_DEV_IP
const EXTRA_ALLOWED = (process.env.STREAMLY_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean)

const vendorDir = app.isPackaged ? join(process.resourcesPath, 'vendor') : join(app.getAppPath(), 'vendor')
const lockFile = app.isPackaged ? join(process.resourcesPath, 'vendor.lock.json') : join(app.getAppPath(), 'vendor.lock.json')

/** Версия Apollo в комплекте (из адреса в vendor.lock.json: …/v0.4.6/…). */
function bundledApolloVersion(): string | undefined {
  try {
    const url = (JSON.parse(readFileSync(lockFile, 'utf8')) as { apollo?: { url?: string } }).apollo?.url ?? ''
    return /\/v(\d+\.\d+\.\d+)\//.exec(url)?.[1]
  } catch {
    return undefined
  }
}

/** SHA-256 установщика Apollo, закреплённый при сборке (scripts/fetch-vendor.mjs --pin). */
function expectedApolloHash(): string | undefined {
  try {
    return (JSON.parse(readFileSync(lockFile, 'utf8')) as { apollo?: { sha256?: string } }).apollo?.sha256
  } catch {
    return undefined
  }
}
/**
 * Журнал работы: %APPDATA%\Streamly\logs\streamly-ГГГГ-ММ-ДД.log, хранится 14 дней.
 * Его можно сохранить одним архивом («Настройки → Общие → Журнал») и отправить для разбора.
 */
let journal: DailyLog | null = null
function log(msg: string, err?: unknown): void {
  const line = `${new Date().toISOString()} ${msg}${err ? ` ${err instanceof Error ? err.stack ?? err.message : String(err)}` : ''}`.slice(0, 4000)
  console.log(line)
  journal?.write(line, !!err || /error|fail|uncaught|crash/i.test(msg))
}

// Необработанная ошибка не должна молча ронять основной процесс (а с ним хостинг друзей).
process.on('uncaughtException', (e) => log('uncaught exception', e))
process.on('unhandledRejection', (e) => log('unhandled rejection', e))
function initLog(dir: string): void {
  journal = new DailyLog(join(dir, 'logs'), LOG_RETENTION_DAYS)
  journal.adoptLegacy(dir)
  log(`=== Streamly ${app.getVersion()} started, packaged=${app.isPackaged}`)
  // Сведения о ПК — для разбора проблем по журналу.
  log(
    `[system] Windows ${process.getSystemVersion()} · Electron ${process.versions.electron} · ${cpus()[0]?.model?.trim() ?? '?'} ×${cpus().length} · RAM ${Math.round(totalmem() / 2 ** 30)} GB · locale ${app.getLocale()}`
  )
}

let win: BrowserWindow | null = null
let radmin: RadminStatus = detectRadmin()
let quitting = false
let tray: Tray | null = null
/** Запуск из автозагрузки Windows: окно не показываем, Streamly ждёт в трее. */
const startHidden = process.argv.includes('--hidden')
const iconPath = join(app.getAppPath(), 'resources', 'icon.png')

function showWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Меню во время игры (Alt+F2): прозрачное окно поверх трансляции. */
let overlay: BrowserWindow | null = null
/** Меню хоста поверх игры (Alt+F3). */
let hostMenu: BrowserWindow | null = null
/** Плашка с запросами поверх игры: не забирает фокус у игры. */
let hostNotifyWin: BrowserWindow | null = null
/** Уведомления Windows держим, пока они на экране: иначе сборщик мусора может отвязать обработчик клика. */
const liveNotifications = new Set<Notification>()
function notify(body: string, onClick: () => void, silent = false): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: 'Streamly', body, silent })
  liveNotifications.add(n)
  const drop = (): void => void liveNotifications.delete(n)
  n.on('click', () => {
    drop()
    onClick()
  })
  n.on('close', drop)
  n.on('failed', drop)
  n.show()
  // Windows убирает уведомление в центр уведомлений: дольше держать ссылку незачем.
  setTimeout(drop, 60_000)
}

function broadcast<E extends BridgeEvent>(event: E, payload: BridgeEvents[E]): void {
  for (const w of [win, overlay, hostMenu, hostNotifyWin]) if (w && !w.isDestroyed()) w.webContents.send(EVENT_CHANNEL, event, payload)
}

/** Окна Streamly грузят один и тот же интерфейс; меню отличается только адресом (#overlay). */
function loadRenderer(w: BrowserWindow, hash?: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void w.loadURL(process.env.ELECTRON_RENDERER_URL + (hash ? `#${hash}` : ''))
  } else {
    void w.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }
}

function lockDown(w: BrowserWindow): void {
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  w.webContents.on('will-redirect', (e) => e.preventDefault())
  w.webContents.on('will-attach-webview', (e) => e.preventDefault())
}

/**
 * Значок трея с точкой-уведомлением (запрос на подключение): рисуем поверх обычного значка,
 * чтобы не возить отдельные картинки. Две плотности — для обычных и HiDPI-экранов.
 */
function badgeIcon(base: NativeImage): NativeImage {
  const out = nativeImage.createEmpty()
  for (const [size, scale] of [
    [16, 1],
    [32, 2]
  ] as const) {
    const img = base.resize({ width: size, height: size, quality: 'best' })
    const buf = Buffer.from(img.toBitmap())
    const r = size * 0.24
    const cx = size - r - 0.5
    const cy = size - r - 0.5
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        if (d > r + 1.2 * scale) continue
        const i = (y * size + x) * 4
        // Белая обводка вокруг красной точки, чтобы её было видно и на тёмной, и на светлой панели задач.
        const [b, g, rr] = d <= r ? [0x57, 0x47, 0xff] : [0xff, 0xff, 0xff]
        buf[i] = b
        buf[i + 1] = g
        buf[i + 2] = rr
        buf[i + 3] = 0xff
      }
    }
    out.addRepresentation({ scaleFactor: scale, width: size, height: size, buffer: nativeImage.createFromBitmap(buf, { width: size, height: size }).toPNG() })
  }
  return out
}

const DARK_BG = '#0e1015'
const LIGHT_BG = '#f5f6fa'

function createWindow(settings: Settings): void {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors)
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 860,
    minHeight: 600,
    show: false,
    title: 'Streamly',
    backgroundColor: dark ? DARK_BG : LIGHT_BG,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#e8eaf0' : '#1b1e27', height: 40 },
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => {
    if (!startHidden) win?.show()
  })
  lockDown(win)
  loadRenderer(win)
  // Окно действительно закрыто (не спрятано в трей): выходим. Скрытое меню Alt+F2 иначе держало бы
  // Streamly живым без окна — ни «Открыть», ни повторный запуск ничего бы не показали.
  win.on('closed', () => {
    win = null
    if (!quitting) app.quit()
  })
}

function createOverlay(): BrowserWindow {
  const o = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'Streamly',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // Уровень выше полноэкранных окон: меню видно поверх Moonlight.
  o.setAlwaysOnTop(true, 'screen-saver')
  lockDown(o)
  loadRenderer(o, 'overlay')
  o.on('closed', () => (overlay = null))
  return o
}

/** Окно поверх игры: прозрачное, без рамки, выше полноэкранных окон. */
function createTopWindow(hash: string, opts: { focusable: boolean }): BrowserWindow {
  const w = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: opts.focusable,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'Streamly',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  w.setAlwaysOnTop(true, 'screen-saver')
  lockDown(w)
  loadRenderer(w, hash)
  return w
}

void app.whenReady().then(() => {
  const dataDir = app.getPath('userData')
  initLog(dataDir)
  log(`[radmin] ${JSON.stringify(radmin)}`)
  const cipher: Cipher | undefined = safeStorage.isEncryptionAvailable()
    ? { encrypt: (t) => safeStorage.encryptString(t), decrypt: (b) => safeStorage.decryptString(b) }
    : undefined
  const settings = new SettingsService(dataDir, app.getLocale())
  const secrets = new SecretsService(dataDir, cipher)
  const appVersion = app.getVersion()

  const installer = new ApolloInstaller(join(vendorDir, 'apollo', 'Apollo-setup.exe'), process.execPath, expectedApolloHash())
  const apollo = new ApolloApi(() => secrets.get().apollo)
  const helper = new Helper(join(vendorDir, 'helper', 'StreamlyHelper.exe'), log)
  const host = new HostController({
    settings,
    secrets,
    apollo,
    installer,
    address: () => radmin.ip ?? DEV_IP,
    appVersion,
    extraAllowed: EXTRA_ALLOWED,
    displayMode: () => {
      const d = screen.getPrimaryDisplay()
      return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor), fps: Math.round(d.displayFrequency || 60) }
    },
    portOpen: async (h, p) => (await probePort(h, p, 1500)) === 'open',
    audio: helper,
    gpus: async () => (helper.available ? helper.gpus() : []),
    // Без помощника — «нет данных» (а не «геймпадов нет»): иначе свои геймпады хоста потом приписались бы игрокам.
    xinput: async () => (helper.available ? helper.xinput() : null),
    bundledApolloVersion: bundledApolloVersion(),
    sentBytes: async (address) => {
      if (!helper.available) return undefined
      return (await helper.netInfo()).find((a) => a.addresses.includes(address))?.sent
    },
    displaysCache: (() => {
      const file = new JsonFile<{ list: HostDisplay[] }>(join(dataDir, 'displays.json'), () => ({ list: [] }))
      return {
        get: () => (Array.isArray(file.get().list) ? file.get().list : []),
        set: (list: HostDisplay[]) => file.set({ list })
      }
    })(),
    log
  })

  const moonlight = new MoonlightRunner(join(vendorDir, 'moonlight', 'Moonlight.exe'), join(dataDir, 'moonlight'))
  const client = new ClientController({
    settings,
    secrets,
    moonlight,
    appVersion,
    nativeResolution: () => {
      const d = screen.getPrimaryDisplay()
      return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor), fps: Math.round(d.displayFrequency || 60) }
    },
    probe: (targets, onFound) => probeHosts({ localIp: radmin.ip, targets, broadcast: !!radmin.ip, onFound }),
    neighbors: () => (radmin.ip ? radminNeighbors(radmin.ip) : Promise.resolve([])),
    moonlightLog: (since) => moonlight.logTail(since),
    wifi: async () => (helper.available ? !!internetAdapter(await helper.netInfo())?.wifi : false),
    isHung: async (pid) => (helper.available ? helper.hung(pid) : false),
    decoders: async () => {
      if (!helper.available) return undefined
      const caps = await helper.decoders()
      log(`hardware decoders: ${Object.entries(caps).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none found'}`)
      return caps
    },
    log
  })

  // ---------- Обновления через GitHub Releases (только в установленной версии) ----------
  const updates = new UpdateService({
    backend: app.isPackaged ? autoUpdater : null,
    currentVersion: appVersion,
    autoCheck: () => settings.get().updates.auto,
    skipped: () => settings.get().updates.skipped,
    beforeInstall: async () => {
      quitting = true
      globalShortcut.unregisterAll()
      await Promise.race([Promise.all([host.stop(), client.shutdown()]), new Promise((r) => setTimeout(r, 8000))])
      helper.stop()
    },
    log
  })
  // Только первая строка: ошибки electron-updater приходят с HTTP-заголовками и стеком. Ошибки пишет сам UpdateService.
  const updLog = (m: unknown): void => log(`[update] ${String(m).split('\n')[0].slice(0, 300)}`)
  autoUpdater.logger = { info: updLog, warn: updLog, error: () => undefined, debug: () => undefined }
  updates.on('state', (s) => broadcast('update', s))

  let lastHost = ''
  let hostPriorityHigh = false
  host.on('state', (s: HostState) => {
    broadcast('hostState', s)
    const sig = `${s.phase} ${s.error ?? ''} players=${s.players.map((p) => `${p.nickname}:${p.status}`).join(',')} requests=${s.requests.length}`
    if (sig !== lastHost) log(`[host] ${sig}${s.errorDetail ? ` (${s.errorDetail})` : ''}`)
    lastHost = sig
    // Пока идёт хостинг, Streamly отвечает на UDP-пинги игроков (слежение за перегрузкой канала): под нагрузкой
    // от игры обычный приоритет добавлял бы к ответам свою задержку, и игроки видели бы «забитый» канал.
    const wantHigh = s.phase === 'running'
    if (wantHigh !== hostPriorityHigh) {
      hostPriorityHigh = wantHigh
      try {
        setPriority(wantHigh ? osConstants.priority.PRIORITY_ABOVE_NORMAL : osConstants.priority.PRIORITY_NORMAL)
      } catch (e) {
        log('process priority', e)
      }
    }
  })
  host.on('joinRequest', ({ nickname }: { nickname: string }) => {
    attention('joinRequest')
    if (win?.isFocused() || !settings.get().host.notifyRequests) return
    const ru = settings.get().language === 'ru'
    // Свой звук уже сыграл интерфейс: уведомление Windows без звука, чтобы не было двух сигналов.
    notify(ru ? `${nickname} хочет подключиться` : `${nickname} wants to join`, showWindow, settings.get().host.requestSound)
  })
  // Вход по приглашению и просьбы об управлении: хост мог отвлечься на игру, поэтому уведомление Windows.
  const hostNotify = (ru: string, en: string, always = false): void => {
    if ((!always && win?.isFocused()) || !settings.get().host.notifyRequests) return
    notify(settings.get().language === 'ru' ? ru : en, showWindow)
  }
  host.on('inviteJoin', ({ nickname }: { nickname: string }) => hostNotify(`${nickname} вошёл по приглашению`, `${nickname} joined with your invite`))
  host.on('inputRequest', ({ nickname }: { nickname: string }) => {
    attention('inputRequest')
    hostNotify(`${nickname} просит управление`, `${nickname} asks for control`, true)
  })

  // В лог — только смена этапа или ошибки: замеры задержки каждые 3 с иначе вытесняют из отчёта всё полезное.
  let lastClient = ''
  client.on('state', (s: ClientState) => {
    broadcast('clientState', s)
    const sig = `${s.phase} host=${s.host?.address ?? '-'}${s.error ? ` error=${s.error}` : ''}${s.restarting ? ' restarting' : ''}${s.reconnecting ? ' reconnecting' : ''}${s.poorNetwork ? ' poor' : ''}`
    if (sig !== lastClient) log(`[client] ${sig}${s.errorDetail ? ` (${s.errorDetail})` : ''}`)
    lastClient = sig
  })
  client.on('hosts', (h) => broadcast('hosts', h))
  let prevSettings = settings.get()
  settings.on('change', (s: Settings) => {
    broadcast('settings', s)
    // Запись в реестр — только когда автозапуск действительно переключили.
    if (s.autostart !== prevSettings.autostart) app.setLoginItemSettings({ openAtLogin: s.autostart, args: ['--hidden'] })
    if (s.stream.volume !== prevSettings.stream.volume) applyVolume()
    if (s.stream.muteHostChat !== prevSettings.stream.muteHostChat) client.prefsChanged()
    prevSettings = s
    host.onSettingsChanged()
  })

  // ---------- Громкость трансляции: звуковая сессия Moonlight появляется через несколько секунд после запуска ----------
  let volumeTimer: NodeJS.Timeout | null = null
  const applyVolume = (attempt = 0): void => {
    if (volumeTimer) clearTimeout(volumeTimer)
    volumeTimer = null
    const pid = client.streamPid
    if (!pid || !helper.available) return
    helper
      .setVolume(pid, settings.get().stream.volume / 100)
      .then((found) => {
        if (found === 0 && attempt < 30) volumeTimer = setTimeout(() => applyVolume(attempt + 1), 1500)
      })
      .catch((e: unknown) => log('[helper] volume failed', e instanceof Error ? e.message : e))
  }
  // ---------- Геймпады глазами Moonlight (его SDL3 и база раскладок) ----------
  const sdlPath = join(vendorDir, 'moonlight', 'SDL3.dll')
  const padDb = join(vendorDir, 'moonlight', 'gamecontrollerdb.txt')
  const listPads = async (): Promise<PadDeviceView[] | null> => {
    if (!helper.available || !existsSync(sdlPath)) return null
    const maps = settings.get().stream.padMappings
    const list = await helper.pads(sdlPath, padDb, Object.values(maps))
    return list.map((p) => ({ guid: p.guid, name: p.name, gamepad: p.gamepad, custom: !!maps[p.guid] }))
  }
  /** Про геймпад без раскладки говорим один раз за запуск Streamly: Moonlight его не передаёт хосту. */
  const padsWarned = new Set<string>()
  const checkPads = async (): Promise<void> => {
    const list = await listPads().catch(() => null)
    const missing = (list ?? []).filter((p) => !p.gamepad && !padsWarned.has(p.guid))
    if (!missing.length) return
    missing.forEach((p) => padsWarned.add(p.guid))
    const names = missing.map((p) => p.name || '?')
    log(`[pads] Moonlight does not know these gamepads: ${names.join(', ')}`)
    broadcast('padsWarning', { names })
    const ru = settings.get().language === 'ru'
    notify(
      ru
        ? `Moonlight не видит геймпад «${names[0]}». Настройте его кнопки: Настройки → Трансляция → Геймпады.`
        : `Moonlight doesn't see the gamepad "${names[0]}". Set up its buttons: Settings → Stream → Gamepads.`,
      () => navigate('settings')
    )
  }

  client.on('streamProcess', () => {
    applyVolume()
    // Список геймпадов Moonlight собирает при запуске: проверяем, не остался ли какой-то без раскладки.
    setTimeout(() => void checkPads(), 4000)
    // Меню создаём заранее, чтобы по Alt+F2 оно открывалось сразу.
    overlay ??= createOverlay()
  })

  // ---------- Окна поверх игры ----------
  /**
   * Окно поверх игры: «поверх всех» заново (игра в окне «без рамки» тоже бывает поверх всех и поднимает себя)
   * и, если нужно, активным. Electron сам часто не может забрать фокус у игры (Windows отдаёт его только процессу,
   * от которого пришёл последний ввод): это делает помощник.
   */
  const raise = (w: BrowserWindow, activate: boolean): void => {
    if (w.isDestroyed()) return
    w.setAlwaysOnTop(true, 'screen-saver')
    w.moveTop()
    if (activate) w.focus()
    if (!helper.available) return
    const hwnd = Number(w.getNativeWindowHandle().readBigUInt64LE(0))
    void helper
      .raise(hwnd, activate)
      .then((ok) => {
        if (w.isDestroyed() || !activate) return
        w.focus()
        w.webContents.focus()
        if (!ok) log('[overlay] Windows did not let the window come to the front')
      })
      .catch(() => undefined)
  }
  /**
   * Окно поверх игры закрывается, когда фокус ушёл (Alt+Tab, клик в другое окно). В первую секунду игра может
   * забрать фокус обратно сама — тогда один раз поднимаем окно снова, а не закрываем его сразу после открытия.
   */
  const closeOnBlur = (w: BrowserWindow, close: () => void): void => {
    const shownAt = Date.now()
    let retried = false
    w.removeAllListeners('blur')
    w.on('blur', () => {
      if (!retried && Date.now() - shownAt < 1000) {
        retried = true
        raise(w, true)
        return
      }
      w.removeAllListeners('blur')
      close()
    })
  }

  // ---------- Меню во время игры (Alt+F2) ----------
  const overlayPayload = (open: boolean): BridgeEvents['overlay'] => ({ open, screens: screen.getAllDisplays().length })
  const showOverlay = async (): Promise<void> => {
    const pid = client.streamPid
    if (!pid) return
    // Меню открывается на том мониторе, где окно трансляции.
    let bounds = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds
    // Помощник может быть занят (WMI, звук): меню не должно ждать дольше полсекунды.
    const rect = helper.available
      ? await Promise.race([helper.windowRect(pid).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 500))])
      : null
    if (rect && rect.width > 0) bounds = screen.getDisplayMatching(screen.screenToDipRect(null, rect)).bounds
    overlay ??= createOverlay()
    const o = overlay
    o.setBounds(bounds)
    o.show()
    raise(o, true)
    o.webContents.send(EVENT_CHANNEL, 'overlay', overlayPayload(true))
    // Ушли в другое окно (Alt+Tab, клик на другом мониторе): меню закрывается само.
    closeOnBlur(o, () => hideOverlay(false))
  }
  const hideOverlay = (backToGame: boolean): void => {
    const o = overlay
    if (!o || o.isDestroyed() || !o.isVisible()) return
    o.webContents.send(EVENT_CHANNEL, 'overlay', overlayPayload(false))
    o.removeAllListeners('blur')
    o.hide()
    const pid = client.streamPid
    if (backToGame && pid && helper.available) void helper.focus(pid).catch(() => undefined)
  }
  const toggleOverlay = (): void => {
    if (overlay?.isVisible()) hideOverlay(true)
    else void showOverlay().catch((e: unknown) => log('[overlay] show failed', e))
  }
  client.on('state', (s: ClientState) => {
    if (s.phase !== 'streaming' && !s.restarting) hideOverlay(false)
  })

  // ---------- Меню хоста поверх игры ----------
  const showHostMenu = (): void => {
    if (host.getState().phase !== 'running') return
    if (!hostMenu || hostMenu.isDestroyed()) {
      hostMenu = createTopWindow('hostmenu', { focusable: true })
      hostMenu.on('closed', () => (hostMenu = null))
    }
    const m = hostMenu
    // На мониторе, где сейчас курсор (там, где хост играет).
    m.setBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds)
    const open = (): void => {
      hostMenuLoading = false
      m.show()
      raise(m, true)
      m.webContents.send(EVENT_CHANNEL, 'hostMenu', { open: true })
      closeOnBlur(m, () => hideHostMenu())
      syncHostNotify()
    }
    if (m.webContents.isLoading()) {
      // Повторные нажатия, пока меню загружается, не добавляют обработчиков.
      if (hostMenuLoading) return
      hostMenuLoading = true
      m.webContents.once('did-finish-load', open)
    } else open()
  }
  let hostMenuLoading = false
  const hideHostMenu = (): void => {
    const m = hostMenu
    if (!m || m.isDestroyed() || !m.isVisible()) return
    m.webContents.send(EVENT_CHANNEL, 'hostMenu', { open: false })
    m.removeAllListeners('blur')
    m.hide()
    // Меню закрыто — плашка с запросами снова на месте.
    syncHostNotify()
  }
  const toggleHostMenu = (): void => (hostMenu?.isVisible() ? hideHostMenu() : showHostMenu())

  // ---------- Плашка запросов поверх игры (не забирает фокус) ----------
  let notifyHeight = 120
  const placeNotify = (w: BrowserWindow): void => {
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const width = 400
    w.setBounds({ x: wa.x + wa.width - width - 16, y: wa.y + 16, width, height: notifyHeight })
  }
  const syncHostNotify = (): void => {
    const hs = host.getState()
    const pending = hs.requests.length > 0 || hs.players.some((p) => !!p.inputRequest)
    const appVisible = !!win && win.isVisible() && win.isFocused()
    const want = settings.get().host.gameNotify && hs.phase === 'running' && pending && !appVisible && !hostMenu?.isVisible()
    if (!want) {
      if (hostNotifyWin && !hostNotifyWin.isDestroyed() && hostNotifyWin.isVisible()) hostNotifyWin.hide()
      if (notifyKeepTop) clearInterval(notifyKeepTop)
      notifyKeepTop = null
      return
    }
    if (!hostNotifyWin || hostNotifyWin.isDestroyed()) {
      const w = createTopWindow('hostnotify', { focusable: false })
      hostNotifyWin = w
      w.on('closed', () => (hostNotifyWin = null))
      w.webContents.once('did-finish-load', () => syncHostNotify())
      return
    }
    if (hostNotifyWin.webContents.isLoading()) return
    if (!hostNotifyWin.isVisible()) {
      placeNotify(hostNotifyWin)
      hostNotifyWin.showInactive()
      const w = hostNotifyWin
      raise(w, false)
      // Игра может снова встать «поверх всех»: пока плашка видна, поднимаем её (без фокуса).
      if (notifyKeepTop) clearInterval(notifyKeepTop)
      notifyKeepTop = setInterval(() => {
        if (w.isDestroyed() || !w.isVisible()) {
          if (notifyKeepTop) clearInterval(notifyKeepTop)
          notifyKeepTop = null
          return
        }
        raise(w, false)
      }, 2000)
    }
  }
  let notifyKeepTop: NodeJS.Timeout | null = null
  host.on('state', syncHostNotify)

  // ---------- Горячие клавиши (настраиваются в «Настройки → Общие») ----------
  const inGame = (): boolean => ['streaming', 'launching'].includes(client.getState().phase)
  const hosting = (): boolean => host.getState().phase === 'running'
  const pendingFirst = (): { request?: string; input?: string } => {
    const hs = host.getState()
    return { request: hs.requests[0]?.id, input: hs.players.find((p) => p.inputRequest)?.deviceId }
  }
  const bindings: { name: HotkeyName; active: () => boolean; run: () => void }[] = [
    { name: 'clientMenu', active: inGame, run: () => toggleOverlay() },
    { name: 'clientMenuAlt', active: inGame, run: () => toggleOverlay() },
    { name: 'hostMenu', active: hosting, run: toggleHostMenu },
    { name: 'hostPause', active: hosting, run: () => void host.setInputPaused(!host.getState().inputPaused) },
    // Разрешить и отклонить — только пока есть запросы: в остальное время эти клавиши остаются игре.
    {
      name: 'hostAllow',
      active: () => hosting() && !!(pendingFirst().request || pendingFirst().input),
      run: () => {
        const p = pendingFirst()
        if (p.request) void host.respond(p.request, 'allow')
        else if (p.input) void host.respondInput(p.input, true)
      }
    },
    {
      name: 'hostDeny',
      active: () => hosting() && !!(pendingFirst().request || pendingFirst().input),
      run: () => {
        const p = pendingFirst()
        if (p.request) void host.respond(p.request, 'deny')
        else if (p.input) void host.respondInput(p.input, false)
      }
    }
  ]
  const registered = new Map<HotkeyName, string>()
  const hotkeyStatus = {} as Record<HotkeyName, HotkeyStatus>
  let hotkeySig = ''
  /** Сочетание свободно? Пробуем занять и сразу отпускаем (своё уже занятое — свободно). */
  const probe = (acc: string): boolean => {
    if ([...registered.values()].includes(acc)) return true
    try {
      if (!globalShortcut.register(acc, () => undefined)) return false
      globalShortcut.unregister(acc)
      return true
    } catch {
      return false
    }
  }
  let hotkeysSuspended = false
  /**
   * Горячие клавиши ловит помощник (перехват клавиатуры). Системные (RegisterHotKey, globalShortcut Electron) не видят
   * сочетаний, пока Moonlight захватил клавиатуру (он съедает Alt и Ctrl и отправляет сочетание хосту), и у хоста
   * срабатывали бы от клавиш игроков, которые вводит Apollo. Без помощника — системные.
   */
  const viaHelper = helper.available
  let helperHotkeySig = ''
  const syncHelperHotkeys = (): void => {
    const keys = settings.get().hotkeys
    const combos: string[] = []
    for (const b of bindings) {
      const acc = keys[b.name]
      const combo = acc ? comboOf(acc) : null
      const active = !hotkeysSuspended && !!combo && b.active()
      hotkeyStatus[b.name] = !acc ? 'off' : active ? 'ok' : 'idle'
      if (active) combos.push(`${b.name}:${combo}`)
    }
    const sig = combos.join(',')
    if (sig !== helperHotkeySig) {
      helperHotkeySig = sig
      void helper.setHotkeys(combos).catch((e: unknown) => log('[hotkeys] helper', e instanceof Error ? e.message : e))
    }
    const st = JSON.stringify(hotkeyStatus)
    if (st !== hotkeySig) {
      hotkeySig = st
      broadcast('hotkeys', { ...hotkeyStatus })
    }
  }
  helper.on('hotkey', (id: string) => {
    if (quitting || hotkeysSuspended) return
    bindings.find((b) => b.name === id && b.active())?.run()
  })
  const syncHotkeys = (reprobe = false): void => {
    if (quitting) return
    if (viaHelper) return syncHelperHotkeys()
    if (hotkeysSuspended) return
    const keys = settings.get().hotkeys
    for (const b of bindings) {
      const acc = keys[b.name]
      const cur = registered.get(b.name)
      const want = !!acc && b.active()
      if (cur && (cur !== acc || !want)) {
        globalShortcut.unregister(cur)
        registered.delete(b.name)
      }
      if (!acc) {
        hotkeyStatus[b.name] = 'off'
        continue
      }
      if (want && !registered.has(b.name)) {
        let ok = false
        try {
          ok = globalShortcut.register(acc, b.run)
        } catch {
          ok = false
        }
        if (ok) registered.set(b.name, acc)
        else if (hotkeyStatus[b.name] !== 'taken') log(`[hotkeys] ${acc} (${b.name}) is taken by another program`)
        hotkeyStatus[b.name] = ok ? 'ok' : 'taken'
      } else if (!want && (reprobe || !hotkeyStatus[b.name] || hotkeyStatus[b.name] === 'ok' || hotkeyStatus[b.name] === 'off')) {
        // Пока не нужна (нет игры или хостинга): проверяем, не занята ли другой программой.
        hotkeyStatus[b.name] = probe(acc) ? 'idle' : 'taken'
      }
    }
    const sig = JSON.stringify(hotkeyStatus)
    if (sig !== hotkeySig) {
      hotkeySig = sig
      broadcast('hotkeys', { ...hotkeyStatus })
    }
  }
  host.on('state', () => syncHotkeys())
  client.on('state', () => syncHotkeys())
  let prevHotkeys = JSON.stringify(settings.get().hotkeys)
  settings.on('change', (s: Settings) => {
    const next = JSON.stringify(s.hotkeys)
    if (next !== prevHotkeys) {
      prevHotkeys = next
      syncHotkeys(true)
    }
    syncHostNotify()
  })
  syncHotkeys(true)

  // ---------- Трей: Streamly продолжает хостить или держать стрим, когда окно закрыто ----------
  const navigate = (to: NavTarget): void => {
    showWindow()
    win?.webContents.send(EVENT_CHANNEL, 'navigate', to)
  }
  const copyInvite = (): void => {
    const inv = host.createInvite()
    const hs = host.getState()
    if (!inv || !hs.address) return
    clipboard.writeText(inviteMessage(settings.get().language, { name: hs.hostName, address: hs.address, link: inv.link }))
    trayBalloon(settings.get().language === 'ru' ? 'Приглашение скопировано — отправьте его друзьям' : 'Invite copied — send it to your friends')
  }
  const trayBalloon = (content: string): void => notify(content, showWindow, true)
  const updateTray = (): void => {
    if (!tray) return
    const ru = settings.get().language === 'ru'
    const L = (r: string, e: string): string => (ru ? r : e)
    const hs = host.getState()
    const cs = client.getState()
    const us = updates.getState()
    const hosting = hs.phase === 'running'
    const inSession = ['connecting', 'waitingApproval', 'pairing', 'launching', 'streaming'].includes(cs.phase)
    const items: MenuItemConstructorOptions[] = []
    // Запросы и просьбы — прямо из трея, не открывая окно.
    for (const r of hs.requests) {
      items.push({
        label: L(`${r.nickname} хочет подключиться`, `${r.nickname} wants to join`),
        submenu: [
          { label: L('Разрешить', 'Allow'), click: () => void host.respond(r.id, 'allow') },
          { label: L('Разрешить и доверять', 'Allow and trust'), click: () => void host.respond(r.id, 'trust') },
          { label: L('Отклонить', 'Deny'), click: () => void host.respond(r.id, 'deny') }
        ]
      })
    }
    for (const p of hs.players.filter((x) => x.inputRequest)) {
      items.push({
        label: L(`${p.nickname} просит управление`, `${p.nickname} asks for control`),
        submenu: [
          { label: L('Выдать', 'Give'), click: () => void host.respondInput(p.deviceId, true) },
          { label: L('Отказать', 'Deny'), click: () => void host.respondInput(p.deviceId, false) }
        ]
      })
    }
    if (items.length) items.push({ type: 'separator' })
    if (hosting) {
      items.push(
        { label: L('Скопировать приглашение', 'Copy invite'), click: copyInvite },
        { label: L(`Скопировать адрес (${hs.address ?? ''})`, `Copy address (${hs.address ?? ''})`), enabled: !!hs.address, click: () => clipboard.writeText(hs.address ?? '') }
      )
      if (hs.players.length) {
        items.push({
          label: L('Игроки', 'Players'),
          submenu: hs.players.map((p) => ({
            label: p.nickname,
            submenu: [
              { label: L('Переподключить геймпад', 'Reconnect gamepad'), click: () => void host.resetGamepad(p.deviceId) },
              { label: L('Отключить', 'Disconnect'), click: () => void host.kick(p.deviceId) }
            ]
          }))
        })
      }
      items.push(
        {
          label: hs.inputPaused ? L('Вернуть управление игрокам', 'Give control back') : L('Забрать управление у всех', 'Take control from everyone'),
          accelerator: settings.get().hotkeys.hostPause || undefined,
          click: () => void host.setInputPaused(!hs.inputPaused)
        },
        { label: L('Остановить хост', 'Stop hosting'), click: () => void host.stop() }
      )
    } else if (!inSession && (hs.phase === 'idle' || hs.phase === 'error')) {
      items.push({ label: L('Стать хостом', 'Start hosting'), enabled: !!(radmin.connected || DEV_IP), click: () => (navigate('host'), void host.start()) })
      const recent = settings.get().recentHosts.slice(0, 5)
      items.push({
        label: L('Подключиться', 'Connect'),
        submenu: [
          ...recent.map((h) => ({ label: `${h.name} · ${h.address}`, click: () => (navigate('connect'), void client.connect(h.address)) })),
          ...(recent.length ? [{ type: 'separator' as const }] : []),
          { label: L('Найти хосты…', 'Find hosts…'), click: () => navigate('connect') }
        ]
      })
    }
    if (cs.phase === 'streaming') {
      items.push(
        { label: L('Меню игры', 'In-game menu'), accelerator: settings.get().hotkeys.clientMenu || undefined, click: () => toggleOverlay() },
        { label: L('Переподключить геймпад', 'Reconnect gamepad'), click: () => void client.resetGamepad() },
        { label: L('Перезапустить трансляцию', 'Restart stream'), click: () => void client.restartStream() }
      )
    }
    if (inSession) items.push({ label: cs.phase === 'streaming' ? L('Отключиться', 'Disconnect') : L('Отменить подключение', 'Cancel connecting'), click: () => void client.cancel() })
    const offered = updates.offered
    if (offered && (us.status === 'available' || us.status === 'downloading' || us.status === 'ready')) {
      items.push(
        { type: 'separator' },
        us.status === 'ready'
          ? { label: L(`Установить Streamly ${offered} и перезапустить`, `Install Streamly ${offered} and restart`), click: () => void updates.install() }
          : us.status === 'downloading'
            ? { label: L(`Загрузка обновления: ${us.percent ?? 0}%`, `Downloading update: ${us.percent ?? 0}%`), enabled: false }
            : { label: L(`Скачать обновление ${offered}`, `Download update ${offered}`), click: () => void updates.download() }
      )
    }
    const status = hosting
      ? L(`Хост · игроков: ${hs.players.length}`, `Hosting · players: ${hs.players.length}`)
      : cs.phase === 'streaming'
        ? L('В игре у ', 'Playing at ') + (cs.host?.name ?? '')
        : inSession
          ? L('Подключение…', 'Connecting…')
          : L('Не активен', 'Idle')
    tray.setToolTip(`Streamly — ${status}${hs.requests.length ? L(' · есть запросы', ' · join requests') : ''}`)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: status, enabled: false },
        { type: 'separator' },
        { label: L('Открыть Streamly', 'Open Streamly'), click: showWindow },
        ...items,
        { type: 'separator' },
        { label: L('Настройки', 'Settings'), click: () => navigate('settings') },
        { label: L('Проверить обновления', 'Check for updates'), click: () => (navigate('about'), void updates.check(true)) },
        { label: L('Выход', 'Quit'), click: () => app.quit() }
      ])
    )
    syncAttention()
  }

  const trayIcon = nativeImage.createFromPath(iconPath)
  const trayNormal = trayIcon.resize({ width: 16, height: 16 })
  const trayAlert = badgeIcon(trayIcon)
  tray = new Tray(trayNormal)
  tray.on('click', showWindow)
  // Состояние меняется часто (задержка, поток): пересобираем меню только при видимых изменениях.
  let traySig = ''
  const refreshTray = (): void => {
    const hs = host.getState()
    const cs = client.getState()
    const us = updates.getState()
    const sig = JSON.stringify([
      settings.get().language,
      hs.phase,
      hs.address,
      hs.inputPaused,
      hs.requests.map((r) => r.id),
      hs.players.map((p) => [p.deviceId, p.nickname, !!p.inputRequest]),
      cs.phase,
      cs.host?.name,
      us.status,
      us.status === 'downloading' ? Math.floor((us.percent ?? 0) / 10) : 0,
      updates.offered,
      settings.get().recentHosts.map((h) => h.address),
      radmin.connected
    ])
    if (sig === traySig) return
    traySig = sig
    updateTray()
  }
  // ---------- Внимание хоста: звук, мигание окна на панели задач и значка в трее ----------
  let blinkTimer: NodeJS.Timeout | null = null
  const needsAttention = (): boolean => {
    const hs = host.getState()
    return hs.requests.length > 0 || hs.players.some((p) => !!p.inputRequest)
  }
  const stopBlink = (): void => {
    if (blinkTimer) clearInterval(blinkTimer)
    blinkTimer = null
    if (tray && !tray.isDestroyed()) tray.setImage(trayNormal)
  }
  const attention = (kind: 'joinRequest' | 'inputRequest'): void => {
    if (settings.get().host.requestSound) win?.webContents.send(EVENT_CHANNEL, 'alert', { kind })
    if (win?.isFocused() && win.isVisible()) return
    win?.flashFrame(true)
    if (blinkTimer || !tray) return
    let on = false
    blinkTimer = setInterval(() => {
      on = !on
      tray?.setImage(on ? trayAlert : trayNormal)
    }, 650)
  }
  /** Запрос обработан (или отменён): мигание прекращается. */
  const syncAttention = (): void => {
    if (blinkTimer && !needsAttention()) {
      stopBlink()
      win?.flashFrame(false)
    }
  }

  refreshTray()
  host.on('state', refreshTray)
  client.on('state', refreshTray)
  settings.on('change', refreshTray)
  updates.on('state', refreshTray)

  setInterval(() => {
    const next = detectRadmin()
    if (JSON.stringify(next) !== JSON.stringify(radmin)) {
      radmin = next
      log(`[radmin] ${JSON.stringify(radmin)}`)
      broadcast('radmin', radmin)
    }
  }, 4000)

  const trusted = (e: IpcMainInvokeEvent): boolean => {
    const url = e.senderFrame?.url ?? ''
    return url.startsWith('file://') || (!!process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))
  }
  const handle = (channel: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, (e, ...args) => {
      if (!trusted(e)) throw new Error('untrusted sender')
      return fn(...(args as never[]))
    })
  }
  handle(IPC.getSettings, () => settings.get())
  handle(IPC.updateSettings, (patch: DeepPartial<Settings>) => settings.update(patch))
  handle(IPC.getRadmin, () => (radmin = detectRadmin()))
  handle(IPC.getAppInfo, () => ({
    version: appVersion,
    moonlightAvailable: moonlight.available,
    apolloBundled: installer.hasBundledInstaller,
    apolloInstalled: existsSync(join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Apollo', 'sunshine.exe')),
    platform: process.platform
  }))
  handle(IPC.openExternal, (url: string) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url)
  })
  handle(IPC.copyText, (text: string) => clipboard.writeText(String(text).slice(0, 2000)))
  handle(IPC.openLogs, () => shell.openPath(journal?.dir ?? dataDir))
  handle(IPC.getHotkeys, () => ({ ...hotkeyStatus }))
  handle(IPC.suspendHotkeys, (on: boolean) => {
    if (on === true) {
      hotkeysSuspended = true
      for (const acc of registered.values()) globalShortcut.unregister(acc)
      registered.clear()
      if (viaHelper) syncHotkeys()
    } else {
      hotkeysSuspended = false
      syncHotkeys(true)
    }
  })
  // Ошибки интерфейса — в журнал (не больше 30 в минуту, чтобы зациклившаяся ошибка его не забила).
  let rendererErrors: number[] = []
  handle(IPC.logError, (text: string) => {
    const now = Date.now()
    rendererErrors = rendererErrors.filter((t) => now - t < 60_000)
    if (rendererErrors.length >= 30) return
    rendererErrors.push(now)
    log(`[ui] error: ${String(text).slice(0, 2000)}`)
  })
  handle(IPC.exportLogs, async () => {
    if (!journal) return null
    const d = new Date()
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
    const parent = win && !win.isDestroyed() ? win : undefined
    const opts = {
      title: settings.get().language === 'ru' ? 'Сохранить журнал Streamly' : 'Save Streamly logs',
      defaultPath: join(app.getPath('desktop'), `streamly-logs-${stamp}.zip`),
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    }
    const res = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    const extra: ZipEntry[] = [{ name: 'report.txt', data: Buffer.from(diagnosticsReport(), 'utf8') }]
    try {
      extra.push({ name: 'moonlight-last.log', data: readFileSync(join(dataDir, 'moonlight', 'moonlight-last.log')) })
    } catch {
      /* Moonlight ещё не запускался */
    }
    // Лог Apollo — если этот ПК хостит (или хостил) и Apollo отвечает.
    const apolloLog = await Promise.race([apollo.getLogs().catch(() => ''), new Promise<string>((r) => setTimeout(() => r(''), 3000))])
    if (apolloLog) extra.push({ name: 'apollo.log', data: Buffer.from(apolloLog.slice(-2_000_000), 'utf8') })
    try {
      await writeLogArchive(res.filePath, journal, extra)
    } catch (e) {
      log('[logs] export failed', e)
      throw new Error('export failed')
    }
    log(`[logs] exported to ${res.filePath}`)
    shell.showItemInFolder(res.filePath)
    return res.filePath
  })
  handle(IPC.hostPassControl, (id: string) => host.passControl(String(id)))
  handle(IPC.hostSetSpectator, (id: string, on: boolean) => host.setSpectator(String(id), on === true))
  handle(IPC.hostMakePadFirst, (id: string) => host.makePadFirst(String(id)))
  handle(IPC.hostCloseMenu, () => hideHostMenu())
  handle(IPC.hostNotifyResize, (h: number) => {
    const height = Math.max(60, Math.min(600, Math.round(Number(h) || 0)))
    if (height === notifyHeight) return
    notifyHeight = height
    if (hostNotifyWin && !hostNotifyWin.isDestroyed()) placeNotify(hostNotifyWin)
  })
  handle(IPC.clientIdentifyPad, () => client.identifyPad())
  handle(IPC.padsList, () => listPads())
  handle(IPC.padsState, (guid: string) =>
    helper.available && existsSync(sdlPath) && /^[0-9a-f]{32}$/.test(String(guid)) ? helper.padState(sdlPath, padDb, String(guid)) : null
  )
  handle(IPC.padsClose, async () => {
    if (helper.available) await helper.padClose().catch(() => undefined)
  })
  handle(IPC.checkInvite, async () => {
    if (pendingInvite) {
      const inv = pendingInvite
      pendingInvite = null
      return inv
    }
    // Discord не делает ссылки streamly:// кликабельными: приглашение, скопированное в буфер, Streamly замечает сам.
    const text = String(await clipboard.readText()).slice(0, 2000)
    const inv = parseInviteLink(text)
    // Своё же приглашение (хост скопировал его друзьям) не предлагаем.
    if (!inv || text === offeredClipboard || inv.address === radmin.ip) return null
    offeredClipboard = text
    return inv
  })
  /** Отчёт для разбора проблем: версии, сеть, состояние (без паролей и токенов) и хвост журнала. */
  const diagnosticsReport = (): string => {
    const tail = journal?.tail(80) ?? ''
    const s = settings.get()
    return [
      `Streamly ${appVersion} · Windows ${process.getSystemVersion()} · Electron ${process.versions.electron}`,
      `Radmin: ${JSON.stringify(radmin)}`,
      `Moonlight: ${moonlight.available ? 'ok' : 'missing'} · Apollo bundled: ${installer.hasBundledInstaller}`,
      `Host: ${JSON.stringify({ ...host.getState(), players: host.getState().players.map((p) => ({ n: p.nickname, s: p.status, a: p.address })) })}`,
      `Client: ${JSON.stringify(client.getState())}`,
      `Stream settings: ${JSON.stringify(s.stream)}`,
      `Hotkeys: ${JSON.stringify(s.hotkeys)} ${JSON.stringify(hotkeyStatus)}`,
      '--- streamly log ---',
      tail
    ].join('\n')
  }
  handle(IPC.copyDiagnostics, () => clipboard.writeText(diagnosticsReport()))
  handle(IPC.setTitleBar, (dark: boolean) => {
    win?.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#e8eaf0' : '#1b1e27', height: 40 })
    win?.setBackgroundColor(dark ? DARK_BG : LIGHT_BG)
  })

  handle(IPC.hostGetState, () => host.getState())
  handle(IPC.hostStart, () => host.start())
  handle(IPC.hostInstall, () => host.install())
  handle(IPC.hostCredentials, (u: string, p: string) => host.submitCredentials(String(u), String(p)))
  handle(IPC.hostStop, () => host.stop())
  handle(IPC.hostRespond, (id: string, d: JoinDecision) => {
    if (!['allow', 'trust', 'deny', 'spectate'].includes(d)) return
    return host.respond(String(id), d)
  })
  handle(IPC.hostSetPerms, (id: string, p: Partial<InputPerms>) => host.setPerms(id, p ?? {}))
  handle(IPC.hostKick, (id: string) => host.kick(id))
  handle(IPC.hostKickAll, () => host.kickAll())
  handle(IPC.hostInstallGamepad, () => host.installGamepadDriver())
  handle(IPC.hostSelfCheck, () => host.selfCheck())
  handle(IPC.hostListTrusted, () => host.listTrusted())
  handle(IPC.hostRemoveTrusted, (id: string) => host.removeTrusted(id))
  handle(IPC.hostListDisplays, () => host.listDisplays())

  handle(IPC.clientGetState, () => client.getState())
  handle(IPC.clientDiscover, () => client.discover())
  handle(IPC.clientGetHosts, () => client.getHosts())
  handle(IPC.clientConnect, (address: string, inviteCode?: string) =>
    client.connect(String(address), { inviteCode: typeof inviteCode === 'string' && /^[\w-]{8,64}$/.test(inviteCode) ? inviteCode : undefined })
  )
  handle(IPC.clientRequestInput, (perms: Partial<InputPerms>) =>
    client.requestInput({ keyboard: perms?.keyboard === true, mouse: perms?.mouse === true, gamepad: perms?.gamepad === true })
  )
  handle(IPC.hostCreateInvite, () => host.createInvite())
  handle(IPC.hostRespondInput, (id: string, grant: boolean) => host.respondInput(String(id), grant === true))
  handle(IPC.hostSetInputPaused, (paused: boolean) => host.setInputPaused(paused === true))
  handle(IPC.hostResetGamepad, (id: string) => host.resetGamepad(String(id)))
  handle(IPC.clientResetGamepad, () => client.resetGamepad())
  handle(IPC.updateGetState, () => updates.getState())
  handle(IPC.updateCheck, () => updates.check(true))
  handle(IPC.updateDownload, () => updates.download())
  handle(IPC.updateInstall, () => updates.install())
  handle(IPC.updateSkip, (version: string) => {
    if (typeof version === 'string') settings.update({ updates: { skipped: version } })
  })
  handle(IPC.overlayToggleStats, async () => {
    const pid = client.streamPid
    if (!pid || !helper.available) return false
    // Статистику показывает сам Moonlight (Ctrl+Alt+Shift+S): возвращаем ему фокус и нажимаем сочетание.
    hideOverlay(false)
    return helper.sendKeys(pid, ['ctrl', 'alt', 'shift', 's']).catch(() => false)
  })
  handle(IPC.clientDiagnose, async (address: string) => {
    const a = String(address).trim()
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return { target: a, items: [], summary: 'badAddress' }
    const report = await diagnoseHost(a, { radmin: (radmin = detectRadmin()), moonlightAvailable: moonlight.available })
    log(`[diag] ${a}: ${report.summary} ${report.items.map((i) => `${i.id}=${i.status}${i.value ? `(${i.value})` : ''}`).join(' ')}`)
    return report
  })
  handle(IPC.clientCancel, () => client.cancel())
  handle(IPC.clientReset, () => client.reset())
  handle(IPC.clientSetSelfOff, (patch: Partial<InputPerms>) => {
    const clean: Partial<InputPerms> = {}
    for (const k of ['keyboard', 'mouse', 'gamepad'] as const) if (typeof patch?.[k] === 'boolean') clean[k] = patch[k]
    client.setSelfOff(clean)
  })
  handle(IPC.clientRestartStream, () => client.restartStream())
  handle(IPC.overlayClose, () => hideOverlay(true))
  handle(IPC.overlayOtherScreen, async () => {
    const pid = client.streamPid
    if (!pid || !helper.available) return false
    // Сначала курсор и фокус уходят на другой монитор (пока меню активно, Windows разрешает сменить окно),
    // потом меню прячется. Наоборот нельзя: скрытое меню вернуло бы фокус Moonlight, и он снова захватил бы мышь.
    const moved = await helper.cursorToOtherScreen(pid).catch(() => false)
    hideOverlay(false)
    return moved
  })

  createWindow(settings.get())
  // Окно стало активным: хост увидел запрос, мигание значка в трее больше не нужно.
  win?.on('focus', () => {
    stopBlink()
    syncHostNotify()
  })
  win?.on('blur', () => syncHostNotify())
  win?.on('hide', () => syncHostNotify())
  updates.start()
  // Крестик: если идёт хостинг или трансляция, по умолчанию прячем окно в трей, а не выходим.
  win?.on('session-end', () => {
    log('windows session ending: locking down')
    void host.stop()
  })
  win?.on('close', (e) => {
    if (quitting || !settings.get().closeToTray) return
    const busy = host.getState().phase === 'running' || ['launching', 'streaming', 'pairing', 'waitingApproval', 'connecting'].includes(client.getState().phase)
    if (!busy) return
    e.preventDefault()
    win?.hide()
  })
  // Если прошлый запуск завершился аварийно, у друзей в Apollo могли остаться права.
  // Режим хоста при старте включаем уже после этой блокировки.
  void host.lockdownOnBoot().then(() => {
    if (settings.get().host.autoStartHosting && (radmin.connected || DEV_IP)) void host.start()
  })

  app.on('second-instance', (_e, argv) => {
    showWindow()
    const inv = parseInviteLink(argv.join(' '))
    if (inv) broadcast('invite', inv)
  })

  // Перед выходом снимаем права у всех и закрываем стримы.
  app.on('before-quit', (e) => {
    if (quitting) return
    e.preventDefault()
    quitting = true
    globalShortcut.unregisterAll()
    registered.clear()
    void Promise.race([Promise.all([host.stop(), client.shutdown()]), new Promise((r) => setTimeout(r, 8000))]).finally(() => {
      // Помощник возвращает маршрутизацию звука и выходит, когда закрывается его ввод.
      helper.stop()
      app.exit(0)
    })
  })
})

// Окно может быть только спрятано в трей: выходим лишь по явному «Выход» или когда окно реально закрыто.
app.on('window-all-closed', () => app.quit())
