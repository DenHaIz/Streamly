import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Check, Clock, MonitorPlay, PlugZap, RefreshCw, Search, TriangleAlert, Unplug, X, Stethoscope } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClientState, DiscoveredHost, ErrorCode } from '@shared/types'
import { useApp } from '@/store/app'
import { api } from '@/lib/bridge'
import { Avatar, Button, riseIn, softSpring, spring, stagger } from '@/components/ui'
import { RadminHelp } from '@/components/RadminBadge'
import { ErrorCard } from '@/components/ErrorCard'
import { StreamControls, StreamStats } from '@/components/StreamControls'

const ACTIVE: ClientState['phase'][] = ['connecting', 'waitingApproval', 'pairing', 'launching']

/** Ошибки, при которых полезна «Проверка связи»: она покажет, что именно не так в сети. */
const NETWORK_ERRORS = new Set<ErrorCode>(['host_unreachable', 'host_not_hosting', 'pair_no_request', 'pair_failed', 'stream_timeout', 'stream_failed', 'connection_lost'])

export function Connect() {
  const client = useApp((s) => s.client)
  const radmin = useApp((s) => s.radmin)
  let body
  if (ACTIVE.includes(client.phase)) body = <Progress key="progress" client={client} />
  else if (client.phase === 'streaming') body = <Streaming key="streaming" client={client} />
  else if (client.phase === 'error' || client.phase === 'ended') body = <Result key="result" client={client} />
  else if (!radmin.connected) body = <NoRadmin key="radmin" />
  else body = <HostList key="list" />
  return (
    <div className="page-inner">
      <AnimatePresence mode="wait">{body}</AnimatePresence>
    </div>
  )
}

const fade = {
  initial: { opacity: 0, y: 16, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -10, scale: 0.98 },
  transition: softSpring
}

function NoRadmin() {
  return (
    <motion.div className="card card-pad center-card" {...fade}>
      <RadminHelp />
    </motion.div>
  )
}

/** Повторный клик, пока подключение уже запускается, не должен обрывать первую попытку. */
let connectingUntil = 0
function connectOnce(address: string): void {
  if (Date.now() < connectingUntil) return
  connectingUntil = Date.now() + 1500
  void api().client.connect(address)
}

const isIp = (s: string): boolean => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((n) => Number(n) <= 255)

function HostList() {
  const { t } = useTranslation()
  const hosts = useApp((s) => s.hosts)
  const [searching, setSearching] = useState(false)
  const [manual, setManual] = useState('')

  const discover = async (visible: boolean): Promise<void> => {
    if (visible) setSearching(true)
    try {
      await api().client.discover()
    } finally {
      if (visible) setSearching(false)
    }
  }

  useEffect(() => {
    void discover(true)
    // Фоновое обновление списка не трогает индикатор поиска, чтобы статус не мигал.
    const timer = setInterval(() => void discover(!useApp.getState().hosts.some((h) => h.online)), 10_000)
    return () => clearInterval(timer)
  }, [])

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    if (isIp(manual.trim())) connectOnce(manual.trim())
  }

  return (
    <motion.div {...fade}>
      <div className="page-header">
        <h1 className="page-title">{t('connect.title')}</h1>
        <div className="spacer" />
        <Button variant="ghost" icon={<RefreshCw size={16} className={searching ? 'spin' : ''} />} onClick={() => void discover(true)} disabled={searching}>
          {t('connect.refresh')}
        </Button>
      </div>

      <div className="radar-row card card-pad">
        <div className={`radar ${searching ? 'active' : ''}`}>
          <span />
          <span />
          <span />
          <Search size={18} />
        </div>
        <div style={{ flex: 1 }}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={searching ? 's' : hosts.length ? 'f' : 'n'} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }} style={{ fontWeight: 600 }}>
              {searching ? t('connect.searching') : hosts.some((h) => h.online) ? t('connect.found') : t('connect.nothing')}
            </motion.div>
          </AnimatePresence>
          {!searching && !hosts.some((h) => h.online) && <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>{t('connect.nothingHint')}</div>}
        </div>
      </div>

      <motion.div className="hosts" variants={stagger} initial="hidden" animate="show" layout>
        <AnimatePresence initial={false}>
          {hosts.map((h) => (
            <HostCard key={h.address} h={h} />
          ))}
        </AnimatePresence>
      </motion.div>

      <motion.form className="card card-pad manual" onSubmit={submit} variants={riseIn} initial="hidden" animate="show">
        <label className="field" style={{ flex: 1 }}>
          <span className="field-label">{t('connect.manual')}</span>
          <input className="input" placeholder={t('connect.manualPlaceholder')} value={manual} onChange={(e) => setManual(e.target.value.replace(/[^\d.]/g, ''))} maxLength={15} inputMode="decimal" />
        </label>
        <Button
          type="button"
          variant="ghost"
          disabled={!isIp(manual.trim())}
          icon={<Stethoscope size={16} />}
          style={{ alignSelf: 'flex-end' }}
          onClick={() => useApp.getState().openDiag({ mode: 'client', address: manual.trim() })}
        >
          {t('connect.check')}
        </Button>
        <Button type="submit" variant="primary" disabled={!isIp(manual.trim())} icon={<PlugZap size={16} />} style={{ alignSelf: 'flex-end' }}>
          {t('connect.connect')}
        </Button>
      </motion.form>
    </motion.div>
  )
}

function HostCard({ h }: { h: DiscoveredHost }) {
  const { t } = useTranslation()
  const full = h.online && h.slotsUsed >= h.maxSlots
  return (
    <motion.button
      layout
      variants={riseIn}
      className={`card host-card ${h.online ? '' : 'offline'}`}
      initial="hidden"
      animate="show"
      exit={{ opacity: 0, scale: 0.95 }}
      whileHover={h.online && !full ? { y: -3 } : undefined}
      whileTap={h.online && !full ? { scale: 0.98 } : undefined}
      transition={softSpring}
      onClick={() => h.online && !full && connectOnce(h.address)}
      disabled={!h.online || full}
    >
      <Avatar name={h.name} />
      <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
        <div className="player-name">
          <span className="name-text">{h.name}</span>
        </div>
        <div className="faint" style={{ fontSize: 12.5 }}>
          {h.address}
          {h.source === 'recent' && ` · ${t('connect.recent')}`}
        </div>
      </div>
      {h.online ? (
        <span className={`pill ${full ? 'pill-warning' : 'pill-success'}`}>
          <span className="dot" />
          {full ? t('connect.full') : t('connect.slots', { used: h.slotsUsed, max: h.maxSlots })}
        </span>
      ) : (
        <span className="pill">{t('common.offline')}</span>
      )}
      {h.online && !full && <ArrowRight size={18} className="faint" />}
    </motion.button>
  )
}

function Progress({ client }: { client: ClientState }) {
  const { t } = useTranslation()
  const steps: ClientState['phase'][] = ['connecting', 'waitingApproval', 'pairing', 'launching']
  const current = steps.indexOf(client.phase)
  const name = client.host?.name ?? client.host?.address ?? ''
  return (
    <motion.div className="card card-pad center-card" {...fade}>
      <div className="connect-hero">
        <div className="pulse-ring" />
        <Avatar name={name} size={64} />
      </div>
      <h2 className="card-title name-title">{name}</h2>
      <div className="steps">
        {steps.map((s, i) => {
          const state = i < current ? 'done' : i === current ? 'active' : 'todo'
          return (
            <motion.div key={s} className={`step step-${state}`} layout transition={spring}>
              <span className="step-icon">{state === 'done' ? <Check size={14} /> : state === 'active' ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : i + 1}</span>
              {t(`connect.steps.${s}`)}
            </motion.div>
          )
        })}
      </div>
      <AnimatePresence mode="wait">
        {client.phase === 'waitingApproval' && (
          <motion.p key="approval" className="muted" initial={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }} animate={{ opacity: 1, height: 'auto', marginTop: 8, marginBottom: 0 }} exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }} style={{ overflow: 'hidden' }}>
            {t('connect.approvalHint')}
          </motion.p>
        )}
        {client.measuring && (
          <motion.p key="measuring" className="muted" initial={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }} animate={{ opacity: 1, height: 'auto', marginTop: 8, marginBottom: 0 }} exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }} style={{ overflow: 'hidden' }}>
            {t('connect.measuring')}
          </motion.p>
        )}
        {!client.measuring && (client.phase === 'pairing' || client.phase === 'launching') && (
          <motion.p key="firewall" className="faint" initial={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }} animate={{ opacity: 1, height: 'auto', marginTop: 8, marginBottom: 0 }} exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }} style={{ overflow: 'hidden', fontSize: 12.5 }}>
            {t('connect.firewallHint')}
          </motion.p>
        )}
      </AnimatePresence>
      <Button variant="ghost" icon={<X size={16} />} onClick={() => void api().client.cancel()}>
        {t('common.cancel')}
      </Button>
    </motion.div>
  )
}

function useElapsed(since?: number): string {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  if (!since) return '0:00'
  const s = Math.max(0, Math.floor((now - since) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

function Streaming({ client }: { client: ClientState }) {
  const { t } = useTranslation()
  const elapsed = useElapsed(client.startedAt)
  const menuKey = useApp((s) => s.settings!.hotkeys.clientMenu || s.settings!.hotkeys.clientMenuAlt)
  return (
    <motion.div className="card card-pad center-card stream-card" {...fade}>
      <motion.div className="setup-orb success" initial={{ scale: 0.5, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 14 }}>
        <MonitorPlay size={28} />
      </motion.div>
      <h2 className="card-title">{t('connect.streamingTitle')}</h2>
      <div className="pill pill-danger" style={{ margin: '0 auto 12px' }}>
        <span className="dot pulse" />
        {client.host?.name} · <Clock size={12} /> {elapsed}
      </div>
      <div className="stream-facts">
        {client.rttMs !== undefined && <span className="pill">{t('connect.latency', { ms: client.rttMs })}</span>}
        {client.jitterMs !== undefined && client.jitterMs >= 10 && <span className="pill pill-warning">{t('connect.jitter', { ms: client.jitterMs })}</span>}
        {client.policy?.hostAudio && <span className="pill">{t('connect.hostAudio')}</span>}
        {!!client.policy?.maxBitrateKbps && <span className="pill">{t('connect.bitrateCap', { mbps: Math.round(client.policy.maxBitrateKbps / 1000) })}</span>}
      </div>
      <div className="kbd-hint">
        <kbd className="kbd">{menuKey || '—'}</kbd>
        <span>{t('connect.overlayHint')}</span>
      </div>
      <StreamStats withMoonlight />
      <StreamControls />
      <Button variant="danger" icon={<Unplug size={16} />} onClick={() => void api().client.cancel()}>
        {t('connect.disconnect')}
      </Button>
    </motion.div>
  )
}

function Result({ client }: { client: ClientState }) {
  const { t } = useTranslation()
  const ended = client.phase === 'ended'
  const address = client.host?.address
  const canRetry = address && client.error !== 'kicked' && client.error !== 'denied' && client.error !== 'moonlight_missing'
  if (!ended) {
    return (
      <ErrorCard
        code={client.error ?? 'unknown'}
        detail={[
          client.host && client.host.name !== client.host.address ? `${client.host.name} (${client.host.address})` : client.host?.address,
          client.errorDetail
        ]
          .filter(Boolean)
          .join('\n')}
        actions={
          <>
            <Button onClick={() => void api().client.reset()}>{t('connect.toHosts')}</Button>
            {address && NETWORK_ERRORS.has(client.error ?? 'unknown') && (
              <Button icon={<Stethoscope size={16} />} onClick={() => useApp.getState().openDiag({ mode: 'client', address })}>
                {t('connect.check')}
              </Button>
            )}
            {canRetry && (
              <Button variant="primary" icon={<RefreshCw size={16} />} onClick={() => void api().client.connect(address)}>
                {t('common.retry')}
              </Button>
            )}
          </>
        }
      />
    )
  }
  return (
    <motion.div className="card card-pad center-card" {...fade}>
      <motion.div className={`setup-orb ${ended ? '' : 'danger'}`} initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 15 }}>
        {ended ? <Check size={28} /> : <TriangleAlert size={28} />}
      </motion.div>
      <h2 className="card-title">{ended ? t('connect.endedTitle') : t(`errors.${client.error ?? 'unknown'}`)}</h2>
      {ended && <p className="muted">{t('connect.endedText')}</p>}
      {!ended && client.errorDetail && <p className="faint error-detail">{client.errorDetail}</p>}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 8 }}>
        <Button onClick={() => void api().client.reset()}>{t('connect.toHosts')}</Button>
        {address && client.error !== 'kicked' && client.error !== 'denied' && (
          <Button variant="primary" icon={<RefreshCw size={16} />} onClick={() => void api().client.connect(address)}>
            {ended ? t('connect.again') : t('common.retry')}
          </Button>
        )}
      </div>
    </motion.div>
  )
}
