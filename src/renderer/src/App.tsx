import { AnimatePresence, motion, MotionConfig } from 'framer-motion'
import { ArrowLeft, Bell, CheckCircle2, Info, TriangleAlert, X } from 'lucide-react'
import { useEffect, useRef, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import type { InputPerms } from '@shared/perms'
import { useApp, type Screen } from '@/store/app'
import { useResolvedTheme } from '@/lib/theme'
import { IconButton, spring } from '@/components/ui'
import { RadminBadge } from '@/components/RadminBadge'
import { PixelLogo } from '@/components/PixelLogo'
import { DiagnosticsModal } from '@/components/Diagnostics'
import { Onboarding } from '@/screens/Onboarding'
import { Home } from '@/screens/Home'
import { Host } from '@/screens/Host'
import { Connect } from '@/screens/Connect'
import { SettingsScreen } from '@/screens/Settings'

const SCREENS: Record<Screen, ComponentType> = {
  onboarding: Onboarding,
  home: Home,
  host: Host,
  connect: Connect,
  settings: SettingsScreen
}

// Только opacity и transform: они считаются на композиторе и не тормозят даже на слабых видеокартах.
const pageVariants = {
  enter: (dir: number) => ({ opacity: 0, x: dir * 48, scale: 0.985 }),
  center: { opacity: 1, x: 0, scale: 1 },
  exit: (dir: number) => ({ opacity: 0, x: dir * -36, scale: 0.985 })
}

/** Окно неактивно или скрыто: ставим бесконечные CSS-анимации на паузу (html[data-idle]). */
function useIdleFlag(): void {
  useEffect(() => {
    const update = (): void => {
      const idle = document.hidden || !document.hasFocus()
      if (idle) document.documentElement.dataset.idle = ''
      else delete document.documentElement.dataset.idle
    }
    update()
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
}

function TitleBar() {
  const { t } = useTranslation()
  const screen = useApp((s) => s.screen)
  const back = useApp((s) => s.back)
  const canBack = screen !== 'home' && screen !== 'onboarding'
  return (
    <header className="titlebar">
      <AnimatePresence initial={false}>
        {canBack && (
          <motion.div initial={{ opacity: 0, width: 0, x: -8 }} animate={{ opacity: 1, width: 36, x: 0 }} exit={{ opacity: 0, width: 0, x: -8 }} transition={spring}>
            <IconButton label={t('common.back')} onClick={back}>
              <ArrowLeft size={18} />
            </IconButton>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="brand">
        <PixelLogo size={22} className="brand-mark" />
        Streamly
      </div>
      <div className="spacer" />
      {screen !== 'onboarding' && <RadminBadge />}
    </header>
  )
}

function Toasts() {
  const { t: tr } = useTranslation()
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  const icon = { info: Info, success: CheckCircle2, warning: TriangleAlert, danger: TriangleAlert }
  const color = { info: 'var(--accent-text)', success: 'var(--success)', warning: 'var(--warning)', danger: 'var(--danger)' }
  const bg = { info: 'var(--accent-soft)', success: 'var(--success-soft)', warning: 'var(--warning-soft)', danger: 'var(--danger-soft)' }
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = t.action ? Bell : icon[t.tone]
          return (
            <motion.div
              key={t.id}
              layout
              className="toast"
              initial={{ opacity: 0, y: 24, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 60, transition: { duration: 0.2 } }}
              transition={spring}
            >
              <div className="toast-icon" style={{ color: color[t.tone], background: bg[t.tone] }}>
                <Icon size={17} />
              </div>
              <div style={{ flex: 1, fontWeight: 550 }}>{t.text}</div>
              {t.action && (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    t.action!.run()
                    dismiss(t.id)
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button className="btn btn-ghost icon-btn" style={{ width: 28, height: 28 }} onClick={() => dismiss(t.id)} aria-label={tr('common.close')}>
                <X size={15} />
              </button>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}

/** Глобальные уведомления: запросы на подключение и смена прав у клиента. */
function useGlobalNotifications(): void {
  const { t } = useTranslation()
  const requests = useApp((s) => s.host?.requests)
  const perms = useApp((s) => s.client.perms)
  const phase = useApp((s) => s.client.phase)
  const seenRequests = useRef(new Set<string>())
  const prevPerms = useRef<InputPerms | undefined>(undefined)

  useEffect(() => {
    const { screen, toast, go } = useApp.getState()
    for (const r of requests ?? []) {
      if (seenRequests.current.has(r.id)) continue
      seenRequests.current.add(r.id)
      if (screen !== 'host') {
        toast({ tone: 'info', text: t('host.joinToast', { name: r.nickname }), action: { label: t('home.open'), run: () => go('host') } }, 10_000)
      }
    }
  }, [requests, t])

  useEffect(() => {
    const prev = prevPerms.current
    prevPerms.current = perms
    if (!prev || !perms || (phase !== 'streaming' && phase !== 'launching')) return
    const names: Record<keyof InputPerms, string> = { keyboard: t('host.keyboard'), mouse: t('host.mouse'), gamepad: t('host.gamepad') }
    const keys = Object.keys(names) as (keyof InputPerms)[]
    const granted = keys.filter((k) => perms[k] && !prev[k]).map((k) => names[k])
    const revoked = keys.filter((k) => !perms[k] && prev[k]).map((k) => names[k])
    const { toast } = useApp.getState()
    if (granted.length) toast({ tone: 'success', text: t('connect.permGranted', { what: granted.join(', ').toLowerCase() }) })
    if (revoked.length) toast({ tone: 'warning', text: t('connect.permRevoked', { what: revoked.join(', ').toLowerCase() }) })
  }, [perms, phase, t])
}

export function App() {
  const screen = useApp((s) => s.screen)
  const direction = useApp((s) => s.direction)
  useResolvedTheme()
  useGlobalNotifications()
  useIdleFlag()
  const Page = SCREENS[screen]
  return (
    <MotionConfig reducedMotion="user">
    <div className="app">
      <div className="aurora" />
      <TitleBar />
      <main className="content">
        <AnimatePresence mode="popLayout" custom={direction} initial={false}>
          <motion.div
            key={screen}
            className="page"
            layoutScroll
            custom={direction}
            variants={pageVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: 'spring', stiffness: 300, damping: 32, opacity: { duration: 0.22 } }}
          >
            <Page />
          </motion.div>
        </AnimatePresence>
      </main>
      <Toasts />
      <DiagnosticsModal />
    </div>
    </MotionConfig>
  )
}
