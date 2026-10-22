import {
  app,
  BrowserWindow,
  clipboard,
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
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { EVENT_CHANNEL, IPC, type BridgeEvent, type BridgeEvents, type JoinDecision, type NavTarget } from '@shared/ipc'
import { inviteMessage } from '@shared/invite'
import type { InputPerms } from '@shared/perms'
import type { ClientState, DeepPartial, HostDisplay, HostState, Invite, RadminStatus, Settings } from '@shared/types'
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
/** Горячая клавиша хоста: забрать ввод у всех игроков и вернуть. */
const PAUSE_KEY = 'Alt+F12'

/** Адрес для отладки без Radmin (например, IP в обычной локальной сети). */
const DEV_IP = process.env.STREAMLY_DEV_IP
const EXTRA_ALLOWED = (process.env.STREAMLY_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean)

const vendorDir = app.isPackaged ? join(process.resourcesPath, 'vendor') : join(app.getAppPath(), 'vendor')
const lockFile = app.isPackaged ? join(process.resourcesPath, 'vendor.lock.json') : join(app.getAppPath(), 'vendor.lock.json')

/** SHA-256 установщика Apollo, закреплённый при сборке (scripts/fetch-vendor.mjs --pin). */
function expectedApolloHash(): string | undefined {
  try {
    return (JSON.parse(readFileSync(lockFile, 'utf8')) as { apollo?: { sha256?: string } }).apollo?.sha256
  } catch {
    return undefined
  }
}
/** Лог в %APPDATA%\Streamly\streamly.log (при запуске больше 1 МБ начинается заново). */
let logPath: string | null = null
let logWrites = 0
function log(msg: string, err?: unknown): void {
  const line = `${new Date().toISOString()} ${msg}${err ? ` ${err instanceof Error ? err.stack ?? err.message : String(err)}` : ''}`.slice(0, 4000)
  console.log(line)
  if (!logPath) return
  try {
    // Раз в 200 записей проверяем размер: лог не растёт бесконечно, даже если Streamly работает неделями.
    if (++logWrites % 200 === 0 && statSync(logPath).size > 2 * 1024 * 1024) renameSync(logPath, `${logPath}.old`)
    appendFileSync(logPath, line + '\n')
  } catch {
    /* лог не критичен */
  }
}

// Необработанная ошибка не должна молча ронять основной процесс (а с ним хостинг друзей).
process.on('uncaughtException', (e) => log('uncaught exception', e))
process.on('unhandledRejection', (e) => log('unhandled rejection', e))
function initLog(dir: string): void {
  logPath = join(dir, 'streamly.log')
  try {
    if (statSync(logPath).size > 1024 * 1024) rmSync(logPath)
  } catch {
    /* файла ещё нет */
  }
  log(`=== Streamly ${app.getVersion()} started, packaged=${app.isPackaged}`)
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
const OVERLAY_KEY = 'Alt+F2'
/**
 * Запасное сочетание: когда Moonlight перехватывает системные клавиши (полный экран), его хук клавиатуры
 * съедает Alt, и Alt+F2 до Windows может не дойти. Ctrl и Shift он пропускает.
 */
const OVERLAY_KEY_ALT = 'Ctrl+Shift+F2'
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
  win?.webContents.send(EVENT_CHANNEL, event, payload)
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(EVENT_CHANNEL, event, payload)
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
  host.on('state', (s: HostState) => {
    broadcast('hostState', s)
    const sig = `${s.phase} ${s.error ?? ''} players=${s.players.map((p) => `${p.nickname}:${p.status}`).join(',')} requests=${s.requests.length}`
    if (sig !== lastHost) log(`[host] ${sig}${s.errorDetail ? ` (${s.errorDetail})` : ''}`)
    lastHost = sig
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
  // Пауза управления у всех — горячей клавишей, пока идёт хостинг.
  let pauseKeyOn = false
  host.on('state', (s: HostState) => {
    const want = s.phase === 'running'
    if (want && !pauseKeyOn) {
      pauseKeyOn = globalShortcut.register(PAUSE_KEY, () => void host.setInputPaused(!host.getState().inputPaused))
      if (!pauseKeyOn) log(`[host] ${PAUSE_KEY} is taken by another program`)
    } else if (!want && pauseKeyOn) {
      globalShortcut.unregister(PAUSE_KEY)
      pauseKeyOn = false
    }
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
  client.on('streamProcess', () => {
    applyVolume()
    // Меню создаём заранее, чтобы по Alt+F2 оно открывалось сразу.
    overlay ??= createOverlay()
  })

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
    o.focus()
    o.webContents.send(EVENT_CHANNEL, 'overlay', overlayPayload(true))
    // Ушли в другое окно (Alt+Tab, клик на другом мониторе): меню закрывается само.
    o.once('blur', () => hideOverlay(false))
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
  // Горячие клавиши меню регистрируются при входе в игру и снимаются при выходе (а не на каждое обновление состояния).
  let shortcutWanted = false
  const syncShortcut = (s: ClientState): void => {
    const want = s.phase === 'streaming' || s.phase === 'launching'
    if (want !== shortcutWanted) {
      shortcutWanted = want
      for (const key of [OVERLAY_KEY, OVERLAY_KEY_ALT]) {
        if (want) {
          if (!globalShortcut.register(key, toggleOverlay)) log(`[overlay] ${key} is taken by another program`)
        } else if (globalShortcut.isRegistered(key)) globalShortcut.unregister(key)
      }
    }
    if (s.phase !== 'streaming' && !s.restarting) hideOverlay(false)
  }
  client.on('state', syncShortcut)

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
          accelerator: PAUSE_KEY,
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
        { label: L('Меню игры', 'In-game menu'), accelerator: OVERLAY_KEY, click: () => toggleOverlay() },
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
  handle(IPC.openLogs, () => shell.openPath(dataDir))
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
  handle(IPC.copyDiagnostics, () => {
    let tail = ''
    try {
      tail = readFileSync(join(dataDir, 'streamly.log'), 'utf8').split(/\r?\n/).slice(-80).join('\n')
    } catch {
      /* лога нет */
    }
    const s = settings.get()
    const report = [
      `Streamly ${appVersion} · Windows ${process.getSystemVersion()} · Electron ${process.versions.electron}`,
      `Radmin: ${JSON.stringify(radmin)}`,
      `Moonlight: ${moonlight.available ? 'ok' : 'missing'} · Apollo bundled: ${installer.hasBundledInstaller}`,
      `Host: ${JSON.stringify({ ...host.getState(), players: host.getState().players.map((p) => ({ n: p.nickname, s: p.status, a: p.address })) })}`,
      `Client: ${JSON.stringify(client.getState())}`,
      `Stream settings: ${JSON.stringify(s.stream)}`,
      '--- streamly.log ---',
      tail
    ].join('\n')
    clipboard.writeText(report)
  })
  handle(IPC.setTitleBar, (dark: boolean) => {
    win?.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#e8eaf0' : '#1b1e27', height: 40 })
    win?.setBackgroundColor(dark ? DARK_BG : LIGHT_BG)
  })

  handle(IPC.hostGetState, () => host.getState())
  handle(IPC.hostStart, () => host.start())
  handle(IPC.hostInstall, () => host.install())
  handle(IPC.hostCredentials, (u: string, p: string) => host.submitCredentials(String(u), String(p)))
  handle(IPC.hostStop, () => host.stop())
  handle(IPC.hostRespond, (id: string, d: JoinDecision) => host.respond(id, d))
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
  win?.on('focus', () => stopBlink())
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
    void Promise.race([Promise.all([host.stop(), client.shutdown()]), new Promise((r) => setTimeout(r, 8000))]).finally(() => {
      // Помощник возвращает маршрутизацию звука и выходит, когда закрывается его ввод.
      helper.stop()
      app.exit(0)
    })
  })
})

// Окно может быть только спрятано в трей: выходим лишь по явному «Выход» или когда окно реально закрыто.
app.on('window-all-closed', () => app.quit())
