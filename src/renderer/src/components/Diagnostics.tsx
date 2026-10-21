import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, CircleMinus, ClipboardCopy, RefreshCw, TriangleAlert, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CheckReport, CheckStatus } from '@shared/types'
import { api } from '@/lib/bridge'
import { useApp } from '@/store/app'
import { Button, Modal, softSpring } from './ui'

const ICON: Record<CheckStatus, typeof CheckCircle2> = { ok: CheckCircle2, warn: TriangleAlert, fail: XCircle, skip: CircleMinus }

const GOOD = new Set(['allGood', 'hostOk'])
const WARN = new Set(['slow', 'hostWarnings'])

/** Окно проверки связи (клиент → хост) или самопроверки хоста. Открывается через useApp().openDiag. */
export function DiagnosticsModal() {
  const target = useApp((s) => s.diag)
  const close = useApp((s) => s.closeDiag)
  return (
    <Modal open={!!target} onClose={close}>
      {target && <DiagnosticsBody key={target.mode === 'client' ? target.address : 'host'} target={target} onClose={close} />}
    </Modal>
  )
}

function DiagnosticsBody({ target, onClose }: { target: NonNullable<ReturnType<typeof useApp.getState>['diag']>; onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useApp((s) => s.toast)
  const [report, setReport] = useState<CheckReport | null>(null)
  const [running, setRunning] = useState(false)

  const runCheck = useCallback(async () => {
    setRunning(true)
    setReport(null)
    try {
      setReport(target.mode === 'client' ? await api().client.diagnose(target.address) : await api().host.selfCheck())
    } catch {
      setReport({ target: target.mode === 'client' ? target.address : undefined, items: [], summary: 'checkFailed' })
    } finally {
      setRunning(false)
    }
  }, [target])

  useEffect(() => {
    void runCheck()
  }, [runCheck])

  const tone = !report ? 'pill-accent' : GOOD.has(report.summary) ? 'pill-success' : WARN.has(report.summary) ? 'pill-warning' : 'pill-danger'
  return (
    <div className="diag">
      <h3 className="diag-title">{target.mode === 'client' ? t('diag.title') : t('diag.hostTitle')}</h3>
      {target.mode === 'client' && <div className="faint diag-target">{target.address}</div>}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={report?.summary ?? 'running'} className={`diag-summary pill ${tone}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
          {running && <span className="spinner" style={{ width: 13, height: 13, borderWidth: 2 }} />}
          {report ? t(`diag.summary.${report.summary}`) : t('diag.running')}
        </motion.div>
      </AnimatePresence>

      <div className="diag-list">
        <AnimatePresence initial={false}>
          {report?.items.map((item, i) => {
            const Icon = ICON[item.status]
            return (
              <motion.div
                key={item.id}
                className={`diag-item ${item.status}`}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ ...softSpring, delay: i * 0.04 }}
              >
                <Icon size={18} className="diag-icon" />
                <div className="diag-text">
                  <div className="diag-name">
                    {t(`diag.checks.${item.id}`)}
                    {item.value && <span className="faint diag-value">{item.value}</span>}
                  </div>
                  {item.hint && item.status !== 'ok' && <div className="diag-hint">{t(`diag.hints.${item.hint}`)}</div>}
                </div>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>

      <div className="diag-actions">
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
        <div className="spacer" />
        <Button size="sm" icon={<RefreshCw size={14} />} loading={running} onClick={() => void runCheck()}>
          {t('diag.again')}
        </Button>
        <Button size="sm" variant="primary" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
    </div>
  )
}
