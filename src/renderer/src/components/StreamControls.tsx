import { AnimatePresence, motion } from 'framer-motion'
import { Activity, Gamepad2, Hand, Headphones, Keyboard, Lock, Mouse, RotateCw, TriangleAlert, Volume1, Volume2, VolumeX, Wand2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { NO_INPUT, type InputPerms } from '@shared/perms'
import type { QualityProfile } from '@shared/types'
import { useApp } from '@/store/app'
import { api } from '@/lib/bridge'
import { currentPreset, PRESETS, type Preset } from '@/lib/quality'
import { Button, Segmented, Slider, spring, Switch } from '@/components/ui'

/**
 * Управление трансляцией у игрока: громкость, Discord хоста, свой ввод, качество.
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

/** Качество, которое сейчас действует для этого хоста: своё для хоста или общее. */
function useHostQuality(): { address?: string; quality: QualityProfile; perHost: boolean } {
  const st = useApp((s) => s.settings!.stream)
  const hostQuality = useApp((s) => s.settings!.hostQuality)
  const address = useApp((s) => s.client.host?.address)
  const own = address ? hostQuality[address] : undefined
  return { address, quality: own ?? { resolution: st.resolution, fps: st.fps, bitrateKbps: st.bitrateKbps }, perHost: !!own }
}

/** Запомнить качество для текущего хоста и перезапустить трансляцию. */
async function applyHostQuality(address: string | undefined, q: QualityProfile): Promise<void> {
  const update = useApp.getState().updateSettings
  if (address) await update({ hostQuality: { [address]: q } })
  else await update({ stream: q })
  await api().client.restartStream()
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
  const request = useApp((s) => s.client.inputRequest)
  const paused = useApp((s) => s.client.inputPaused)
  const items: { key: keyof InputPerms; icon: ReactNode }[] = [
    { key: 'keyboard', icon: <Keyboard size={17} /> },
    { key: 'mouse', icon: <Mouse size={17} /> },
    { key: 'gamepad', icon: <Gamepad2 size={17} /> }
  ]
  const locked = items.filter(({ key }) => !perms?.[key]).map(({ key }) => key)
  const ask = (): void => void api().client.requestInput(Object.fromEntries(locked.map((k) => [k, true])))
  return (
    <div className="sc-block">
      <div className="sc-title">{t('stream.myInput')}</div>
      <div className="sc-hint">{t('stream.myInputHint')}</div>
      <AnimatePresence initial={false}>
        {paused && (
          <motion.div className="sc-hint warn" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            {t('stream.pausedByHost')}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="perms">
        {items.map(({ key, icon }) => {
          const byHost = !perms?.[key]
          const on = !byHost && !selfOff[key] && !paused
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
      <AnimatePresence initial={false}>
        {locked.length > 0 && (
          <motion.div className="sc-apply" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
            <span className={`sc-hint ${request === 'denied' ? 'warn' : ''}`}>
              {request === 'pending' ? t('stream.requestPending') : request === 'denied' ? t('stream.requestDenied') : t('stream.requestHint')}
            </span>
            <Button size="sm" icon={<Hand size={14} />} loading={request === 'pending'} disabled={request === 'denied'} onClick={ask}>
              {t('stream.requestControl')}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function QualityRow() {
  const { t } = useTranslation()
  const auto = useApp((s) => s.settings!.stream.autoQuality)
  const active = useApp((s) => s.client.active)
  const restarting = useApp((s) => s.client.restarting)
  const update = useApp((s) => s.updateSettings)
  const { address, quality, perHost } = useHostQuality()
  const applied = currentPreset(quality)
  const [choice, setChoice] = useState<Preset | 'custom'>(applied)
  useEffect(() => setChoice(applied), [applied])
  return (
    <div className="sc-block">
      <div className="sc-row-head">
        <div className="sc-title">{t('stream.quality')}</div>
        <label className="sc-auto">
          <Wand2 size={14} />
          {t('stream.auto')}
          <Switch checked={auto} onChange={(v) => void update({ stream: { autoQuality: v } })} label={t('settings.autoQuality')} />
        </label>
      </div>
      {auto ? (
        <div className="sc-hint">{active?.auto ? t('stream.autoActive', { summary: summary(active, t) }) : t('stream.autoNext')}</div>
      ) : (
        <>
          <Segmented<Preset | 'custom'>
            value={choice}
            onChange={setChoice}
            options={(['economy', 'balanced', 'high', ...(applied === 'custom' ? (['custom'] as const) : [])] as const).map((v) => ({ value: v, label: t(`settings.presets.${v}`) }))}
          />
          {perHost && choice === applied && <div className="sc-hint">{t('stream.perHost')}</div>}
        </>
      )}
      <AnimatePresence initial={false}>
        {((!auto && choice !== applied) || restarting) && (
          <motion.div className="sc-apply" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
            <span className="sc-hint">{restarting ? t('stream.restarting') : t('stream.applyHint')}</span>
            <Button
              size="sm"
              variant="primary"
              icon={<RotateCw size={14} />}
              loading={restarting}
              disabled={choice === 'custom'}
              onClick={() => choice !== 'custom' && void applyHostQuality(address, PRESETS[choice])}
            >
              {t('stream.apply')}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

type TFn = (k: string, o?: Record<string, unknown>) => string

function summary(a: { width: number; height: number; fps: number; bitrateKbps: number }, t: TFn): string {
  return [a.height ? `${a.height}p` : null, `${a.fps} FPS`, a.bitrateKbps ? t('settings.mbps', { value: Math.round(a.bitrateKbps / 100) / 10 }) : t('settings.bitrateAuto')]
    .filter(Boolean)
    .join(' · ')
}

/** Moonlight сообщает о потерях: предлагаем снизить качество в одно нажатие. */
function NetworkWarning() {
  const { t } = useTranslation()
  const poor = useApp((s) => s.client.poorNetwork)
  const jitter = useApp((s) => s.client.jitterMs)
  const rtt = useApp((s) => s.client.rttMs)
  const reconnecting = useApp((s) => s.client.reconnecting)
  const autoLowered = useApp((s) => s.client.autoLowered)
  const auto = useApp((s) => s.settings!.stream.autoQuality)
  const { address, quality } = useHostQuality()
  const unstable = (jitter ?? 0) >= 25 || (rtt ?? 0) >= 120
  const economy = currentPreset(quality) === 'economy'
  let text: string | null = null
  if (reconnecting) text = t('stream.reconnecting')
  else if (poor) text = auto ? t('stream.poorNetworkAuto') : t('stream.poorNetwork')
  else if (unstable) text = t('stream.unstable', { jitter: jitter ?? 0, rtt: rtt ?? 0 })
  else if (autoLowered) text = t('stream.autoLowered')
  return (
    <AnimatePresence initial={false}>
      {text && (
        <motion.div className={`sc-warning ${autoLowered && !poor && !unstable && !reconnecting ? 'info' : ''}`} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
          {reconnecting ? <RotateCw size={17} className="spin" /> : <TriangleAlert size={17} />}
          <span style={{ flex: 1 }}>{text}</span>
          {!auto && !economy && !reconnecting && (poor || unstable) && (
            <Button size="sm" onClick={() => void applyHostQuality(address, PRESETS.economy)}>
              {t('stream.lowerQuality')}
            </Button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * Статистика трансляции: задержка и разброс, канал, качество, кодировщик хоста, сеть.
 * «Подробно» включает статистику самого Moonlight поверх картинки.
 */
export function StreamStats({ withMoonlight }: { withMoonlight?: boolean }) {
  const { t } = useTranslation()
  const c = useApp((s) => s.client)
  const enc = c.policy?.encoder
  const items: { label: string; value: string; tone?: 'warn' | 'ok' }[] = [
    {
      label: t('stats.latency'),
      value: c.rttMs !== undefined ? `${c.rttMs} ${t('stats.ms')}${c.jitterMs !== undefined ? ` ± ${c.jitterMs}` : ''}` : '—',
      tone: (c.jitterMs ?? 0) >= 25 || (c.rttMs ?? 0) >= 80 ? 'warn' : undefined
    },
    { label: t('stats.channel'), value: c.speedMbps !== undefined ? t('settings.mbps', { value: c.speedMbps }) : t('stats.notMeasured') },
    { label: t('stats.quality'), value: c.active ? summary(c.active, t) + (c.active.auto ? ` · ${t('stream.auto').toLowerCase()}` : '') : '—' },
    {
      label: t('stats.encoder'),
      value: enc ? [t(`host.encoders.${enc.vendor}`), [enc.av1 && 'AV1', enc.hevc && 'HEVC'].filter(Boolean).join(', ') || 'H.264'].join(' · ') : '—',
      tone: enc?.vendor === 'software' ? 'warn' : undefined
    },
    {
      label: t('stats.network'),
      value: c.poorNetwork ? t('stats.losing') : c.wifi ? t('stats.wifi') : t('stats.ok'),
      tone: c.poorNetwork || c.wifi ? 'warn' : 'ok'
    }
  ]
  return (
    <div className="sc-block stats-block">
      <div className="sc-row-head">
        <div className="sc-title">
          <Activity size={14} /> {t('stats.title')}
        </div>
        {withMoonlight && (
          <Button size="sm" variant="ghost" onClick={() => void api().overlay.toggleStats()} title={t('stats.moonlightHint')}>
            {t('stats.moonlight')}
          </Button>
        )}
      </div>
      <div className="stats-grid">
        {items.map((i) => (
          <div key={i.label} className="stat">
            <span className="stat-label">{i.label}</span>
            <span className={`stat-value ${i.tone ?? ''}`}>{i.value}</span>
          </div>
        ))}
      </div>
      {(c.relaySuspect || c.wifi || enc?.vendor === 'software') && (
        <div className="stats-tips">
          {c.relaySuspect && <div className="sc-hint warn">{t('stats.relayTip')}</div>}
          {c.wifi && <div className="sc-hint">{t('stats.wifiTip')}</div>}
          {enc?.vendor === 'software' && <div className="sc-hint warn">{t('stats.softwareTip')}</div>}
        </div>
      )}
    </div>
  )
}
