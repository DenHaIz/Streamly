import { AnimatePresence, motion } from 'framer-motion'
import { ArrowDownToLine, ChevronDown, RefreshCw, RotateCcw, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UpdateState } from '@shared/types'
import { useApp } from '@/store/app'
import { api } from '@/lib/bridge'
import { Button, Collapse, softSpring } from '@/components/ui'

/** Идёт хостинг или трансляция: установка обновления их прервёт. */
function useBusy(): boolean {
  return useApp((s) => s.host?.phase === 'running' || ['connecting', 'waitingApproval', 'pairing', 'launching', 'streaming'].includes(s.client.phase))
}

function mb(bytes?: number): string {
  return bytes ? (bytes / 1e6).toFixed(1) : '0'
}

/** Кнопки и прогресс для найденного обновления (баннер на главной и раздел «О программе»). */
function UpdateActions({ u, compact }: { u: UpdateState; compact?: boolean }) {
  const { t } = useTranslation()
  const busy = useBusy()
  if (u.status === 'downloading') {
    return (
      <div className="update-progress" role="progressbar" aria-valuenow={u.percent ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label={t('update.downloading')}>
        <div className="update-progress-bar">
          <motion.div className="update-progress-fill" initial={false} animate={{ scaleX: (u.percent ?? 0) / 100 }} transition={{ duration: 0.4, ease: 'easeOut' }} />
        </div>
        <span className="faint">
          {t('update.downloadingPct', { pct: u.percent ?? 0 })}
          {u.bytesPerSecond ? ` · ${t('update.speed', { mb: mb(u.bytesPerSecond) })}` : ''}
        </span>
      </div>
    )
  }
  if (u.status === 'ready') {
    return (
      <div className="update-actions">
        <Button size="sm" variant="primary" icon={<RotateCcw size={15} />} onClick={() => void api().update.install()}>
          {t('update.install')}
        </Button>
        <span className={`faint ${busy ? 'warn-text' : ''}`}>{busy ? t('update.busyWarn') : t('update.onQuit')}</span>
      </div>
    )
  }
  return (
    <div className="update-actions">
      <Button size="sm" variant="primary" icon={<ArrowDownToLine size={15} />} onClick={() => void api().update.download()}>
        {t('update.download')}
      </Button>
      {!compact && u.status === 'error' && <span className="faint warn-text">{t(`update.errors.${u.error ?? 'other'}`)}</span>}
    </div>
  )
}

function Notes({ notes }: { notes?: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  if (!notes) return null
  return (
    <>
      <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        {t('update.whatsNew')}
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={softSpring} style={{ display: 'inline-flex' }}>
          <ChevronDown size={14} />
        </motion.span>
      </button>
      <Collapse open={open}>
        <div className="update-notes">{notes}</div>
      </Collapse>
    </>
  )
}

/** Баннер на главной: новая версия найдена (не пропущена и не отложена). */
export function UpdateBanner() {
  const { t } = useTranslation()
  const u = useApp((s) => s.update)
  const skipped = useApp((s) => s.settings?.updates.skipped)
  const dismissed = useApp((s) => s.updateDismissed)
  const dismiss = useApp((s) => s.dismissUpdate)
  const show =
    !!u?.version &&
    (u.status === 'downloading' || u.status === 'ready' || (u.status === 'available' && !dismissed && u.version !== skipped))
  return (
    <AnimatePresence initial={false}>
      {show && u && (
        <motion.div
          key="update"
          className="update-banner card"
          initial={{ opacity: 0, y: -8, height: 0, marginBottom: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto', marginBottom: 18 }}
          exit={{ opacity: 0, y: -8, height: 0, marginBottom: 0 }}
          transition={softSpring}
          style={{ overflow: 'hidden' }}
        >
          <div className="update-banner-inner">
            <span className="update-icon">
              <Sparkles size={18} />
            </span>
            <div className="update-text">
              <div style={{ fontWeight: 650 }}>{u.status === 'ready' ? t('update.readyTitle', { version: u.version }) : t('update.availableTitle', { version: u.version })}</div>
              <div className="faint">{t('update.optional')}</div>
              <Notes notes={u.notes} />
            </div>
            <div className="update-side">
              <UpdateActions u={u} compact />
              {u.status === 'available' && (
                <div className="update-later">
                  <button className="link-btn" onClick={dismiss}>
                    {t('update.later')}
                  </button>
                  <button className="link-btn" onClick={() => void api().update.skip(u.version!)}>
                    {t('update.skip')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Раздел «Обновления» в настройках. */
export function UpdatePanel() {
  const { t, i18n } = useTranslation()
  const u = useApp((s) => s.update)
  if (!u) return null
  const checking = u.status === 'checking'
  const found = !!u.version && (u.status === 'available' || u.status === 'downloading' || u.status === 'ready' || (u.status === 'error' && !!u.version))
  const fmt = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const line =
    u.status === 'unsupported'
      ? t('update.unsupported')
      : checking
        ? t('update.checking')
        : found
          ? u.status === 'ready'
            ? t('update.readyTitle', { version: u.version })
            : t('update.availableTitle', { version: u.version })
          : u.status === 'error'
            ? t(`update.errors.${u.error ?? 'other'}`)
            : u.status === 'latest'
              ? t('update.latest')
              : t('update.notChecked')
  return (
    <div className="update-panel">
      <div className="row">
        <div className="row-text">
          <div className="row-title">{line}</div>
          {u.checkedAt && !checking && <div className="row-hint">{t('update.checkedAt', { date: fmt.format(u.checkedAt) })}</div>}
        </div>
        <Button size="sm" icon={<RefreshCw size={15} className={checking ? 'spin' : ''} />} disabled={checking || u.status === 'unsupported' || u.status === 'downloading'} onClick={() => void api().update.check()}>
          {t('update.check')}
        </Button>
      </div>
      <Collapse open={found}>
        <div className="update-found">
          <Notes notes={u.notes} />
          <UpdateActions u={u} />
        </div>
      </Collapse>
    </div>
  )
}
