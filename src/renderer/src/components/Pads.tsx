import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronLeft, Gamepad2, RefreshCw, RotateCcw, SkipForward, Wrench } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PadDeviceView, PadRawState } from '@shared/types'
import { buildMapping, detectInput, inputKey, isReleased, PAD_STEPS, type PadTarget } from '@shared/padmap'
import { useApp } from '@/store/app'
import { api } from '@/lib/bridge'
import { Button, Modal, useLastNonNull } from '@/components/ui'

/**
 * Геймпады этого ПК так, как их видит Moonlight. Геймпад без раскладки SDL Moonlight не передаёт хосту
 * (так бывает со старыми DirectInput-геймпадами, которые в Parsec работают): для него — мастер «Настроить кнопки».
 */
export function PadsCard() {
  const { t } = useTranslation()
  const [pads, setPads] = useState<PadDeviceView[] | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [wizard, setWizard] = useState<PadDeviceView | null>(null)
  const mappings = useApp((s) => s.settings!.stream.padMappings)
  const update = useApp((s) => s.updateSettings)

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      setPads(await api().pads.list())
    } catch {
      setPads(null)
    } finally {
      setBusy(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh, mappings])

  const reset = (guid: string): void => {
    // Пустая строка удаляет раскладку (настройки проверяют формат и отбрасывают её).
    void update({ stream: { padMappings: { [guid]: '' } } })
  }

  return (
    <div className="card card-pad">
      <div className="section-title">
        <Gamepad2 size={14} />
        {t('pads.title')}
        <span className="spacer" />
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} className={busy ? 'spin' : undefined} />} onClick={() => void refresh()} disabled={busy}>
          {t('pads.refresh')}
        </Button>
      </div>
      <div className="faint pads-hint">{t('pads.hint')}</div>
      {pads === null && <div className="faint pads-empty">{t('pads.unavailable')}</div>}
      {pads && pads.length === 0 && <div className="faint pads-empty">{t('pads.none')}</div>}
      {pads && pads.length > 0 && (
        <div className="pads-list">
          {pads.map((p) => (
            <div key={p.guid} className="pad-row">
              <Gamepad2 size={18} className="pad-icon" />
              <div className="pad-info">
                <div className="pad-name">{p.name || t('pads.unnamed')}</div>
                <div className="pad-status">
                  {p.custom ? (
                    <span className="pill pill-accent tag">{t('pads.custom')}</span>
                  ) : p.gamepad ? (
                    <span className="pill pill-success tag">{t('pads.ok')}</span>
                  ) : (
                    <span className="pill pill-warning tag">{t('pads.unknown')}</span>
                  )}
                </div>
              </div>
              <div className="pad-actions">
                {p.custom && (
                  <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => reset(p.guid)}>
                    {t('pads.reset')}
                  </Button>
                )}
                {(p.custom || !p.gamepad) && (
                  <Button size="sm" variant={p.custom ? 'default' : 'primary'} icon={<Wrench size={13} />} onClick={() => setWizard(p)}>
                    {p.custom ? t('pads.redo') : t('pads.setup')}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <PadWizard pad={wizard} onClose={() => setWizard(null)} onSaved={() => void refresh()} existing={wizard ? mappings[wizard.guid] : undefined} />
    </div>
  )
}

type Phase = 'rest' | 'steps' | 'done' | 'lost'

/** Мастер раскладки: по очереди просит нажать кнопки и отклонить стики, затем сохраняет раскладку для Moonlight. */
function PadWizard({ pad, onClose, onSaved, existing }: { pad: PadDeviceView | null; onClose: () => void; onSaved: () => void; existing?: string }) {
  const { t } = useTranslation()
  const shown = useLastNonNull(pad)
  const update = useApp((s) => s.updateSettings)
  const toast = useApp((s) => s.toast)
  const [flash, setFlash] = useState<string | null>(null)
  // Шаг, назначения и этап — в ref: опрос геймпада и быстрые нажатия «Пропустить» видят их сразу, без устаревших значений.
  const st = useRef<{ phase: Phase; step: number; binds: Partial<Record<PadTarget, string>> }>({ phase: 'rest', step: 0, binds: {} })
  const [, rerender] = useState(0)
  const apply = (patch: Partial<typeof st.current>): void => {
    st.current = { ...st.current, ...patch }
    rerender((n) => n + 1)
  }
  const { phase, step, binds } = st.current
  const rest = useRef<PadRawState | null>(null)
  const waitRelease = useRef(true)

  // Новый запуск мастера — с чистого листа.
  useEffect(() => {
    if (!pad) return
    apply({ phase: 'rest', step: 0, binds: {} })
    setFlash(null)
    rest.current = null
    waitRelease.current = true
  }, [pad])

  useEffect(() => {
    if (!pad) return
    let stopped = false
    let restSince = 0
    const tick = async (): Promise<void> => {
      const now = await api()
        .pads.state(pad.guid)
        .catch(() => null)
      if (stopped) return
      const cur = st.current
      if (!now) {
        if (cur.phase !== 'done' && cur.phase !== 'lost') apply({ phase: 'lost' })
        return
      }
      if (cur.phase === 'lost') apply({ phase: rest.current ? 'steps' : 'rest' })
      if (st.current.phase === 'rest' || !rest.current) {
        // Состояние покоя: полсекунды ничего не трогают.
        if (!restSince) restSince = Date.now()
        rest.current = now
        if (Date.now() - restSince > 600) {
          apply({ phase: 'steps' })
          waitRelease.current = false
        }
        return
      }
      if (st.current.phase !== 'steps') return
      if (waitRelease.current) {
        if (isReleased(rest.current, now)) waitRelease.current = false
        return
      }
      const target = PAD_STEPS[st.current.step]
      const el = detectInput(rest.current, now, target)
      if (!el) return
      const used = Object.entries(st.current.binds).some(([k, v]) => k !== target && v && inputKey(v) === inputKey(el))
      if (used) return
      waitRelease.current = true
      apply({ binds: { ...st.current.binds, [target]: el } })
      setFlash(target)
      setTimeout(() => setFlash(null), 400)
      advance()
    }
    // Следующий опрос — после ответа на предыдущий: медленный ответ не наложится на следующий.
    const loop = async (): Promise<void> => {
      while (!stopped) {
        await tick()
        await new Promise((r) => setTimeout(r, 40))
      }
    }
    void loop()
    return () => {
      stopped = true
      void api().pads.close()
    }
  }, [pad])

  const advance = (): void => {
    const from = st.current.step
    if (from + 1 >= PAD_STEPS.length) apply({ phase: 'done' })
    else apply({ step: from + 1 })
  }
  const back = (): void => {
    const cur = st.current
    if (cur.phase === 'done') return apply({ phase: 'steps' })
    if (cur.step === 0) return
    const prev = PAD_STEPS[cur.step - 1]
    const b = { ...cur.binds }
    delete b[prev]
    apply({ binds: b, step: cur.step - 1 })
    waitRelease.current = true
  }
  const restart = (): void => {
    apply({ binds: {}, step: 0, phase: 'steps' })
    waitRelease.current = true
  }

  const count = Object.keys(binds).length
  const canSave = !!binds.a && count >= 4
  const save = async (): Promise<void> => {
    if (!shown || !canSave) return
    await update({ stream: { padMappings: { [shown.guid]: buildMapping(shown.guid, shown.name, binds) } } })
    toast({ tone: 'success', text: t('pads.saved', { name: shown.name || t('pads.unnamed') }) })
    onSaved()
    onClose()
  }

  const target = PAD_STEPS[step]
  const progress = phase === 'done' ? 1 : step / PAD_STEPS.length
  return (
    <Modal open={!!pad} onClose={onClose}>
      {shown && (
        <div className="pad-wizard">
          <h3 style={{ margin: '0 0 4px' }}>{t('pads.wizardTitle')}</h3>
          <div className="faint" style={{ marginBottom: 14 }}>
            {shown.name || t('pads.unnamed')}
            {existing ? ` · ${t('pads.overwrite')}` : ''}
          </div>
          <div className="pad-progress">
            <motion.div className="pad-progress-bar" animate={{ width: `${Math.round(progress * 100)}%` }} transition={{ type: 'spring', stiffness: 260, damping: 30 }} />
          </div>
          <div className="pad-prompt" aria-live="polite">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={phase === 'steps' ? target : phase}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.16 }}
              >
                {phase === 'rest' && <div className="pad-prompt-text">{t('pads.rest')}</div>}
                {phase === 'lost' && <div className="pad-prompt-text warn">{t('pads.lost')}</div>}
                {phase === 'steps' && (
                  <>
                    <div className="pad-step-count faint">{t('pads.step', { n: step + 1, total: PAD_STEPS.length })}</div>
                    <div className="pad-prompt-text">{t(`pads.targets.${target}`)}</div>
                    <div className="faint pad-prompt-sub">{t('pads.skipHint')}</div>
                  </>
                )}
                {phase === 'done' && (
                  <>
                    <div className="pad-prompt-text">
                      <Check size={20} /> {t('pads.done', { count })}
                    </div>
                    {!canSave && <div className="faint pad-prompt-sub warn">{t('pads.tooFew')}</div>}
                  </>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
          <div className="pad-binds">
            {PAD_STEPS.filter((s) => binds[s]).map((s) => (
              <span key={s} className={`pill tag ${flash === s ? 'pill-success' : ''}`}>
                {t(`pads.short.${s}`)}
              </span>
            ))}
          </div>
          <div className="pad-wizard-actions">
            <Button variant="ghost" icon={<ChevronLeft size={15} />} onClick={back} disabled={phase === 'rest' || (phase === 'steps' && step === 0)}>
              {t('pads.back')}
            </Button>
            <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={restart} disabled={phase === 'rest'}>
              {t('pads.restart')}
            </Button>
            <span className="spacer" />
            {phase === 'done' ? (
              <Button variant="primary" icon={<Check size={15} />} onClick={() => void save()} disabled={!canSave}>
                {t('pads.save')}
              </Button>
            ) : (
              <Button icon={<SkipForward size={15} />} onClick={advance} disabled={phase !== 'steps'}>
                {t('pads.skip')}
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
