import { AnimatePresence, motion } from 'framer-motion'
import { Gamepad2, Headphones, Keyboard, Lock, Mouse, RotateCw, TriangleAlert, Volume1, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { NO_INPUT, type InputPerms } from '@shared/perms'
import { useApp } from '@/store/app'
import { api } from '@/lib/bridge'
import { currentPreset, PRESETS, type Preset } from '@/lib/quality'
import { Button, Segmented, Slider, spring, Switch } from '@/components/ui'

/**
 * Управление трансляцией у игрока: громкость, Discord хоста, свой ввод, быстрое качество.
 * Используется в меню Alt+F2 и на экране «Идёт трансляция».
 */
export function StreamControls() {
  return (
    <div className="stream-controls">
      <NetworkWarning />
      <VolumeRow />
      <ChatRow />
      <InputRow />
      <QualityRow />
    </div>
  )
}

function VolumeRow() {
  const { t } = useTranslation()
  const saved = useApp((s) => s.settings!.stream.volume)
  const update = useApp((s) => s.updateSettings)
  const [vol, setVol] = useState(saved)
  const timer = useRef<number | undefined>(undefined)
  // Ползунок двигается сразу, а в настройки (и в Windows) значение уходит с небольшой паузой.
  useEffect(() => setVol(saved), [saved])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const change = (v: number): void => {
    setVol(v)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void update({ stream: { volume: v } }), 90)
  }
  const Icon = vol === 0 ? VolumeX : vol < 50 ? Volume1 : Volume2
  return (
    <div className="sc-row">
      <button className="sc-icon btn btn-ghost icon-btn" onClick={() => change(vol === 0 ? 100 : 0)} aria-label={vol === 0 ? t('stream.unmute') : t('stream.mute')} title={vol === 0 ? t('stream.unmute') : t('stream.mute')}>
        <Icon size={18} />
      </button>
      <div className="sc-main">
        <div className="sc-title">{t('stream.volume')}</div>
        <Slider value={vol} onChange={change} label={t('stream.volume')} />
      </div>
      <span className="sc-value">{vol}%</span>
    </div>
  )
}

function ChatRow() {
  const { t } = useTranslation()
  const mute = useApp((s) => s.settings!.stream.muteHostChat)
  const chat = useApp((s) => s.client.hostChat)
  const update = useApp((s) => s.updateSettings)
  let status: { text: string; tone: string }
  if (!chat) status = { text: t('stream.chatUnknown'), tone: '' }
  else if (!chat.control) status = { text: t('stream.chatUnavailable'), tone: 'warn' }
  else if (!mute) status = { text: t('stream.chatIncluded'), tone: '' }
  else if (chat.excluded) status = { text: t('stream.chatExcluded'), tone: 'ok' }
  else status = { text: t('stream.chatPending'), tone: '' }
  return (
    <div className="sc-row">
      <span className="sc-icon">
        <Headphones size={18} />
      </span>
      <div className="sc-main">
        <div className="sc-title">{t('stream.muteChat')}</div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={status.text} className={`sc-hint ${status.tone}`} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.15 }}>
            {status.text}
          </motion.div>
        </AnimatePresence>
      </div>
      <Switch checked={mute} onChange={(v) => void update({ stream: { muteHostChat: v } })} label={t('stream.muteChat')} />
    </div>
  )
}

function InputRow() {
  const { t } = useTranslation()
  const perms = useApp((s) => s.client.perms)
  const selfOff = useApp((s) => s.client.selfOff) ?? NO_INPUT
  const items: { key: keyof InputPerms; icon: ReactNode }[] = [
    { key: 'keyboard', icon: <Keyboard size={17} /> },
    { key: 'mouse', icon: <Mouse size={17} /> },
    { key: 'gamepad', icon: <Gamepad2 size={17} /> }
  ]
  return (
    <div className="sc-block">
      <div className="sc-title">{t('stream.myInput')}</div>
      <div className="sc-hint">{t('stream.myInputHint')}</div>
      <div className="perms">
        {items.map(({ key, icon }) => {
          const byHost = !perms?.[key]
          const on = !byHost && !selfOff[key]
          const label = t(`host.${key}`)
          return (
            <motion.button
              key={key}
              className={`perm ${on ? 'on' : ''}`}
              aria-pressed={on}
              disabled={byHost}
              title={byHost ? t('stream.offByHost') : label}
              onClick={() => void api().client.setSelfOff({ [key]: !selfOff[key] })}
              whileTap={byHost ? undefined : { scale: 0.92 }}
              transition={spring}
            >
              <span className="perm-icon">{byHost ? <Lock size={15} /> : icon}</span>
              {label}
              <motion.span className="perm-led" animate={{ opacity: on ? 1 : 0.25, scale: on ? 1 : 0.7 }} transition={spring} />
            </motion.button>
          )
        })}
      </div>
    </div>
  )
}

function QualityRow() {
  const { t } = useTranslation()
  const st = useApp((s) => s.settings!.stream)
  const restarting = useApp((s) => s.client.restarting)
  const update = useApp((s) => s.updateSettings)
  const applied = currentPreset(st)
  const [choice, setChoice] = useState<Preset | 'custom'>(applied)
  useEffect(() => setChoice(applied), [applied])
  const apply = async (): Promise<void> => {
    if (choice === 'custom') return
    await update({ stream: PRESETS[choice] })
    await api().client.restartStream()
  }
  return (
    <div className="sc-block">
      <div className="sc-title">{t('stream.quality')}</div>
      <Segmented<Preset | 'custom'>
        value={choice}
        onChange={setChoice}
        options={(['economy', 'balanced', 'high', ...(applied === 'custom' ? (['custom'] as const) : [])] as const).map((v) => ({ value: v, label: t(`settings.presets.${v}`) }))}
      />
      <AnimatePresence initial={false}>
        {(choice !== applied || restarting) && (
          <motion.div className="sc-apply" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
            <span className="sc-hint">{restarting ? t('stream.restarting') : t('stream.applyHint')}</span>
            <Button size="sm" variant="primary" icon={<RotateCw size={14} />} loading={restarting} disabled={choice === 'custom'} onClick={() => void apply()}>
              {t('stream.apply')}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Moonlight сообщает о потерях: предлагаем снизить качество в одно нажатие. */
function NetworkWarning() {
  const { t } = useTranslation()
  const poor = useApp((s) => s.client.poorNetwork)
  const jitter = useApp((s) => s.client.jitterMs)
  const rtt = useApp((s) => s.client.rttMs)
  const st = useApp((s) => s.settings!.stream)
  const update = useApp((s) => s.updateSettings)
  const unstable = (jitter ?? 0) >= 25 || (rtt ?? 0) >= 120
  const show = poor || unstable
  const economy = currentPreset(st) === 'economy'
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div className="sc-warning" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
          <TriangleAlert size={17} />
          <span style={{ flex: 1 }}>{poor ? t('stream.poorNetwork') : t('stream.unstable', { jitter: jitter ?? 0, rtt: rtt ?? 0 })}</span>
          {!economy && (
            <Button
              size="sm"
              onClick={() =>
                void update({ stream: PRESETS.economy }).then(() => api().client.restartStream())
              }
            >
              {t('stream.lowerQuality')}
            </Button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
