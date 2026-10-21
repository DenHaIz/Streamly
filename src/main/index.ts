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
  type IpcMainInvokeEvent
} from 'electron'
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { EVENT_CHANNEL, IPC, type BridgeEvent, type BridgeEvents, type JoinDecision } from '@shared/ipc'
import type { InputPerms } from '@shared/perms'
import type { ClientState, DeepPartial, HostDisplay, HostState, RadminStatus, Settings } from '@shared/types'
import { SecretsService, SettingsService } from './settings'
import { JsonFile, type Cipher } from './store'
import { Helper } from './services/helper/helper'
import { ApolloApi } from './services/apollo/api'
import { ApolloInstaller } from './services/apollo/installer'
import { HostController } from './services/host/controller'
import { ClientController } from './services/client/controller'
import { MoonlightRunner } from './services/moonlight/runner'
import { detectRadmin } from './services/net/radmin'
import { probeHosts, radminNeighbors } from './services/net/discovery'
import { diagnoseHost, probePort } from './services/net/diagnose'

// Отдельный профиль позволяет запустить второй экземпляр на одном ПК (хост и клиент для отладки).
const profile = process.env.STREAMLY_PROFILE
if (profile) app.setPath('userData', `${app.getPath('userData')}-${profile.replace(/[^\w-]/g, '')}`)
const primaryInstance = !!profile || app.requestSingleInstanceLock()
if (!primaryInstance) {
  app.quit()
  process.exit(0)
}

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
  win.on('closed', () => (win = null))
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
      return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
    },
    probe: (targets, onFound) => probeHosts({ localIp: radmin.ip, targets, broadcast: !!radmin.ip, onFound }),
    neighbors: () => (radmin.ip ? radminNeighbors(radmin.ip) : Promise.resolve([])),
    moonlightLog: (since) => moonlight.logTail(since),
    log
  })

  let lastHost = ''
  host.on('state', (s: HostState) => {
    broadcast('hostState', s)
    const sig = `${s.phase} ${s.error ?? ''} players=${s.players.map((p) => `${p.nickname}:${p.status}`).join(',')} requests=${s.requests.length}`
    if (sig !== lastHost) log(`[host] ${sig}${s.errorDetail ? ` (${s.errorDetail})` : ''}`)
    lastHost = sig
  })
  host.on('joinRequest', ({ nickname }: { nickname: string }) => {
    if (win?.isFocused() || !settings.get().host.notifyRequests) return
    win?.flashFrame(true)
    const ru = settings.get().language === 'ru'
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'Streamly',
        body: ru ? `${nickname} хочет подключиться` : `${nickname} wants to join`
      })
      n.on('click', showWindow)
      n.show()
    }
  })
  client.on('state', (s: ClientState) => {
    broadcast('clientState', s)
    log(`[client] ${s.phase} host=${s.host?.address ?? '-'}${s.error ? ` error=${s.error}` : ''}${s.errorDetail ? ` (${s.errorDetail})` : ''}`)
  })
  client.on('hosts', (h) => broadcast('hosts', h))
  let prevSettings = settings.get()
  settings.on('change', (s: Settings) => {
    broadcast('settings', s)
    app.setLoginItemSettings({ openAtLogin: s.autostart, args: ['--hidden'] })
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
    const rect = helper.available ? await helper.windowRect(pid).catch(() => null) : null
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
  let shortcutOn = false
  const syncShortcut = (s: ClientState): void => {
    const want = s.phase === 'streaming' || s.phase === 'launching'
    if (want && !shortcutOn) {
      shortcutOn = globalShortcut.register(OVERLAY_KEY, toggleOverlay)
      if (!shortcutOn) log(`[overlay] ${OVERLAY_KEY} is taken by another program`)
    } else if (!want && shortcutOn) {
      globalShortcut.unregister(OVERLAY_KEY)
      shortcutOn = false
    }
    if (s.phase !== 'streaming' && !s.restarting) hideOverlay(false)
  }
  client.on('state', syncShortcut)

  // ---------- Трей: Streamly продолжает хостить или держать стрим, когда окно закрыто ----------
  const updateTray = (): void => {
    if (!tray) return
    const ru = settings.get().language === 'ru'
    const hs = host.getState()
    const cs = client.getState()
    const hosting = hs.phase === 'running'
    const status = hosting
      ? ru
        ? `Хост · игроков: ${hs.players.length}`
        : `Hosting · players: ${hs.players.length}`
      : cs.phase === 'streaming'
        ? (ru ? 'В игре у ' : 'Playing at ') + (cs.host?.name ?? '')
        : ru
          ? 'Не активен'
          : 'Idle'
    tray.setToolTip(`Streamly — ${status}`)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: status, enabled: false },
        { type: 'separator' },
        { label: ru ? 'Открыть Streamly' : 'Open Streamly', click: showWindow },
        ...(hosting ? [{ label: ru ? 'Остановить хост' : 'Stop hosting', click: () => void host.stop() }] : []),
        ...(cs.phase === 'streaming' ? [{ label: ru ? 'Отключиться' : 'Disconnect', click: () => void client.cancel() }] : []),
        { type: 'separator' },
        { label: ru ? 'Выход' : 'Quit', click: () => app.quit() }
      ])
    )
  }
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }))
  tray.on('click', showWindow)
  updateTray()
  host.on('state', updateTray)
  client.on('state', updateTray)
  settings.on('change', updateTray)

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
  handle(IPC.clientConnect, (address: string) => client.connect(String(address)))
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

  app.on('second-instance', showWindow)

  // Перед выходом снимаем права у всех и закрываем стримы.
  app.on('before-quit', (e) => {
    if (quitting) return
    e.preventDefault()
    quitting = true
    globalShortcut.unregisterAll()
    void Promise.race([Promise.all([host.stop(), client.cancel()]), new Promise((r) => setTimeout(r, 8000))]).finally(() => {
      // Помощник возвращает маршрутизацию звука и выходит, когда закрывается его ввод.
      helper.stop()
      app.exit(0)
    })
  })
})

// Окно может быть только спрятано в трей: выходим лишь по явному «Выход» или когда окно реально закрыто.
app.on('window-all-closed', () => app.quit())
