import { AnimatePresence, motion } from 'framer-motion'
import { Activity, Eye, EyeOff, Gamepad2, Hand, Headphones, Keyboard, Lock, Mouse, RotateCw, TriangleAlert, Volume1, Volume2, VolumeX, Wand2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { NO_INPUT, type InputPerms } from '@shared/perms'
import type { QualityProfile } from '@shared/types'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '@/store/app'
import { api } from '@/lib/bridge'
import { currentPreset, PRESETS, type Preset } from '@/lib/quality'
import { Button, Collapse, Segmented, Slider, spring, Switch } from '@/components/ui'

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
      <GamepadRow />
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

/**
 * Громкость трансляции: ползунок двигается сразу, а в настройки (и в Windows) значение уходит с паузой.
 * Пока ползунок тянут, эхо прежних сохранений его не дёргает назад.
 */
export function useVolume(): [number, (v: number) => void] {
  const saved = useApp((s) => s.settings!.stream.volume)
  const update = useApp((s) => s.updateSettings)
  const [vol, setVol] = useState(saved)
  const timer = useRef<number | undefined>(undefined)
  const lastChange = useRef(0)
  useEffect(() => {
    if (Date.now() - lastChange.current > 700) setVol(saved)
  }, [saved])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const change = (v: number): void => {
    setVol(v)
    lastChange.current = Date.now()
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void update({ stream: { volume: v } }), 90)
  }
  return [vol, change]
}

function VolumeRow() {
  const { t } = useTranslation()
  const [vol, change] = useVolume()
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
          <motion.div className="sc-hint warn" style={{ overflow: 'hidden' }} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
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
          <motion.div className="sc-apply" style={{ overflow: 'hidden' }} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
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

/**
 * Геймпад двоится или завис: быстрый перезапуск трансляции (хост создаёт виртуальные геймпады заново)
 * и режим «все геймпады как один» против двойных устройств (Steam Input, DS4Windows).
 */
function GamepadRow() {
  const { t } = useTranslation()
  const allowed = useApp((s) => !!s.client.perms?.gamepad)
  const restarting = useApp((s) => !!s.client.restarting)
  const single = useApp((s) => s.settings!.stream.singleGamepad)
  const update = useApp((s) => s.updateSettings)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!restarting) setBusy(false)
  }, [restarting])
  const [showPads, setShowPads] = useState(false)
  const pads = useApp((s) => s.client.pads)
  const identify = useApp((s) => s.client.padIdentify)
  const reset = (): void => {
    setBusy(true)
    void api()
      .client.resetGamepad()
      .then((ok) => !ok && setBusy(false))
  }
  return (
    <div className="sc-block">
      <div className="sc-row inner">
        <span className="sc-icon">
          <Gamepad2 size={18} />
        </span>
        <div className="sc-main">
          <div className="sc-title">{t('stream.gamepadTitle')}</div>
          <div className="sc-hint">{allowed ? t('stream.gamepadHint') : t('stream.gamepadOff')}</div>
        </div>
        {/* Глаз: номера геймпадов у хоста (кто первый игрок, кто второй). */}
        <button
          className={`btn btn-ghost icon-btn pad-eye ${showPads ? 'active' : ''}`}
          onClick={() => setShowPads(!showPads)}
          title={t('stream.padsTitle')}
          aria-label={t('stream.padsTitle')}
          aria-expanded={showPads}
        >
          {showPads ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
        <Button size="sm" icon={<RotateCw size={14} />} loading={busy && restarting} disabled={busy || !allowed} onClick={reset}>
          {t('stream.gamepadReset')}
        </Button>
      </div>
      <Collapse open={showPads}>
        <div className="pads-panel">
          <div className="sc-hint">{t('stream.padsHint')}</div>
          {pads?.length ? (
            <ul className="pads-list">
              {pads.map((p, i) => (
                <li key={`${p.nickname}-${p.slot ?? 0}-${i}`} className={p.you ? 'you' : ''}>
                  <span className={`pad-num ${p.slot ? '' : 'none'}`}>{p.slot ?? '—'}</span>
                  <span className="pad-name">{p.you ? t('stream.padsYou', { name: p.nickname }) : p.nickname}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="sc-hint">{t('stream.padsUnknown')}</div>
          )}
          <div className="sc-apply">
            <span className={`sc-hint ${identify === 'notFound' ? 'warn' : identify === 'done' ? 'ok' : ''}`}>
              {identify === 'waiting' ? t('stream.identifyWaiting') : identify === 'notFound' ? t('stream.identifyNotFound') : identify === 'done' ? t('stream.identifyDone') : t('stream.identifyHint')}
            </span>
            <Button size="sm" icon={<Gamepad2 size={14} />} loading={identify === 'waiting'} disabled={!allowed || identify === 'waiting'} onClick={() => void api().client.identifyPad()}>
              {t('stream.identify')}
            </Button>
          </div>
        </div>
      </Collapse>
      <div className="sc-row inner">
        <span className="sc-icon" />
        <div className="sc-main">
          <div className="sc-title">{t('settings.singleGamepad')}</div>
          <div className="sc-hint">{t('settings.singleGamepadHint')}</div>
        </div>
        <Switch
          checked={single}
          label={t('settings.singleGamepad')}
          onChange={(v) => {
            // Режим меняется только с перезапуском трансляции: делаем его сразу.
            void update({ stream: { singleGamepad: v } }).then(() => reset())
          }}
        />
      </div>
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
          <motion.div className="sc-apply" style={{ overflow: 'hidden' }} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
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
  const reconnecting = useApp((s) => !!s.client.reconnecting || !!s.client.signalLost)
  const signalLost = useApp((s) => !!s.client.signalLost)
  const autoLowered = useApp((s) => s.client.autoLowered)
  const congested = useApp((s) => !!s.client.congested)
  const auto = useApp((s) => s.settings!.stream.autoQuality)
  const { address, quality } = useHostQuality()
  const unstable = (jitter ?? 0) >= 25 || (rtt ?? 0) >= 120
  const economy = currentPreset(quality) === 'economy'
  let text: string | null = null
  if (signalLost) text = t('stream.signalLost')
  else if (reconnecting) text = t('stream.reconnecting')
  else if (poor) text = auto ? t('stream.poorNetworkAuto') : t('stream.poorNetwork')
  else if (congested) text = auto ? t('stream.congestedAuto') : t('stream.congested')
  else if (unstable) text = t('stream.unstable', { jitter: jitter ?? 0, rtt: rtt ?? 0 })
  else if (autoLowered) text = t('stream.autoLowered')
  return (
    <AnimatePresence initial={false}>
      {text && (
        <motion.div className={`sc-warning ${autoLowered && !poor && !congested && !unstable && !reconnecting ? 'info' : ''}`} style={{ overflow: 'hidden' }} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
          {reconnecting ? <RotateCw size={17} className="spin" /> : <TriangleAlert size={17} />}
          <span style={{ flex: 1 }}>{text}</span>
          {!auto && !economy && !reconnecting && (poor || congested || unstable) && (
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
  // Только поля статистики: остальное состояние клиента не перерисовывает блок.
  const c = useApp(
    useShallow((s) => ({
      rttMs: s.client.rttMs,
      jitterMs: s.client.jitterMs,
      speedMbps: s.client.speedMbps,
      probe: s.client.probe,
      queueMs: s.client.queueMs,
      congested: s.client.congested,
      active: s.client.active,
      policy: s.client.policy,
      poorNetwork: s.client.poorNetwork,
      wifi: s.client.wifi,
      relaySuspect: s.client.relaySuspect
    }))
  )
  const enc = c.policy?.encoder
  const items: { label: string; value: string; tone?: 'warn' | 'ok' }[] = [
    {
      label: t('stats.latency'),
      value: c.rttMs !== undefined ? `${c.rttMs} ${t('stats.ms')}${c.jitterMs !== undefined ? ` ± ${c.jitterMs}` : ''}` : '—',
      tone: (c.jitterMs ?? 0) >= 25 || (c.rttMs ?? 0) >= 80 ? 'warn' : undefined
    },
    {
      label: t('stats.channel'),
      // Замер по UDP, не упёршийся в канал: известно только, что канал не меньше.
      value: c.speedMbps === undefined ? t('stats.notMeasured') : c.probe?.kind === 'udp' && !c.probe.saturated ? t('stats.atLeast', { value: c.speedMbps }) : t('settings.mbps', { value: c.speedMbps })
    },
    ...(c.queueMs !== undefined
      ? [{ label: t('stats.queue'), value: c.congested ? `${c.queueMs} ${t('stats.ms')} · ${t('stats.congested')}` : `${c.queueMs} ${t('stats.ms')}`, tone: c.congested ? ('warn' as const) : undefined }]
      : []),
    {
      label: t('stats.quality'),
      value: c.active ? summary(c.active, t) + (c.active.codec ? ` · ${c.active.codec}` : '') + (c.active.auto ? ` · ${t('stream.auto').toLowerCase()}` : '') : '—'
    },
    {
      label: t('stats.encoder'),
      value: enc ? [t(`host.encoders.${enc.vendor}`), [enc.av1 && 'AV1', enc.hevc && 'HEVC'].filter(Boolean).join(', ') || 'H.264'].join(' · ') : '—',
      tone: enc?.vendor === 'software' ? 'warn' : undefined
    },
    {
      label: t('stats.network'),
      value: c.poorNetwork ? t('stats.losing') : c.congested ? t('stats.congested') : c.wifi ? t('stats.wifi') : t('stats.ok'),
      tone: c.poorNetwork || c.congested || c.wifi ? 'warn' : 'ok'
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
