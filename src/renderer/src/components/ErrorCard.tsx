import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, ClipboardCopy, FolderOpen, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ErrorCode } from '@shared/types'
import { api } from '@/lib/bridge'
import { useApp } from '@/store/app'
import { Button, softSpring } from './ui'

/**
 * Карточка ошибки: что случилось, что делать, технические подробности и кнопки диагностики.
 * Подсказки лежат в i18n (errorHints.<код>).
 */
export function ErrorCard({ code, detail, actions }: { code: ErrorCode; detail?: string; actions?: ReactNode }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const toast = useApp((s) => s.toast)
  return (
    <motion.div
      className="card card-pad center-card error-card"
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.98 }}
      transition={softSpring}
    >
      <motion.div className="setup-orb danger" initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 18 }}>
        <TriangleAlert size={28} />
      </motion.div>
      <h2 className="card-title">{t(`errors.${code}`)}</h2>
      <p className="muted error-hint">{t(`errorHints.${code}`)}</p>

      {detail && (
        <div className="error-details">
          <button type="button" className="error-details-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {t('diag.details')}
            <motion.span animate={{ rotate: open ? 180 : 0 }} transition={softSpring} style={{ display: 'inline-flex' }}>
              <ChevronDown size={15} />
            </motion.span>
          </button>
          <AnimatePresence initial={false}>
            {open && (
              <motion.pre
                className="error-detail"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22 }}
              >
                {detail}
              </motion.pre>
            )}
          </AnimatePresence>
        </div>
      )}

      <div className="error-actions">{actions}</div>
      <div className="error-diag">
        <Button
          size="sm"
          variant="ghost"
          icon={<ClipboardCopy size={14} />}
          onClick={() => {
            void api().copyDiagnostics()
            toast({ tone: 'success', text: t('diag.reportCopied') }, 2500)
          }}
        >
          {t('diag.copyReport')}
        </Button>
        <Button size="sm" variant="ghost" icon={<FolderOpen size={14} />} onClick={() => void api().openLogs()}>
          {t('diag.openLogs')}
        </Button>
      </div>
    </motion.div>
  )
}
