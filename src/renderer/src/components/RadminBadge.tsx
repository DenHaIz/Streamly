import { AnimatePresence, motion } from 'framer-motion'
import { Check, Download, Network, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '@/store/app'
import { api } from '@/lib/bridge'
import { Button, Modal, spring } from './ui'

export const RADMIN_URL = 'https://www.radmin-vpn.com/'

export function RadminBadge() {
  const { t } = useTranslation()
  const radmin = useApp((s) => s.radmin)
  const [open, setOpen] = useState(false)
  const tone = radmin.connected ? 'pill-success' : radmin.installed ? 'pill-warning' : 'pill-danger'
  const text = radmin.connected ? t('radmin.connected', { ip: radmin.ip }) : radmin.installed ? t('radmin.disconnected') : t('radmin.missing')
  return (
    <>
      <motion.button
        className={`pill ${tone} no-drag`}
        style={{ cursor: 'pointer' }}
        onClick={() => setOpen(true)}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.96 }}
        transition={spring}
      >
        <span className={`dot ${radmin.connected ? 'pulse' : ''}`} />
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={text} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
            {text}
          </motion.span>
        </AnimatePresence>
      </motion.button>
      <Modal open={open} onClose={() => setOpen(false)}>
        <RadminHelp onDone={() => setOpen(false)} />
      </Modal>
    </>
  )
}

/** Короткая инструкция по Radmin VPN с кнопками «Скачать» и «Проверить снова». */
export function RadminHelp({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const { t } = useTranslation()
  const radmin = useApp((s) => s.radmin)
  const [checking, setChecking] = useState(false)
  const recheck = async (): Promise<void> => {
    setChecking(true)
    try {
      const r = await api().getRadmin()
      useApp.setState({ radmin: r })
      if (r.connected) onDone?.()
    } finally {
      setTimeout(() => setChecking(false), 400)
    }
  }
  const steps = [t('radmin.step1'), t('radmin.step2'), t('radmin.step3')]
  return (
    <div>
      {!compact && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
          <div className="toast-icon" style={{ width: 40, height: 40, flexBasis: 40, background: 'var(--accent-soft)', color: 'var(--accent-text)', borderRadius: 12 }}>
            <Network size={20} />
          </div>
          <h3 style={{ margin: 0, fontSize: 18 }}>{t('radmin.helpTitle')}</h3>
        </div>
      )}
      <p className="muted" style={{ marginTop: 0 }}>
        {t('radmin.helpText')}
      </p>
      <ol style={{ paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 10, margin: '16px 0 20px' }}>
        {steps.map((s, i) => (
          <motion.li
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.08 * i + 0.1, ...spring }}
            style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}
          >
            <span className="pill pill-accent" style={{ height: 22, minWidth: 22, padding: 0, justifyContent: 'center' }}>
              {i + 1}
            </span>
            <span>{s}</span>
          </motion.li>
        ))}
      </ol>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {!radmin.installed && (
          <Button variant="primary" icon={<Download size={16} />} onClick={() => void api().openExternal(RADMIN_URL)}>
            {t('radmin.download')}
          </Button>
        )}
        <Button icon={radmin.connected ? <Check size={16} /> : <RefreshCw size={16} className={checking ? 'spin' : ''} />} loading={checking} onClick={() => void recheck()}>
          {t('radmin.recheck')}
        </Button>
      </div>
    </div>
  )
}
