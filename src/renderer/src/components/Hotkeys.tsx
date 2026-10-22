import { AnimatePresence, motion } from 'framer-motion'
import { Keyboard, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_HOTKEYS, type HotkeyName } from '@shared/types'
import { acceleratorFromEvent, isAccelerator } from '@shared/hotkeys'
import { useApp } from '@/store/app'
import { api } from '@/lib/bridge'

/** Как сочетание выглядит для пользователя Windows (Super — это клавиша Win). */
export function showKey(acc: string): string {
  return acc.replace(/\bSuper\b/g, 'Win')
}
import { Button, Row } from '@/components/ui'

const ORDER: HotkeyName[] = ['clientMenu', 'clientMenuAlt', 'hostMenu', 'hostPause', 'hostAllow', 'hostDeny']

/**
 * Поле записи сочетания: нажмите поле, затем сочетание. Esc — отмена, Backspace — выключить.
 * Проверка та же, что в основном процессе (src/shared/hotkeys.ts).
 */
function HotkeyInput({ name, value, onChange }: { name: HotkeyName; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation()
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLButtonElement>(null)
  const all = useApp((s) => s.settings!.hotkeys)

  // Пока записываем, горячие клавиши Streamly отпущены: иначе Alt+F12 в этом поле забрал бы управление у игроков.
  useEffect(() => {
    if (!recording) return
    void api().suspendHotkeys(true)
    return () => void api().suspendHotkeys(false)
  }, [recording])

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      // Tab и Shift+Tab — просто уйти из поля (клавиатура не должна застревать).
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
        setError(null)
        return setRecording(false)
      }
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setError(null)
        return setRecording(false)
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecording(false)
        setError(null)
        return onChange('')
      }
      const acc = acceleratorFromEvent(e)
      // Только модификатор (ждём основную клавишу) или клавиша, которую назначить нельзя.
      if (!acc) return
      if (!isAccelerator(acc)) return setError(t('hotkeys.invalid', { key: acc }))
      const other = ORDER.find((k) => k !== name && all[k] === acc)
      if (other) return setError(t('hotkeys.duplicate', { key: acc, what: t(`hotkeys.names.${other}`) }))
      setError(null)
      setRecording(false)
      onChange(acc)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, all, name, onChange, t])

  return (
    <div className="hotkey-field">
      <button
        ref={ref}
        type="button"
        className={`hotkey-input ${recording ? 'recording' : ''} ${value ? '' : 'empty'}`}
        onClick={() => {
          setError(null)
          setRecording(!recording)
        }}
        onBlur={() => {
          setRecording(false)
          setError(null)
        }}
        aria-label={`${t(`hotkeys.names.${name}`)}: ${recording ? t('hotkeys.press') : value ? showKey(value) : t('hotkeys.off')}`}
        aria-pressed={recording}
      >
        <Keyboard size={14} />
        {recording ? t('hotkeys.press') : value ? showKey(value) : t('hotkeys.off')}
      </button>
      <AnimatePresence initial={false}>
        {error && (
          <motion.div className="hotkey-error" role="status" aria-live="polite" initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            {error}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Горячие клавиши Streamly: меню игрока, меню хоста, пауза, ответы на запросы. */
export function HotkeysCard() {
  const { t } = useTranslation()
  const keys = useApp((s) => s.settings!.hotkeys)
  const status = useApp((s) => s.hotkeys)
  const update = useApp((s) => s.updateSettings)
  const changed = ORDER.some((k) => keys[k] !== DEFAULT_HOTKEYS[k])
  return (
    <div className="card card-pad">
      <div className="section-title">
        <Keyboard size={14} />
        {t('hotkeys.title')}
        <span className="spacer" />
        {changed && (
          <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => void update({ hotkeys: { ...DEFAULT_HOTKEYS } })}>
            {t('hotkeys.reset')}
          </Button>
        )}
      </div>
      <div className="faint hotkeys-hint">{t('hotkeys.hint')}</div>
      {ORDER.map((name) => {
        const st = status[name]
        return (
          <Row
            key={name}
            title={
              <span className="hotkey-title">
                {t(`hotkeys.names.${name}`)}
                {st === 'taken' && <span className="pill pill-warning tag">{t('hotkeys.taken')}</span>}
                {st === 'ok' && <span className="pill pill-success tag">{t('hotkeys.active')}</span>}
              </span>
            }
            hint={t(`hotkeys.hints.${name}`)}
          >
            <HotkeyInput name={name} value={keys[name]} onChange={(v) => void update({ hotkeys: { [name]: v } })} />
          </Row>
        )
      })}
    </div>
  )
}
