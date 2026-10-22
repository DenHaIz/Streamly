import { AnimatePresence, motion, MotionConfig } from 'framer-motion'
import { Check, Gamepad, Hand, Send, Tv, Users, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { inviteMessage } from '@shared/invite'
import { useApp } from '@/store/app'
import { api } from '@/lib/bridge'
import { useResolvedTheme } from '@/lib/theme'
import { Avatar, Button, softSpring } from '@/components/ui'
import { PixelLogo } from '@/components/PixelLogo'
import { PlayerCard, RequestCard } from '@/screens/Host'
import { Toasts } from '@/App'
import { showKey } from '@/components/Hotkeys'
import type { HotkeyName } from '@shared/types'

/** Подсказка сочетания — только если оно действительно работает (выключенное или занятое другой программой не показываем). */
function Kbd({ name }: { name: HotkeyName }) {
  const k = useApp((s) => s.settings!.hotkeys[name])
  const status = useApp((s) => s.hotkeys[name])
  if (!k || status === 'taken' || status === 'off') return null
  return <kbd className="kbd">{showKey(k)}</kbd>
}

/**
 * Меню хоста поверх игры (Alt+F3): запросы, игроки с правами, пауза управления, приглашение.
 * Хост играет сам на весь экран — ему не нужно сворачивать игру, чтобы пустить друга.
 */
export function HostMenu() {
  useResolvedTheme()
  const { t, i18n } = useTranslation()
  const open = useApp((s) => s.hostMenuOpen)
  const host = useApp((s) => s.host)
  const keys = useApp((s) => s.settings!.hotkeys)
  const toast = useApp((s) => s.toast)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Esc, уже обработанный меню игрока, меню хоста не закрывает.
      if (e.key === 'Escape' && !e.defaultPrevented) void api().host.closeMenu()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const invite = async (): Promise<void> => {
    if (!host?.address) return
    try {
      const inv = await api().host.createInvite()
      if (!inv) throw new Error('no invite')
      await api().copyText(inviteMessage(i18n.language === 'en' ? 'en' : 'ru', { name: host.hostName, address: host.address, link: inv.link }))
      toast({ tone: 'success', text: t('host.inviteCopiedShort') })
    } catch {
      toast({ tone: 'danger', text: t('hostMenu.inviteFailed') })
    }
  }

  return (
    <MotionConfig reducedMotion="user">
      {open && <Toasts />}
      <AnimatePresence>
        {open && host && (
          <motion.div
            className="overlay-root"
            key="hostmenu"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onMouseDown={(e) => e.target === e.currentTarget && void api().host.closeMenu()}
          >
            <motion.div
              className="overlay-panel host-menu"
              role="dialog"
              aria-label={t('hostMenu.title')}
              initial={{ opacity: 0, y: -18, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.97 }}
              transition={softSpring}
            >
              <header className="overlay-head">
                <PixelLogo size={26} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="overlay-host">{t('hostMenu.title')}</div>
                  <div className="overlay-sub">
                    <Users size={12} />
                    {t('hostMenu.players', { count: host.players.length, max: host.maxPlayers })}
                    {host.uploadMbps !== undefined && <span>· {t('hostMenu.upload', { mbps: host.uploadMbps })}</span>}
                  </div>
                </div>
                <Kbd name="hostMenu" />
              </header>

              <div className="host-menu-actions">
                <Button size="sm" variant={host.inputPaused ? 'primary' : 'default'} icon={<Hand size={15} />} onClick={() => void api().host.setInputPaused(!host.inputPaused)}>
                  {host.inputPaused ? t('host.resumeInput') : t('host.pauseInput')}
                  <Kbd name="hostPause" />
                </Button>
                <Button size="sm" icon={<Send size={15} />} onClick={() => void invite()}>
                  {t('host.invite')}
                </Button>
              </div>

              <AnimatePresence initial={false}>
                {host.requests.length > 0 && (
                  <motion.section key="req" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden' }}>
                    <div className="section-title">
                      {t('host.requests')}
                      <span className="faint hotkey-hint">
                        <span className="nowrap">
                          <Kbd name="hostAllow" /> {t('hostMenu.allowFirst')}
                        </span>
                        <span className="nowrap">
                          <Kbd name="hostDeny" /> {t('hostMenu.denyFirst')}
                        </span>
                      </span>
                    </div>
                    <div className="list">
                      <AnimatePresence initial={false}>
                        {host.requests.map((r) => (
                          <RequestCard key={r.id} r={r} />
                        ))}
                      </AnimatePresence>
                    </div>
                  </motion.section>
                )}
              </AnimatePresence>

              <div className="section-title" style={{ marginTop: 14 }}>
                {t('host.players')}
              </div>
              {host.players.length === 0 ? (
                <div className="faint" style={{ padding: '6px 2px 10px' }}>
                  {t('host.noPlayers')}
                </div>
              ) : (
                <div className="players host-menu-players">
                  <AnimatePresence initial={false} mode="popLayout">
                    {host.players.map((p) => (
                      <PlayerCard key={p.deviceId} p={p} />
                    ))}
                  </AnimatePresence>
                </div>
              )}

              <footer className="overlay-actions single">
                <Button variant="primary" icon={<Gamepad size={16} />} onClick={() => void api().host.closeMenu()} autoFocus>
                  {t('overlay.back')}
                </Button>
              </footer>
              <div className="overlay-tip">{t('hostMenu.tip', { key: keys.hostMenu || '—' })}</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  )
}

/**
 * Плашка с запросами поверх игры. Окно не забирает фокус: игра продолжает получать клавиши,
 * а ответить можно мышью или горячими клавишами.
 */
export function HostNotify() {
  useResolvedTheme()
  const { t } = useTranslation()
  // Само состояние хоста, а массивы — из него: селектор, возвращающий новый массив, зациклил бы перерисовку.
  const host = useApp((s) => s.host)
  const requests = host?.requests ?? []
  const asking = (host?.players ?? []).filter((p) => !!p.inputRequest)
  const box = useRef<HTMLDivElement>(null)

  // Окно подгоняется под высоту содержимого: прозрачные края не перекрывают игру.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const report = (): void => void api().host.notifyResize(Math.ceil(el.getBoundingClientRect().height) + 24)
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const first = requests[0]?.id ?? asking[0]?.deviceId
  // Больше четырёх карточек не помещается: остальные — строкой «ещё N».
  const shownRequests = requests.slice(0, 4)
  const shownAsking = asking.slice(0, Math.max(0, 4 - shownRequests.length))
  const more = requests.length + asking.length - shownRequests.length - shownAsking.length
  return (
    <MotionConfig reducedMotion="user">
      <div className="host-notify" ref={box}>
        <AnimatePresence initial={false}>
          {shownRequests.map((r) => (
            <motion.div key={r.id} className="notify-card" layout="position" initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40 }} transition={softSpring}>
              <Avatar name={r.nickname} size={36} />
              <div className="notify-text">
                <div className="notify-name">{r.nickname}</div>
                <div className="notify-what">{t('hostNotify.wantsToJoin')}</div>
                {r.id === first && (
                  <div className="notify-keys">
                    <span className="nowrap">
                      <Kbd name="hostAllow" /> {t('host.allow')}
                    </span>
                    <span className="nowrap">
                      <Kbd name="hostDeny" /> {t('host.deny')}
                    </span>
                  </div>
                )}
              </div>
              <div className="notify-buttons">
                <button className="btn btn-ghost icon-btn" title={t('host.deny')} aria-label={t('host.deny')} onClick={() => void api().host.respond(r.id, 'deny')}>
                  <X size={16} />
                </button>
                <button className="btn btn-ghost icon-btn" title={t('host.spectateHint')} aria-label={t('host.spectate')} onClick={() => void api().host.respond(r.id, 'spectate')}>
                  <Tv size={16} />
                </button>
                <button className="btn btn-success icon-btn" title={t('host.allow')} aria-label={t('host.allow')} onClick={() => void api().host.respond(r.id, 'allow')}>
                  <Check size={16} />
                </button>
              </div>
            </motion.div>
          ))}
          {shownAsking.map((p) => (
            <motion.div key={`in-${p.deviceId}`} className="notify-card" layout="position" initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40 }} transition={softSpring}>
              <Avatar name={p.nickname} size={36} />
              <div className="notify-text">
                <div className="notify-name">{p.nickname}</div>
                <div className="notify-what">{t('hostNotify.asksControl')}</div>
                {p.deviceId === first && (
                  <div className="notify-keys">
                    <span className="nowrap">
                      <Kbd name="hostAllow" /> {t('host.give')}
                    </span>
                    <span className="nowrap">
                      <Kbd name="hostDeny" /> {t('host.deny')}
                    </span>
                  </div>
                )}
              </div>
              <div className="notify-buttons">
                <button className="btn btn-ghost icon-btn" title={t('host.deny')} aria-label={t('host.deny')} onClick={() => void api().host.respondInput(p.deviceId, false)}>
                  <X size={16} />
                </button>
                <button className="btn btn-success icon-btn" title={t('host.give')} aria-label={t('host.give')} onClick={() => void api().host.respondInput(p.deviceId, true)}>
                  <Check size={16} />
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {more > 0 && <div className="notify-more">{t('hostNotify.more', { count: more })}</div>}
      </div>
    </MotionConfig>
  )
}
