// Фейковый API основного процесса для разработки интерфейса в браузере (npm run dev:web).
// Имитирует хост с входящими запросами и клиент с поиском и подключением.
import type { BridgeEvent, BridgeEvents, StreamlyBridge } from '@shared/ipc'
import type { ClientState, DiscoveredHost, HostDisplay, HostState, Settings, TrustedFriendView, UpdateState } from '@shared/types'
import { NO_INPUT } from '@shared/perms'
import { DEFAULT_SETTINGS } from '@shared/types'
import { MotionGlobalConfig } from 'framer-motion'

const listeners = new Map<BridgeEvent, Set<(p: unknown) => void>>()
const emit = <E extends BridgeEvent>(e: E, p: BridgeEvents[E]): void => listeners.get(e)?.forEach((cb) => cb(p))
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const params = new URLSearchParams(location.search)
// ?noanim=1: без анимаций, чтобы скриншоты показывали конечное состояние.
if (params.get('noanim') === '1') MotionGlobalConfig.skipAnimations = true
let settings: Settings = {
  ...clone(DEFAULT_SETTINGS),
  onboarded: params.get('onboarded') !== '0',
  language: params.get('lang') === 'en' ? 'en' : 'ru',
  theme: (params.get('theme') as Settings['theme']) ?? 'system',
  nickname: 'Алексей',
  deviceId: '00000000-0000-4000-8000-000000000000'
}
const radmin = params.get('radmin') === '0' ? { installed: true, connected: false } : { installed: true, connected: true, ip: '26.14.88.201', adapterName: 'Radmin VPN' }

let host: HostState = {
  phase: 'idle',
  hostName: settings.nickname,
  maxPlayers: 4,
  players: [],
  requests: [],
  gamepadDriver: true,
  address: radmin.ip,
  audio: { chatControl: true, chatExcluded: false, monitoring: false },
  pendingRestart: false,
  inputPaused: false,
  encoder: { vendor: params.get('cpu') === '1' ? 'software' : 'nvenc', hevc: true, av1: params.get('cpu') !== '1' }
}
const displays: HostDisplay[] = [
  { id: '{de9bb7e2-186e-505b-9e93-f48793333810}', name: 'ROG PG279Q', displayName: '\\\\.\\DISPLAY1', primary: true, width: 2560, height: 1440, fps: 165 },
  { id: '{a1b2c3d4-0000-4000-8000-000000000002}', name: 'DELL U2419H', displayName: '\\\\.\\DISPLAY2', primary: false, width: 1920, height: 1080, fps: 60 }
]
// ?update=available|ready — найдено обновление (или уже скачано).
const updParam = params.get('update')
let update: UpdateState = {
  status: updParam === 'ready' ? 'ready' : updParam === 'available' ? 'available' : 'latest',
  current: '0.4.0',
  version: updParam ? '0.5.0' : undefined,
  notes: updParam
    ? 'Что нового\n• Автообновление через GitHub\n• Звук и мигание значка при запросе на подключение\n• Переподключение геймпада в меню Alt+F2'
    : undefined,
  checkedAt: Date.now() - 3600e3
}
const setUpdate = (patch: Partial<UpdateState>): void => {
  update = { ...update, ...patch }
  emit('update', update)
}

// ?stream=1 — сразу «идёт трансляция» (и меню Alt+F2 по адресу #overlay).
const streamingDemo: ClientState = {
  phase: 'streaming',
  host: { address: '26.51.7.12', name: 'Дима' },
  perms: { keyboard: true, mouse: true, gamepad: false },
  selfOff: { ...NO_INPUT },
  rttMs: 31,
  jitterMs: params.get('poor') === '1' ? 34 : 3,
  poorNetwork: params.get('poor') === '1',
  hostChat: { control: params.get('nochat') !== '1', excluded: true },
  speedMbps: params.get('poor') === '1' ? 8 : 74,
  wifi: params.get('poor') === '1',
  relaySuspect: params.get('poor') === '1',
  active: { width: 2560, height: 1440, fps: 60, bitrateKbps: 20000, auto: false },
  pads: [
    { nickname: 'Алексей', slot: 2, you: true },
    { nickname: 'Петя', slot: null, you: false }
  ],
  signalLost: params.get('signal') === '0',
  startedAt: Date.now() - 754_000,
  policy: { hostAudio: false, maxBitrateKbps: 20000, hostWidth: 2560, hostHeight: 1440, hostFps: 165, encoder: { vendor: 'nvenc', hevc: true, av1: true } }
}
let client: ClientState = params.get('stream') === '1' || location.hash === '#overlay' ? streamingDemo : { phase: 'idle' }
let hosts: DiscoveredHost[] = []
const trusted: TrustedFriendView[] = [{ deviceId: 't1', nickname: 'Дима', addedAt: Date.now() - 86400e3, lastSeen: Date.now() - 3600e3 }]

const setHost = (patch: Partial<HostState>): void => {
  host = { ...host, ...patch }
  emit('hostState', host)
}
const setClient = (patch: Partial<ClientState>): void => {
  client = { ...client, ...patch }
  emit('clientState', client)
}

let clientRun = 0
let inviteShown = false

function scheduleRequests(): void {
  const names = ['Вася', 'Константин Великолепный', 'Kate', 'Миша']
  names.forEach((n, i) =>
    setTimeout(() => {
      if (host.phase !== 'running') return
      setHost({ requests: [...host.requests, { id: `r${i}`, deviceId: `d${i}`, nickname: n, address: `26.33.${10 + i}.5`, at: Date.now(), known: i % 2 === 0 }] })
    }, 1500 + i * 1200)
  )
}

const bridge: StreamlyBridge = {
  getSettings: async () => settings,
  async updateSettings(patch) {
    settings = {
      ...settings,
      ...(patch as Partial<Settings>),
      stream: { ...settings.stream, ...(patch.stream ?? {}) },
      host: { ...settings.host, ...(patch.host ?? {}), defaultPerms: { ...settings.host.defaultPerms, ...(patch.host?.defaultPerms ?? {}) } },
      hotkeys: { ...settings.hotkeys, ...(patch.hotkeys ?? {}) },
      updates: { ...settings.updates, ...(patch.updates ?? {}) }
    } as Settings
    setHost({ maxPlayers: settings.host.maxPlayers })
    emit('settings', settings)
    return settings
  },
  getRadmin: async () => radmin,
  getAppInfo: async () => ({ version: '0.1.0-dev', moonlightAvailable: true, apolloBundled: true, apolloInstalled: false, platform: 'web' }),
  openExternal: async (url) => void window.open(url, '_blank'),
  copyText: async (text) => void navigator.clipboard?.writeText(text).catch(() => undefined),
  setTitleBar: async () => undefined,
  openLogs: async () => undefined,
  copyDiagnostics: async () => void navigator.clipboard?.writeText('Streamly diagnostics (mock)').catch(() => undefined),
  // ?invite=1 — показать приглашение при запуске.
  getHotkeys: async () => ({ clientMenu: 'idle', clientMenuAlt: 'idle', hostMenu: 'ok', hostPause: 'ok', hostAllow: 'idle', hostDeny: params.get('taken') === '1' ? 'taken' : 'idle' }),
  logError: async (text) => console.warn('[ui error]', text),
  suspendHotkeys: async () => undefined,
  async exportLogs() {
    await wait(600)
    return 'C:\\Users\\demo\\Desktop\\streamly-logs.zip'
  },
  checkInvite: async () => (params.get('invite') === '1' && !inviteShown ? ((inviteShown = true), { address: '26.51.7.12', name: 'Дима', code: 'demo-invite-code' }) : null),
  update: {
    getState: async () => update,
    async check() {
      setUpdate({ status: 'checking', error: undefined })
      await wait(1200)
      setUpdate(updParam ? { status: 'available', checkedAt: Date.now() } : { status: 'latest', checkedAt: Date.now() })
      return update
    },
    async download() {
      for (let p = 0; p <= 100; p += 7) {
        setUpdate({ status: 'downloading', percent: Math.min(p, 99), bytesPerSecond: 12_500_000 })
        await wait(220)
      }
      setUpdate({ status: 'ready', percent: 100 })
    },
    install: async () => undefined,
    async skip(version) {
      await bridge.updateSettings({ updates: { skipped: version } })
    }
  },
  host: {
    getState: async () => host,
    async start() {
      if (host.phase !== 'idle' && host.phase !== 'error') return
      setHost({ phase: 'checking', error: undefined })
      await wait(900)
      if (params.get('install') === '1') return setHost({ phase: 'needsInstall' })
      setHost({ phase: 'configuring' })
      await wait(1200)
      setHost({ phase: 'running' })
      scheduleRequests()
    },
    async install() {
      setHost({ phase: 'installing' })
      await wait(2500)
      setHost({ phase: 'configuring' })
      await wait(1000)
      setHost({ phase: 'running' })
      scheduleRequests()
    },
    submitCredentials: async () => true,
    async stop() {
      setHost({ phase: 'idle', players: [], requests: [] })
    },
    async respond(id, d) {
      const r = host.requests.find((x) => x.id === id)
      setHost({ requests: host.requests.filter((x) => x.id !== id) })
      if (!r || d === 'deny') return
      setHost({
        players: [
          ...host.players,
          {
            deviceId: r.deviceId,
            nickname: r.nickname,
            address: r.address,
            status: 'pairing',
            perms: { ...settings.host.defaultPerms },
            trusted: d === 'trust',
            since: Date.now(),
            rttMs: 18 + host.players.length * 37,
            // Для наглядности: второй игрок выключил себе геймпад, третий жалуется на связь.
            selfOff: host.players.length === 1 ? { ...NO_INPUT, gamepad: true } : { ...NO_INPUT },
            muteChat: host.players.length % 2 === 0,
            poorNetwork: host.players.length === 2,
            viaInvite: host.players.length === 0,
            // У хоста свой геймпад — первый, у игроков номера со второго.
            padSlot: host.players.length < 2 ? host.players.length + 2 : undefined,
            // Третий игрок просит геймпад: у хоста карточка с «Выдать» и «Отказать».
            inputRequest: host.players.length === 2 ? { keyboard: false, mouse: false, gamepad: true } : undefined
          }
        ]
      })
      await wait(1500)
      setHost({ players: host.players.map((p) => (p.deviceId === r.deviceId ? { ...p, status: 'connecting' } : p)) })
      await wait(1500)
      setHost({
        players: host.players.map((p) => (p.deviceId === r.deviceId ? { ...p, status: 'streaming' } : p)),
        audio: { ...host.audio, chatExcluded: host.players.some((p) => p.muteChat), monitoring: true }
      })
    },
    async setPerms(id, perms) {
      setHost({ players: host.players.map((p) => (p.deviceId === id ? { ...p, perms: { ...p.perms, ...perms } } : p)) })
    },
    async kick(id) {
      setHost({ players: host.players.filter((p) => p.deviceId !== id) })
    },
    async installGamepad() {
      await wait(1500)
      setHost({ gamepadDriver: true })
      return { ok: true }
    },
    async kickAll() {
      setHost({ players: [] })
    },
    async selfCheck() {
      await wait(900)
      return {
        target: radmin.ip,
        summary: 'hostWarnings',
        items: [
          { id: 'radmin', status: 'ok', value: radmin.ip },
          { id: 'apolloInstalled', status: 'ok' },
          { id: 'apolloService', status: 'ok' },
          { id: 'sunshine', status: 'ok' },
          { id: 'firewall', status: 'ok' },
          { id: 'gamepadDriver', status: 'warn', hint: 'vigem' },
          { id: 'apolloApi', status: 'ok' },
          { id: 'apolloPorts', status: 'ok' },
          { id: 'hosting', status: host.phase === 'running' ? 'ok' : 'warn', hint: 'hosting' },
          { id: 'audio', status: 'ok' }
        ]
      }
    },
    listTrusted: async () => trusted,
    async removeTrusted(id) {
      trusted.splice(
        trusted.findIndex((t) => t.deviceId === id),
        1
      )
    },
    listDisplays: async () => displays,
    createInvite: async () => ({ link: `streamly://join/${radmin.ip}?name=${encodeURIComponent(settings.nickname)}&code=demo-invite-code`, expiresAt: Date.now() + 12 * 3600e3 }),
    async respondInput(id, grant) {
      setHost({
        players: host.players.map((p) =>
          p.deviceId === id ? { ...p, inputRequest: undefined, perms: grant ? { ...p.perms, ...p.inputRequest } : p.perms } : p
        )
      })
    },
    async setInputPaused(paused) {
      setHost({ inputPaused: paused })
    },
    resetGamepad: async () => undefined,
    async passControl(id) {
      setHost({ players: host.players.map((p) => ({ ...p, perms: p.deviceId === id ? { keyboard: true, mouse: true, gamepad: true } : { ...NO_INPUT } })) })
    },
    async setSpectator(id, on) {
      setHost({ players: host.players.map((p) => (p.deviceId === id ? { ...p, perms: on ? { ...NO_INPUT } : { ...settings.host.defaultPerms } } : p)) })
    },
    async makePadFirst(id) {
      const order = [id, ...host.players.filter((p) => p.deviceId !== id && p.padSlot).map((p) => p.deviceId)]
      setHost({ players: host.players.map((p) => (order.includes(p.deviceId) ? { ...p, padSlot: order.indexOf(p.deviceId) + 2 } : p)) })
    },
    closeMenu: async () => undefined,
    notifyResize: async () => undefined
  },
  client: {
    getState: async () => client,
    async discover() {
      await wait(1400)
      hosts = [
        { address: '26.51.7.12', name: 'Дима', slotsUsed: 1, maxSlots: 4, source: 'broadcast', online: true, lastSeen: Date.now() },
        { address: '26.80.3.99', name: 'Kate-PC', slotsUsed: 4, maxSlots: 4, source: 'scan', online: true, lastSeen: Date.now() },
        { address: '26.120.44.1', name: 'Серёга', slotsUsed: 0, maxSlots: 4, source: 'recent', online: false, lastSeen: Date.now() }
      ]
      emit('hosts', hosts)
    },
    getHosts: async () => hosts,
    async diagnose(address) {
      await wait(1500)
      const bad = address.endsWith('.99')
      return {
        target: address,
        summary: bad ? 'apolloBlocked' : 'allGood',
        items: [
          { id: 'radmin', status: 'ok', value: radmin.ip },
          { id: 'radminAddress', status: 'ok', value: address },
          { id: 'moonlight', status: 'ok' },
          { id: 'ping', status: 'warn', hint: 'pingBlocked' },
          { id: 'streamly', status: 'ok', value: '47900' },
          bad ? { id: 'apollo', status: 'fail', hint: 'apolloFirewall', value: '47984, 47989, 48010' } : { id: 'apollo', status: 'ok', value: '47984, 47989, 48010' }
        ]
      }
    },
    async connect(address) {
      const run = ++clientRun
      const name = hosts.find((h) => h.address === address)?.name ?? address
      const steps: ClientState['phase'][] = ['connecting', 'waitingApproval', 'pairing', 'launching']
      for (const phase of steps) {
        if (run !== clientRun) return
        setClient({
          phase,
          host: { address, name },
          error: undefined,
          perms: settings.host.defaultPerms,
          rttMs: 24,
          policy: { hostAudio: true, maxBitrateKbps: 20000, hostWidth: 1920, hostHeight: 1080, hostFps: 60 }
        })
        await wait(phase === 'waitingApproval' ? 2500 : 1300)
      }
      if (run !== clientRun) return
      if (params.get('fail') === '1') return setClient({ phase: 'error', error: 'pair_failed' })
      setClient({ phase: 'streaming', startedAt: Date.now() })
      setTimeout(() => run === clientRun && setClient({ perms: { keyboard: true, mouse: true, gamepad: false } }), 5000)
    },
    async cancel() {
      clientRun++
      setClient({ phase: 'idle', error: undefined })
    },
    async reset() {
      setClient({ phase: 'idle', error: undefined })
    },
    async setSelfOff(patch) {
      setClient({ selfOff: { ...(client.selfOff ?? NO_INPUT), ...patch } })
    },
    async requestInput() {
      setClient({ inputRequest: 'pending' })
      await wait(2500)
      setClient({ inputRequest: undefined, perms: { keyboard: true, mouse: true, gamepad: true } })
    },
    async restartStream() {
      setClient({ restarting: true })
      await wait(2500)
      setClient({ restarting: false, poorNetwork: false, jitterMs: 3 })
      return true
    },
    resetGamepad() {
      return bridge.client.restartStream()
    },
    async identifyPad() {
      setClient({ padIdentify: 'waiting' })
      await wait(2000)
      setClient({ padIdentify: 'done', pads: (client.pads ?? []).map((p) => (p.you ? { ...p, slot: 3 } : p)) })
    }
  },
  pads: {
    async list() {
      await wait(300)
      const maps = settings.stream.padMappings
      return [
        { guid: '030000005e0400008e02000000007200', name: 'Xbox 360 Controller', gamepad: true, custom: false },
        { guid: '03000000790000000600000000000000', name: 'USB Gamepad  (старый)', gamepad: !!maps['03000000790000000600000000000000'], custom: !!maps['03000000790000000600000000000000'] }
      ]
    },
    async state() {
      // Имитация: каждые две секунды «нажимается» следующая кнопка.
      const n = Math.floor(Date.now() / 2000) % 12
      const pressed = Math.floor(Date.now() / 1000) % 2 === 0
      return {
        buttons: Array.from({ length: 12 }, (_, i) => pressed && i === n),
        axes: [0, 0, 0, 0, 0, 0].map((v, i) => (pressed && n >= 8 && i === n - 8 ? 30000 : v)),
        hats: [0]
      }
    },
    async close() {}
  },
  overlay: {
    async close() {
      emit('overlay', { open: false, screens: 2 })
      setTimeout(() => emit('overlay', { open: true, screens: 2 }), 1200)
    },
    toOtherScreen: async () => true,
    toggleStats: async () => true
  },
  on(event, cb) {
    let set = listeners.get(event)
    if (!set) listeners.set(event, (set = new Set()))
    const l = cb as (p: unknown) => void
    set.add(l)
    return () => set.delete(l)
  }
}

window.streamly = bridge

// В браузере меню Alt+F2 открыто сразу.
if (location.hash === '#overlay') setTimeout(() => emit('overlay', { open: true, screens: 2 }), 50)

// Окна хоста поверх игры: хост сразу запущен (запросы появятся сами), меню открыто.
if (location.hash === '#hostmenu' || location.hash === '#hostnotify') {
  void bridge.host.start()
  if (location.hash === '#hostmenu') setTimeout(() => emit('hostMenu', { open: true }), 50)
}
