// Фейковый API основного процесса для разработки интерфейса в браузере (npm run dev:web).
// Имитирует хост с входящими запросами и клиент с поиском и подключением.
import type { BridgeEvent, BridgeEvents, StreamlyBridge } from '@shared/ipc'
import type { ClientState, DiscoveredHost, HostState, Settings, TrustedFriendView } from '@shared/types'
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

let host: HostState = { phase: 'idle', hostName: settings.nickname, maxPlayers: 4, players: [], requests: [], gamepadDriver: true, address: radmin.ip }
let client: ClientState = { phase: 'idle' }
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
      host: { ...settings.host, ...(patch.host ?? {}), defaultPerms: { ...settings.host.defaultPerms, ...(patch.host?.defaultPerms ?? {}) } }
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
          { deviceId: r.deviceId, nickname: r.nickname, address: r.address, status: 'pairing', perms: { ...settings.host.defaultPerms }, trusted: d === 'trust', since: Date.now(), rttMs: 18 + host.players.length * 37 }
        ]
      })
      await wait(1500)
      setHost({ players: host.players.map((p) => (p.deviceId === r.deviceId ? { ...p, status: 'connecting' } : p)) })
      await wait(1500)
      setHost({ players: host.players.map((p) => (p.deviceId === r.deviceId ? { ...p, status: 'streaming' } : p)) })
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
    }
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
    }
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
