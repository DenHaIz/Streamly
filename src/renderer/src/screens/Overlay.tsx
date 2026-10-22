import { AnimatePresence, motion, MotionConfig } from 'framer-motion'
import { Clock, Gamepad, MonitorSmartphone, Unplug } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '@/store/app'
import { api } from '@/lib/bridge'
import { useResolvedTheme } from '@/lib/theme'
import { Button, softSpring } from '@/components/ui'
import { PixelLogo } from '@/components/PixelLogo'
import { StreamControls, StreamStats } from '@/components/StreamControls'
import { RttBadge } from '@/screens/Host'

/**
 * Меню во время игры (Alt+F2): прозрачное окно поверх трансляции на том же мониторе.
 * Esc, Alt+F2 или клик мимо панели — вернуться в игру.
 */
export function Overlay() {
  useResolvedTheme()
  const { t } = useTranslation()
  const overlay = useApp((s) => s.overlay)
  const client = useApp((s) => s.client)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const leaveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!overlay.open) setConfirmLeave(false)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void api().overlay.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlay.open])
  useEffect(() => () => window.clearTimeout(leaveTimer.current), [])

  // Отключение — в два нажатия: случайный клик не выкидывает из игры.
  const leave = (): void => {
    if (!confirmLeave) {
      setConfirmLeave(true)
      window.clearTimeout(leaveTimer.current)
      leaveTimer.current = window.setTimeout(() => setConfirmLeave(false), 3500)
      return
    }
    void api().client.cancel()
  }

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>
        {overlay.open && (
          <motion.div
            className="overlay-root"
            key="overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onMouseDown={(e) => e.target === e.currentTarget && void api().overlay.close()}
          >
            <motion.div
              className="overlay-panel"
              role="dialog"
              aria-label={t('overlay.title')}
              initial={{ opacity: 0, y: -18, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.97 }}
              transition={softSpring}
            >
              <header className="overlay-head">
                <PixelLogo size={26} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="overlay-host">{client.host?.name ?? t('overlay.title')}</div>
                  <div className="overlay-sub">
                    <Clock size={12} />
                    <Elapsed since={client.startedAt} />
                    {client.rttMs !== undefined && <RttBadge ms={client.rttMs} />}
                  </div>
                </div>
                <kbd className="kbd">Alt+F2</kbd>
              </header>

              <StreamStats withMoonlight />
              <StreamControls />

              <footer className={`overlay-actions ${overlay.screens > 1 ? '' : 'single'}`}>
                {overlay.screens > 1 && (
                  <Button icon={<MonitorSmartphone size={16} />} onClick={() => void api().overlay.toOtherScreen()} title={t('overlay.otherScreenHint')}>
                    {t('overlay.otherScreen')}
                  </Button>
                )}
                <Button variant="primary" icon={<Gamepad size={16} />} onClick={() => void api().overlay.close()}>
                  {t('overlay.back')}
                </Button>
                <Button className="overlay-leave" variant="danger" icon={<Unplug size={16} />} onClick={leave}>
                  {confirmLeave ? t('overlay.leaveConfirm') : t('connect.disconnect')}
                </Button>
              </footer>
              <div className="overlay-tip">{t('overlay.tip')}</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  )
}

function Elapsed({ since }: { since?: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  if (!since) return <span>0:00</span>
  const s = Math.max(0, Math.floor((now - since) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return <span>{h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`}</span>
}
