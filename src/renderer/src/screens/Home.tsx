import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Cast, Radio, Settings as Gear, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '@/store/app'
import { IconButton, riseIn, softSpring, stagger } from '@/components/ui'

function BigAction({ icon, title, text, onClick, tone }: { icon: ReactNode; title: string; text: string; onClick: () => void; tone: 'violet' | 'cyan' }) {
  return (
    <motion.button
      variants={riseIn}
      className={`big-action card tone-${tone}`}
      onClick={onClick}
      whileHover={{ y: -6, scale: 1.015 }}
      whileTap={{ scale: 0.98 }}
      transition={softSpring}
    >
      <div className="big-action-glow" />
      <motion.div className="big-action-icon" whileHover={{ rotate: -8, scale: 1.08 }} transition={softSpring}>
        {icon}
      </motion.div>
      <div className="big-action-title">{title}</div>
      <div className="big-action-text">{text}</div>
      <div className="big-action-arrow">
        <ArrowRight size={20} />
      </div>
    </motion.button>
  )
}

export function Home() {
  const { t } = useTranslation()
  const go = useApp((s) => s.go)
  const host = useApp((s) => s.host)
  const client = useApp((s) => s.client)
  const hosting = host?.phase === 'running'
  const streaming = client.phase === 'streaming'
  const inSession = streaming || ['launching', 'pairing', 'waitingApproval', 'connecting'].includes(client.phase)

  return (
    <div className="page-inner home">
      <div className="page-header">
        <div>
          <h1 className="page-title">Streamly</h1>
          <div className="muted">{t('app.tagline')}</div>
        </div>
        <div className="spacer" />
        <IconButton label={t('common.settings')} onClick={() => go('settings')}>
          <Gear size={19} />
        </IconButton>
      </div>

      <AnimatePresence>
        {(hosting || inSession) && (
          <motion.button
            className="banner card"
            initial={{ opacity: 0, height: 0, marginBottom: 0 }}
            animate={{ opacity: 1, height: 'auto', marginBottom: 18 }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            transition={softSpring}
            onClick={() => go(hosting ? 'host' : 'connect')}
          >
            {hosting || streaming ? (
              <span className="pill pill-danger">
                <span className="dot pulse" />
                {t('host.live')}
              </span>
            ) : (
              <span className="pill pill-accent">
                <span className="spinner" style={{ width: 11, height: 11, borderWidth: 2 }} />
              </span>
            )}
            <span style={{ fontWeight: 600 }}>
              {hosting
                ? t('home.hostRunning', { count: host?.players.length ?? 0 })
                : streaming
                  ? t('home.streaming', { name: client.host?.name ?? '' })
                  : t('home.connectingTo', { name: client.host?.name ?? client.host?.address ?? '' })}
            </span>
            <span className="spacer" />
            <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {t('home.open')} <ArrowRight size={15} />
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      <motion.div className="big-actions" variants={stagger} initial="hidden" animate="show">
        <BigAction tone="violet" icon={hosting ? <Radio size={30} /> : <Cast size={30} />} title={t('home.hostTitle')} text={t('home.hostText')} onClick={() => go('host')} />
        <BigAction tone="cyan" icon={<Users size={30} />} title={t('home.connectTitle')} text={t('home.connectText')} onClick={() => go('connect')} />
      </motion.div>

      <motion.div className="how" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...softSpring, delay: 0.25 }} aria-label={t('home.howTitle')}>
        {[t('home.how1'), t('home.how2'), t('home.how3')].map((text, i) => (
          <div key={i} className="how-step card">
            <span className="how-num">{i + 1}</span>
            {text}
          </div>
        ))}
      </motion.div>
    </div>
  )
}
