import { create } from 'zustand'
import type { AppInfo, ClientState, DeepPartial, DiscoveredHost, HostState, RadminStatus, Settings } from '@shared/types'
import { api } from '@/lib/bridge'
import { setLanguage } from '@/i18n'

export type Screen = 'onboarding' | 'home' | 'host' | 'connect' | 'settings'

export interface Toast {
  id: number
  text: string
  tone: 'info' | 'success' | 'warning' | 'danger'
  action?: { label: string; run: () => void }
}

interface AppStore {
  ready: boolean
  screen: Screen
  /** Направление последнего перехода: для анимации «вперёд/назад». */
  direction: 1 | -1
  history: Screen[]
  settings: Settings | null
  radmin: RadminStatus
  appInfo: AppInfo | null
  host: HostState | null
  client: ClientState
  hosts: DiscoveredHost[]
  toasts: Toast[]
  init(): Promise<void>
  go(screen: Screen): void
  back(): void
  updateSettings(patch: DeepPartial<Settings>): Promise<void>
  toast(t: Omit<Toast, 'id'>, ttlMs?: number): void
  dismissToast(id: number): void
}

let toastSeq = 0

export const useApp = create<AppStore>((set, get) => ({
  ready: false,
  screen: 'home',
  direction: 1,
  history: [],
  settings: null,
  radmin: { installed: false, connected: false },
  appInfo: null,
  host: null,
  client: { phase: 'idle' },
  hosts: [],
  toasts: [],

  async init() {
    const b = api()
    const [settings, radmin, appInfo, host, client, hosts] = await Promise.all([
      b.getSettings(),
      b.getRadmin(),
      b.getAppInfo(),
      b.host.getState(),
      b.client.getState(),
      b.client.getHosts()
    ])
    b.on('settings', (s) => set({ settings: s }))
    b.on('radmin', (r) => set({ radmin: r }))
    b.on('hostState', (h) => set({ host: h }))
    b.on('clientState', (c) => set({ client: c }))
    b.on('hosts', (h) => set({ hosts: h }))
    set({ settings, radmin, appInfo, host, client, hosts, ready: true, screen: settings.onboarded ? 'home' : 'onboarding' })
  },

  go(screen) {
    const { screen: cur, history } = get()
    if (screen === cur) return
    const order: Screen[] = ['onboarding', 'home', 'host', 'connect', 'settings']
    set({
      screen,
      history: screen === 'home' ? [] : [...history, cur],
      direction: order.indexOf(screen) >= order.indexOf(cur) ? 1 : -1
    })
  },

  back() {
    const { history } = get()
    const prev = history[history.length - 1] ?? 'home'
    set({ screen: prev, history: history.slice(0, -1), direction: -1 })
  },

  async updateSettings(patch) {
    const prev = get().settings
    const next = await api().updateSettings(patch)
    if (prev && next.language !== prev.language) setLanguage(next.language)
    set({ settings: next })
  },

  toast(t, ttlMs = 4500) {
    const id = ++toastSeq
    set({ toasts: [...get().toasts, { ...t, id }].slice(-4) })
    if (ttlMs > 0) setTimeout(() => get().dismissToast(id), ttlMs)
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  }
}))
