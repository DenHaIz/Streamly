import { app, BrowserWindow, clipboard, ipcMain, nativeTheme, Notification, safeStorage, screen, shell } from 'electron'
import { appendFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { EVENT_CHANNEL, IPC, type BridgeEvent, type BridgeEvents, type JoinDecision } from '@shared/ipc'
import type { InputPerms } from '@shared/perms'
import type { ClientState, DeepPartial, HostState, RadminStatus, Settings } from '@shared/types'
import { SecretsService, SettingsService } from './settings'
import type { Cipher } from './store'
import { ApolloApi } from './services/apollo/api'
import { ApolloInstaller } from './services/apollo/installer'
import { HostController } from './services/host/controller'
import { ClientController } from './services/client/controller'
import { MoonlightRunner } from './services/moonlight/runner'
import { detectRadmin } from './services/net/radmin'
import { probeHosts, radminNeighbors } from './services/net/discovery'

// Отдельный профиль позволяет запустить второй экземпляр на одном ПК (хост и клиент для отладки).
const profile = process.env.STREAMLY_PROFILE
if (profile) app.setPath('userData', `${app.getPath('userData')}-${profile.replace(/[^\w-]/g, '')}`)
if (!profile && !app.requestSingleInstanceLock()) app.quit()

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
function log(msg: string, err?: unknown): void {
  const line = `${new Date().toISOString()} ${msg}${err ? ` ${err instanceof Error ? err.stack ?? err.message : String(err)}` : ''}`
  console.log(line)
  if (!logPath) return
  try {
    appendFileSync(logPath, line + '\n')
  } catch {
    /* лог не критичен */
  }
}
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

function broadcast<E extends BridgeEvent>(event: E, payload: BridgeEvents[E]): void {
  win?.webContents.send(EVENT_CHANNEL, event, payload)
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
    icon: join(app.getAppPath(), 'resources', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  win.on('closed', () => (win = null))
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
  const host = new HostController({
    settings,
    secrets,
    apollo,
    installer,
    address: () => radmin.ip ?? DEV_IP,
    appVersion,
    extraAllowed: EXTRA_ALLOWED,
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
    if (win?.isFocused()) return
    win?.flashFrame(true)
    const ru = settings.get().language === 'ru'
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'Streamly',
        body: ru ? `${nickname} хочет подключиться` : `${nickname} wants to join`
      })
      n.on('click', () => {
        win?.show()
        win?.focus()
      })
      n.show()
    }
  })
  client.on('state', (s: ClientState) => {
    broadcast('clientState', s)
    log(`[client] ${s.phase} host=${s.host?.address ?? '-'}${s.error ? ` error=${s.error}` : ''}${s.errorDetail ? ` (${s.errorDetail})` : ''}`)
  })
  client.on('hosts', (h) => broadcast('hosts', h))
  settings.on('change', (s: Settings) => {
    broadcast('settings', s)
    app.setLoginItemSettings({ openAtLogin: s.autostart })
  })

  setInterval(() => {
    const next = detectRadmin()
    if (JSON.stringify(next) !== JSON.stringify(radmin)) {
      radmin = next
      log(`[radmin] ${JSON.stringify(radmin)}`)
      broadcast('radmin', radmin)
    }
  }, 4000)

  const handle = (channel: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, (_e, ...args) => fn(...(args as never[])))
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
  handle(IPC.copyText, (text: string) => clipboard.writeText(String(text).slice(0, 256)))
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
  handle(IPC.hostListTrusted, () => host.listTrusted())
  handle(IPC.hostRemoveTrusted, (id: string) => host.removeTrusted(id))

  handle(IPC.clientGetState, () => client.getState())
  handle(IPC.clientDiscover, () => client.discover())
  handle(IPC.clientGetHosts, () => client.getHosts())
  handle(IPC.clientConnect, (address: string) => client.connect(String(address)))
  handle(IPC.clientCancel, () => client.cancel())
  handle(IPC.clientReset, () => client.reset())

  createWindow(settings.get())
  // Если прошлый запуск завершился аварийно, у друзей в Apollo могли остаться права.
  void host.lockdownOnBoot()

  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore()
    win?.focus()
  })

  // Перед выходом снимаем права у всех и закрываем стримы.
  app.on('before-quit', (e) => {
    if (quitting) return
    e.preventDefault()
    quitting = true
    void Promise.race([Promise.all([host.stop(), client.cancel()]), new Promise((r) => setTimeout(r, 8000))]).finally(() => app.exit(0))
  })
})

app.on('window-all-closed', () => app.quit())
