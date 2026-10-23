import { AnimatePresence, motion } from 'framer-motion'
import { Check, Download, Network, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { NetStatus } from '@shared/types'
import { useApp } from '@/store/app'
import { api } from '@/lib/bridge'
import { Button, Modal, spring } from './ui'

export const RADMIN_URL = 'https://www.radmin-vpn.com/'
export const ZEROTIER_URL = 'https://www.zerotier.com/download/'

type T = ReturnType<typeof useTranslation>['t']

/** Подпись сети: «Radmin VPN · 26.x», «ZeroTier · 10.x» или обе. */
export function netLabel(net: NetStatus, t: T): string {
  if (net.radmin.connected && net.zerotier.connected) return t('radmin.connectedBoth', { ip: net.radmin.ip })
  if (net.radmin.connected) return t('radmin.connected', { ip: net.radmin.ip })
  if (net.zerotier.connected) return t('zerotier.connected', { ip: net.zerotier.ip })
  if (net.radmin.installed) return t('radmin.disconnected')
  if (net.zerotier.installed) return t('zerotier.disconnected')
  return t('radmin.missing')
}

export function RadminBadge() {
  const { t } = useTranslation()
  const net = useApp((s) => s.net)
  const [open, setOpen] = useState(false)
  const online = net.links.length > 0
  const tone = online ? 'pill-success' : net.radmin.installed || net.zerotier.installed ? 'pill-warning' : 'pill-danger'
  const text = netLabel(net, t)
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
        <span className={`dot ${online ? 'pulse' : ''}`} />
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

/** Короткая инструкция: Radmin VPN (основная сеть) и ZeroTier (запасная), кнопки «Скачать» и «Проверить снова». */
export function RadminHelp({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const { t } = useTranslation()
  const net = useApp((s) => s.net)
  const [checking, setChecking] = useState(false)
  const recheck = async (): Promise<void> => {
    setChecking(true)
    try {
      const n = await api().getNet()
      useApp.setState({ net: n })
      if (n.links.length > 0) onDone?.()
    } finally {
      setTimeout(() => setChecking(false), 400)
    }
  }
  const steps = [t('radmin.step1'), t('radmin.step2'), t('radmin.step3')]
  const online = net.links.length > 0
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
      {online && (
        <p style={{ marginTop: 0 }}>
          <span className="pill pill-success">{netLabel(net, t)}</span>
        </p>
      )}
      <p className="muted" style={{ marginTop: 0 }}>
        {t('radmin.helpText')}
      </p>
      <ol style={{ paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 10, margin: '16px 0 16px' }}>
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
      <div style={{ margin: '0 0 18px', padding: '12px 14px', borderRadius: 12, background: 'var(--surface-2)' }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('zerotier.title')}</div>
        <div className="muted" style={{ fontSize: 13 }}>
          {t('zerotier.text')}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {!net.radmin.installed && (
          <Button variant="primary" icon={<Download size={16} />} onClick={() => void api().openExternal(RADMIN_URL)}>
            {t('radmin.download')}
          </Button>
        )}
        {!net.zerotier.installed && (
          <Button icon={<Download size={16} />} onClick={() => void api().openExternal(ZEROTIER_URL)}>
            {t('zerotier.download')}
          </Button>
        )}
        <Button icon={online ? <Check size={16} /> : <RefreshCw size={16} className={checking ? 'spin' : ''} />} loading={checking} onClick={() => void recheck()}>
          {t('radmin.recheck')}
        </Button>
      </div>
    </div>
  )
}
