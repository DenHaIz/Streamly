import { create } from 'zustand'
import type { AppInfo, ClientState, DeepPartial, DiscoveredHost, HostState, HotkeyName, HotkeyStatus, Invite, RadminStatus, Settings, UpdateState } from '@shared/types'
import { api } from '@/lib/bridge'
import { setLanguage } from '@/i18n'
import { playChime } from '@/lib/sound'

export type SettingsTab = 'general' | 'stream' | 'host' | 'about'

export type Screen = 'onboarding' | 'home' | 'host' | 'connect' | 'settings'

export interface Toast {
  id: number
  text: string
  tone: 'info' | 'success' | 'warning' | 'danger'
  action?: { label: string; run: () => void }
}

/** Что проверяем в окне диагностики: связь с хостом по адресу или сам этот ПК как хост. */
export type DiagTarget = { mode: 'client'; address: string } | { mode: 'host' }

interface AppStore {
  ready: boolean
  diag: DiagTarget | null
  openDiag(target: DiagTarget): void
  closeDiag(): void
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
  /** Меню Alt+F2 (только в его окне). */
  overlay: { open: boolean; screens: number }
  /** Приглашение, которое предлагаем принять. */
  invite: Invite | null
  update: UpdateState | null
  /** Баннер обновления закрыт кнопкой «Позже» (до перезапуска Streamly). */
  updateDismissed: boolean
  dismissUpdate(): void
  settingsTab: SettingsTab
  setSettingsTab(tab: SettingsTab): void
  /** Состояние горячих клавиш (работает, занята, выключена). */
  hotkeys: Partial<Record<HotkeyName, HotkeyStatus>>
  /** Меню хоста поверх игры открыто (только в его окне). */
  hostMenuOpen: boolean
  setInvite(invite: Invite | null): void
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
  overlay: { open: false, screens: 1 },
  invite: null,
  setInvite: (invite) => set({ invite }),
  update: null,
  updateDismissed: false,
  dismissUpdate: () => set({ updateDismissed: true }),
  settingsTab: 'general',
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  hotkeys: {},
  hostMenuOpen: false,
  toasts: [],
  diag: null,
  openDiag: (target) => set({ diag: target }),
  closeDiag: () => set({ diag: null }),

  async init() {
    const b = api()
    const [settings, radmin, appInfo, host, client, hosts, update] = await Promise.all([
      b.getSettings(),
      b.getRadmin(),
      b.getAppInfo(),
      b.host.getState(),
      b.client.getState(),
      b.client.getHosts(),
      b.update.getState()
    ])
    void b.getHotkeys().then((hotkeys) => set({ hotkeys }))
    b.on('hotkeys', (hotkeys) => set({ hotkeys }))
    b.on('hostMenu', ({ open }) => set({ hostMenuOpen: open }))
    b.on('settings', (s) => {
      if (s.language !== get().settings?.language) setLanguage(s.language)
      set({ settings: s })
    })
    b.on('radmin', (r) => set({ radmin: r }))
    b.on('hostState', (h) => set({ host: h }))
    b.on('clientState', (c) => set({ client: c }))
    b.on('hosts', (h) => set({ hosts: h }))
    b.on('overlay', (o) => set({ overlay: o }))
    b.on('update', (u) => set({ update: u }))
    // Звук — только в главном окне (окна поверх игры получают те же события).
    if (!location.hash) b.on('alert', ({ kind }) => playChime(kind))
    // Пункты меню в трее открывают нужный экран.
    b.on('navigate', (to) => {
      if (!get().settings?.onboarded) return
      if (to === 'about') {
        set({ settingsTab: 'about' })
        return get().go('settings')
      }
      if (to === 'settings') set({ settingsTab: 'general' })
      get().go(to)
    })
    set({ settings, radmin, appInfo, host, client, hosts, update, ready: true, screen: settings.onboarded ? 'home' : 'onboarding' })
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
