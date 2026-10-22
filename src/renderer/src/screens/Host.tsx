import { AnimatePresence, motion, useAnimate } from 'framer-motion'
import {
  Check,
  Copy,
  Download,
  Cpu,
  Gamepad2,
  Hand,
  Headphones,
  Info,
  Keyboard,
  LogIn,
  Mouse,
  Power,
  RefreshCcw,
  RotateCw,
  Send,
  Server,
  ShieldCheck,
  Stethoscope,
  Upload,
  TriangleAlert,
  UserMinus,
  Radio,
  UserPlus,
  Users,
  WifiOff,
  X
} from 'lucide-react'
import { memo, useEffect, useState, type ReactNode, type Ref } from 'react'
import { inviteMessage } from '@shared/invite'
import { useTranslation } from 'react-i18next'
import type { InputPerms } from '@shared/perms'
import type { HostState, JoinRequestView, PlayerView } from '@shared/types'
import { useApp } from '@/store/app'
import { autoBitrateCap } from '@shared/quality'
import { api } from '@/lib/bridge'
import { Avatar, Button, Modal, riseIn, softSpring, spring, stagger } from '@/components/ui'
import { RadminHelp } from '@/components/RadminBadge'
import { ErrorCard } from '@/components/ErrorCard'

const VIGEM_URL = 'https://github.com/nefarius/ViGEmBus/releases'

export function Host() {
  const host = useApp((s) => s.host)
  const radmin = useApp((s) => s.radmin)
  // true, пока запуск запрошен, а хост ещё не ушёл из 'idle' (чтобы не мигала карточка «остановлен»).
  const [starting, setStarting] = useState(false)
  const { t } = useTranslation()
  const retryLabel = t('common.retry')

  const start = (): void => {
    setStarting(true)
    void api()
      .host.start()
      .catch(() => useApp.getState().toast({ tone: 'danger', text: t('errors.unknown') }))
      .finally(() => setStarting(false))
  }

  // Заходя на экран (или когда появилась сеть Radmin), сразу запускаем хост: пользователь уже нажал «Я хост».
  // Только при входе: после «Остановить» экран не должен перезапускать хост сам.
  useEffect(() => {
    const h = useApp.getState().host
    const waitingForRadmin = h?.phase === 'error' && h.error === 'no_radmin'
    if (radmin.connected && (!h || h.phase === 'idle' || waitingForRadmin)) start()
  }, [radmin.connected])

  let body: ReactNode
  if (!radmin.connected && host?.phase !== 'running') {
    body = (
      <motion.div key="radmin" className="card card-pad center-card" {...fade}>
        <RadminHelp />
      </motion.div>
    )
  } else if (host?.phase === 'idle' && !starting) {
    body = <Stopped key="stopped" onStart={start} />
  } else if (!host || ['idle', 'checking', 'configuring', 'installing'].includes(host.phase)) {
    body = <SetupProgress key="progress" phase={host?.phase ?? 'checking'} />
  } else if (host.phase === 'needsInstall') {
    body = <NeedsInstall key="install" error={host.error} />
  } else if (host.phase === 'needsCredentials') {
    body = <Credentials key="creds" />
  } else if (host.phase === 'error') {
    body = (
      <ErrorCard
        key="error"
        code={host.error ?? 'unknown'}
        detail={host.errorDetail}
        actions={
          <Button variant="primary" icon={<RotateCw size={16} />} onClick={start} loading={starting}>
            {retryLabel}
          </Button>
        }
      />
    )
  } else {
    body = <Dashboard key="dash" host={host} />
  }

  return (
    <div className="page-inner">
      <AnimatePresence mode="wait">{body}</AnimatePresence>
    </div>
  )
}

function Stopped({ onStart }: { onStart: () => void }) {
  const { t } = useTranslation()
  return (
    <motion.div className="card card-pad center-card" {...fade}>
      <div className="setup-orb">
        <Power size={28} />
      </div>
      <h2 className="card-title">{t('host.stoppedTitle')}</h2>
      <p className="muted">{t('host.stoppedText')}</p>
      <Button variant="primary" size="lg" icon={<Radio size={18} />} onClick={onStart}>
        {t('host.start')}
      </Button>
    </motion.div>
  )
}

const fade = {
  initial: { opacity: 0, y: 16, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -10, scale: 0.98 },
  transition: softSpring
}

function SetupProgress({ phase }: { phase: HostState['phase'] }) {
  const { t } = useTranslation()
  const steps: { key: HostState['phase']; label: string }[] = [
    { key: 'checking', label: t('host.checking') },
    ...(phase === 'installing' ? [{ key: 'installing' as const, label: t('host.installing') }] : []),
    { key: 'configuring', label: t('host.configuring') }
  ]
  const current = Math.max(0, steps.findIndex((s) => s.key === phase))
  return (
    <motion.div className="card card-pad center-card" {...fade}>
      <div className="setup-orb">
        <div className="setup-orb-ring" />
        <Server size={28} />
      </div>
      <div className="steps">
        {steps.map((s, i) => {
          const state = i < current ? 'done' : i === current ? 'active' : 'todo'
          return (
            <motion.div key={s.key} className={`step step-${state}`} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ ...spring, delay: i * 0.08 }}>
              <span className="step-icon">{state === 'done' ? <Check size={14} /> : state === 'active' ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : i + 1}</span>
              {s.label}
            </motion.div>
          )
        })}
      </div>
      {phase === 'installing' && <p className="muted">{t('host.installHint')}</p>}
      {phase !== 'installing' && (
        <Button
          variant="ghost"
          icon={<X size={16} />}
          onClick={() => {
            useApp.getState().go('home')
            void api().host.stop()
          }}
        >
          {t('common.cancel')}
        </Button>
      )}
    </motion.div>
  )
}

function NeedsInstall({ error }: { error?: string }) {
  const { t } = useTranslation()
  return (
    <motion.div className="card card-pad center-card" {...fade}>
      <div className="setup-orb">
        <Download size={28} />
      </div>
      <h2 className="card-title">{t('host.needsInstallTitle')}</h2>
      <p className="muted">{t('host.needsInstallText')}</p>
      {error && <div className="pill pill-warning" style={{ marginBottom: 14 }}>{t(`errors.${error}`)}</div>}
      <Button variant="primary" size="lg" icon={<ShieldCheck size={18} />} onClick={() => void api().host.install()}>
        {t('host.install')}
      </Button>
    </motion.div>
  )
}

function Credentials() {
  const { t } = useTranslation()
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [bad, setBad] = useState(false)
  const [busy, setBusy] = useState(false)
  const [scope, animate] = useAnimate<HTMLInputElement>()
  const shake = (): void => {
    if (!scope.current) return
    void animate(scope.current, { x: [0, -8, 8, -5, 5, 0] }, { duration: 0.4 })
    scope.current.focus()
    scope.current.select()
  }
  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const ok = await api().host.submitCredentials(user, pass)
      setBad(!ok)
      if (!ok) shake()
    } catch {
      setBad(true)
      shake()
    } finally {
      setBusy(false)
    }
  }
  return (
    <motion.form
      className="card card-pad center-card"
      {...fade}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="setup-orb">
        <LogIn size={26} />
      </div>
      <h2 className="card-title">{t('host.credentialsTitle')}</h2>
      <p className="muted">{t('host.credentialsText')}</p>
      <div style={{ display: 'grid', gap: 12, textAlign: 'left', margin: '6px 0 18px' }}>
        <input className={`input ${bad ? 'invalid' : ''}`} placeholder={t('host.username')} aria-label={t('host.username')} autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} autoFocus />
        <input
          ref={scope}
          className={`input ${bad ? 'invalid' : ''}`}
          type="password"
          placeholder={t('host.password')}
          aria-label={t('host.password')}
          autoComplete="current-password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />
        <AnimatePresence>
          {bad && (
            <motion.div className="pill pill-danger" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 26 }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden' }}>
              {t('host.wrongCredentials')}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!user || !pass}>
        {t('host.signIn')}
      </Button>
    </motion.form>
  )
}

function CopyAddress({ address }: { address: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <motion.button
      className="address"
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.97 }}
      transition={spring}
      onClick={() => {
        void api().copyText(address)
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      }}
      title={t('common.copy')}
    >
      <span className="address-ip">{address}</span>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={copied ? 'ok' : 'copy'}
          className={`address-icon ${copied ? 'ok' : ''}`}
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.4, opacity: 0 }}
          transition={spring}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  )
}

function SlotMeter({ used, max }: { used: number; max: number }) {
  return (
    <div className="slots">
      {Array.from({ length: max }, (_, i) => (
        <motion.span key={i} className={`slot ${i < used ? 'on' : ''}`} initial={false} animate={{ scale: i < used ? 1 : 0.85 }} transition={spring} />
      ))}
    </div>
  )
}

function Dashboard({ host }: { host: HostState }) {
  const { t, i18n } = useTranslation()
  const go = useApp((s) => s.go)
  const [confirmStop, setConfirmStop] = useState(false)
  const [confirmKickAll, setConfirmKickAll] = useState(false)
  const [stopping, setStopping] = useState(false)
  const capKbps = useApp((s) => s.settings?.host.maxBitrateKbps ?? 0)
  const toast = useApp((s) => s.toast)
  // Готовый текст-приглашение: что сделать другу, чтобы подключиться.
  const invite = async (): Promise<void> => {
    const inv = await api().host.createInvite()
    void api().copyText(inviteMessage(i18n.language === 'en' ? 'en' : 'ru', { name: host.hostName, address: host.address ?? '', link: inv?.link ?? '' }))
    toast({ tone: 'success', text: t('host.inviteCopied') }, 6000)
  }
  const stop = (): void => {
    if (stopping) return
    setStopping(true)
    setConfirmStop(false)
    // Сначала уходим с экрана, иначе он успел бы показать промежуточное состояние остановки.
    go('home')
    void api().host.stop()
  }
  return (
    <motion.div {...fade} transition={softSpring}>
      <div className="page-header">
        <h1 className="page-title">{t('host.title')}</h1>
        <span className="pill pill-danger">
          <span className="dot pulse" />
          {t('host.live')}
        </span>
        <div className="spacer" />
        <div className="host-actions">
          <Button variant="ghost" icon={<Stethoscope size={16} />} title={t('host.selfCheck')} aria-label={t('host.selfCheck')} onClick={() => useApp.getState().openDiag({ mode: 'host' })}>
            <span className="btn-label collapsible">{t('host.selfCheck')}</span>
          </Button>
          {host.players.length > 0 && (
            <Button
              variant={host.inputPaused ? 'primary' : 'ghost'}
              icon={<Hand size={16} />}
              title={`${host.inputPaused ? t('host.resumeInput') : t('host.pauseInput')} (Alt+F12)`}
              aria-label={host.inputPaused ? t('host.resumeInput') : t('host.pauseInput')}
              onClick={() => void api().host.setInputPaused(!host.inputPaused)}
            >
              <span className="btn-label collapsible">{host.inputPaused ? t('host.resumeInput') : t('host.pauseInput')}</span>
            </Button>
          )}
          <Button icon={<Send size={16} />} title={t('host.invite')} aria-label={t('host.invite')} onClick={() => void invite()}>
            <span className="btn-label collapsible">{t('host.invite')}</span>
          </Button>
          {host.players.length > 1 && (
            <Button icon={<UserMinus size={16} />} onClick={() => setConfirmKickAll(true)}>
              {t('host.kickAll')}
            </Button>
          )}
          <Button variant="danger" icon={<Power size={16} />} loading={stopping} onClick={() => (host.players.length ? setConfirmStop(true) : stop())}>
            {t('host.stop')}
          </Button>
        </div>
      </div>

      <motion.div className="host-grid" variants={stagger} initial="hidden" animate="show">
        <motion.div variants={riseIn} className="card card-pad address-card">
          <div className="section-title">{t('host.yourAddress')}</div>
          {host.address && <CopyAddress address={host.address} />}
          <p className="faint" style={{ margin: '10px 0 0', fontSize: 12.5 }}>
            {t('host.addressHint')}
          </p>
        </motion.div>
        <motion.div variants={riseIn} className="card card-pad slots-card">
          <div className="section-title">
            <Users size={14} />
            {t('host.players')}
          </div>
          <div className="slots-count">{t('host.slots', { used: host.players.length, max: host.maxPlayers })}</div>
          <SlotMeter used={host.players.length} max={host.maxPlayers} />
          {host.players.length > 0 && (host.uploadMbps !== undefined || capKbps !== 0) && (
            <div className="upload-note" title={t('host.uploadHint')}>
              <Upload size={13} />
              {host.uploadMbps !== undefined
                ? t('host.uploadNow', { mbps: host.uploadMbps })
                : t('host.upload', { mbps: Math.round((host.players.length * (capKbps === -1 ? autoBitrateCap(host.players.length) : capKbps)) / 1000) })}
            </div>
          )}
          {host.encoder && (
            <div className={`upload-note ${host.encoder.vendor === 'software' ? 'warn' : ''}`} title={t('host.encoderHint')}>
              <Cpu size={13} />
              {t('host.encoder', {
                name: t(`host.encoders.${host.encoder.vendor}`),
                codecs: ['H.264', host.encoder.hevc && 'HEVC', host.encoder.av1 && 'AV1'].filter(Boolean).join(', ')
              })}
            </div>
          )}
        </motion.div>
      </motion.div>

      <AnimatePresence>
        {/* XInput в Windows видит не больше 4 Xbox-геймпадов: один обычно у самого хоста. */}
        {host.players.filter((p) => p.perms.gamepad).length + 1 > 4 && (
          <motion.div className="card warn-card" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <Gamepad2 size={18} />
            <span style={{ flex: 1 }}>{t('host.padLimit')}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!host.gamepadDriver && (
          <motion.div className="card warn-card" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <TriangleAlert size={18} />
            <span style={{ flex: 1 }}>{t('host.noGamepadDriver')}</span>
            <GamepadDriverButton />
            <Button size="sm" variant="ghost" onClick={() => void api().openExternal(VIGEM_URL)}>
              {t('host.getDriver')}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {host.inputPaused && (
          <motion.div className="card warn-card" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <Hand size={18} />
            <span style={{ flex: 1 }}>{t('host.pausedBanner')}</span>
            <Button size="sm" variant="primary" onClick={() => void api().host.setInputPaused(false)}>
              {t('host.resumeInput')}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {host.apolloDown && (
          <motion.div key="apollo" className="card warn-card" style={{ overflow: 'hidden' }} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
            <span style={{ flex: 1 }}>{t('host.apolloDown')}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {host.wrongGpu && (
          <motion.div key="gpu" className="card warn-card" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <Cpu size={18} />
            <span style={{ flex: 1 }}>{t('host.wrongGpu', { gpu: host.wrongGpu.better, encoder: t(`host.encoders.${host.wrongGpu.encoderVendor}`) })}</span>
          </motion.div>
        )}
        {!host.wrongGpu && host.encoder?.vendor === 'software' && (
          <motion.div key="sw" className="card warn-card" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <Cpu size={18} />
            <span style={{ flex: 1 }}>{t('host.softwareEncoder')}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <AudioBanner host={host} />

      <AnimatePresence>
        {host.pendingRestart && (
          <motion.div className="card warn-card info" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <Info size={18} />
            <span style={{ flex: 1 }}>{t('host.pendingRestart')}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {host.requests.length > 0 && (
          <motion.section initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={softSpring}>
            <div className="section-title" style={{ marginTop: 22 }}>
              <UserPlus size={14} />
              {t('host.requests')}
            </div>
            <div className="list">
              <AnimatePresence initial={false}>
                {host.requests.map((r) => (
                  <RequestCard key={r.id} r={r} />
                ))}
              </AnimatePresence>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      <div className="section-title" style={{ marginTop: 22 }}>
        {t('host.players')}
      </div>
      <div className="players">
        <AnimatePresence initial={false} mode="popLayout">
          {host.players.length === 0 ? (
            <motion.div key="empty" className="card empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="empty-icon">
                <Users size={26} />
              </div>
              <div style={{ fontWeight: 600 }}>{t('host.noPlayers')}</div>
              <div className="faint">{t('host.noPlayersHint')}</div>
            </motion.div>
          ) : (
            host.players.map((p) => <PlayerCard key={p.deviceId} p={p} />)
          )}
        </AnimatePresence>
      </div>

      <Modal open={confirmStop} onClose={() => setConfirmStop(false)}>
        <h3 style={{ marginTop: 0 }}>{t('host.stopTitle')}</h3>
        <p className="muted">{t('host.stopConfirm')}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button onClick={() => setConfirmStop(false)}>{t('common.cancel')}</Button>
          <Button variant="danger" icon={<Power size={16} />} onClick={stop}>
            {t('host.stop')}
          </Button>
        </div>
      </Modal>

      <Modal open={confirmKickAll} onClose={() => setConfirmKickAll(false)}>
        <h3 style={{ marginTop: 0 }}>{t('host.kickAllTitle')}</h3>
        <p className="muted">{t('host.kickAllConfirm')}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button onClick={() => setConfirmKickAll(false)}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            icon={<UserMinus size={16} />}
            onClick={() => {
              setConfirmKickAll(false)
              void api().host.kickAll()
            }}
          >
            {t('host.kickAll')}
          </Button>
        </div>
      </Modal>
    </motion.div>
  )
}

/** Карточки перерисовываются только при изменении своих данных (состояние хоста приходит каждые 2–5 с). */
const sameJson = <T,>(a: T, b: T): boolean => JSON.stringify(a) === JSON.stringify(b)

const RequestCard = memo(function RequestCard({ r }: { r: JoinRequestView }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const respond = (d: 'allow' | 'trust' | 'deny'): void => {
    if (busy) return
    setBusy(true)
    void api().host.respond(r.id, d)
  }
  return (
    <motion.div
      layout="position"
      className="card request"
      initial={{ opacity: 0, y: -12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, scale: 0.97 }}
      transition={softSpring}
    >
      <div className="request-ring">
        <Avatar name={r.nickname} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="player-name">
          <span className="name-text">{r.nickname}</span>
          {!r.known && (
            <span className="pill pill-warning" style={{ height: 20, fontSize: 11.5 }} title={t('host.newDeviceHint')}>
              {t('host.newDevice')}
            </span>
          )}
        </div>
        <div className="faint" style={{ fontSize: 12.5 }}>
          {r.address}
        </div>
      </div>
      <div className="request-actions">
        <Button size="sm" variant="ghost" icon={<X size={15} />} disabled={busy} onClick={() => respond('deny')} title={t('host.deny')} aria-label={t('host.deny')}>
          <span className="collapsible">{t('host.deny')}</span>
        </Button>
        <Button size="sm" icon={<ShieldCheck size={15} />} disabled={busy} onClick={() => respond('trust')} title={t('host.trust')} aria-label={t('host.trust')}>
          <span className="collapsible">{t('host.trust')}</span>
        </Button>
        <Button size="sm" variant="success" icon={<Check size={15} />} disabled={busy} onClick={() => respond('allow')}>
          {t('host.allow')}
        </Button>
      </div>
    </motion.div>
  )
}, (a, b) => sameJson(a.r, b.r))

function PermToggle({ on, selfOff, icon, label, onClick }: { on: boolean; selfOff?: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <motion.button
      className={`perm ${on ? 'on' : ''} ${on && selfOff ? 'self-off' : ''}`}
      onClick={onClick}
      whileTap={{ scale: 0.92 }}
      transition={spring}
      aria-pressed={on}
      title={on && selfOff ? t('host.selfOffHint', { what: label.toLowerCase() }) : label}
    >
      <motion.span className="perm-icon" animate={{ rotate: on ? 0 : -8, scale: on ? 1 : 0.92 }} transition={spring}>
        {icon}
      </motion.span>
      <span>{label}</span>
      <motion.span className="perm-led" animate={{ opacity: on ? 1 : 0.25, scale: on ? 1 : 0.7 }} transition={spring} />
    </motion.button>
  )
}

const PlayerCard = memo(function PlayerCard({ p, ref }: { p: PlayerView; ref?: Ref<HTMLDivElement> }) {
  const { t } = useTranslation()
  const resetGamepad = (): void => {
    void api().host.resetGamepad(p.deviceId)
    useApp.getState().toast({ tone: 'info', text: t('host.resetGamepadDone', { name: p.nickname }) })
  }
  const toggle = (key: keyof InputPerms): void => void api().host.setPerms(p.deviceId, { [key]: !p.perms[key] })
  const tone = p.status === 'streaming' ? 'pill-success' : p.status === 'pairing' || p.status === 'connecting' ? 'pill-accent' : ''
  return (
    <motion.div
      ref={ref}
      layout="position"
      className="card player"
      initial={{ opacity: 0, scale: 0.9, y: 16 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
      transition={softSpring}
    >
      <div className="player-head">
        <Avatar name={p.nickname} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="player-name">
            <span className="name-text">{p.nickname}</span>
            {p.trusted && <ShieldCheck size={14} className="trusted-icon" aria-label={t('host.trusted')} />}
          </div>
          <span className={`pill ${tone}`} style={{ height: 22, marginTop: 4 }}>
            {(p.status === 'pairing' || p.status === 'connecting') && <span className="spinner" style={{ width: 10, height: 10, borderWidth: 2 }} />}
            {p.status === 'streaming' && <span className="dot pulse" />}
            {t(`host.status.${p.status}`)}
          </span>
          {p.rttMs !== undefined && <RttBadge ms={p.rttMs} />}
          <div className="player-tags">
            <AnimatePresence initial={false}>
              {p.poorNetwork && (
                <motion.span key="net" className="pill pill-warning tag" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} title={t('host.poorNetworkHint')}>
                  <WifiOff size={11} />
                  {t('host.poorNetwork')}
                </motion.span>
              )}
              {p.muteChat && (
                <motion.span key="chat" className="pill tag" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} title={t('host.muteChatHint')}>
                  <Headphones size={11} />
                  {t('host.muteChat')}
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </div>
        {p.status === 'streaming' && p.perms.gamepad && (
          <motion.button className="btn btn-ghost icon-btn" onClick={resetGamepad} title={t('host.resetGamepad')} aria-label={t('host.resetGamepad')} whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.9 }}>
            <RefreshCcw size={16} />
          </motion.button>
        )}
        <motion.button className="btn btn-ghost icon-btn kick" onClick={() => void api().host.kick(p.deviceId)} title={t('host.kick')} aria-label={t('host.kick')} whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.9 }}>
          <UserMinus size={17} />
        </motion.button>
      </div>
      <AnimatePresence initial={false}>
        {p.inputRequest && (
          <motion.div className="input-request" style={{ overflow: 'hidden' }} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={softSpring}>
            <Hand size={15} />
            <span style={{ flex: 1 }}>
              {t('host.asksFor', {
                what: (['keyboard', 'mouse', 'gamepad'] as const)
                  .filter((k) => p.inputRequest?.[k])
                  .map((k) => t(`host.${k}`).toLowerCase())
                  .join(', ')
              })}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void api().host.respondInput(p.deviceId, false)}>
              {t('host.deny')}
            </Button>
            <Button size="sm" variant="success" onClick={() => void api().host.respondInput(p.deviceId, true)}>
              {t('host.give')}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="perms">
        <PermToggle on={p.perms.keyboard} selfOff={p.selfOff.keyboard} icon={<Keyboard size={17} />} label={t('host.keyboard')} onClick={() => toggle('keyboard')} />
        <PermToggle on={p.perms.mouse} selfOff={p.selfOff.mouse} icon={<Mouse size={17} />} label={t('host.mouse')} onClick={() => toggle('mouse')} />
        <PermToggle on={p.perms.gamepad} selfOff={p.selfOff.gamepad} icon={<Gamepad2 size={17} />} label={t('host.gamepad')} onClick={() => toggle('gamepad')} />
      </div>
    </motion.div>
  )
}, (a, b) => a.ref === b.ref && sameJson(a.p, b.p))

/**
 * Звук хоста: Discord убран из трансляции, или игроки просят убрать, но это невозможно (и почему).
 */
function AudioBanner({ host }: { host: HostState }) {
  const { t } = useTranslation()
  const a = host.audio
  const asked = host.players.some((p) => p.muteChat)
  let tone: 'ok' | 'warn' | null = null
  let text = ''
  if (a.error && a.chatControl) {
    tone = 'warn'
    text = t('host.audioError', { error: a.error })
  } else if (a.chatControl && a.chatExcluded) {
    tone = 'ok'
    text = a.monitoring ? t('host.chatExcludedMonitor') : t('host.chatExcluded')
  } else if (asked && !a.chatControl && a.unavailable) {
    tone = 'warn'
    text = t(`host.chatUnavailable.${a.unavailable}`)
  }
  return (
    <AnimatePresence>
      {tone && (
        <motion.div key={tone + text} className={`card warn-card ${tone === 'ok' ? 'info' : ''}`} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
          <Headphones size={18} />
          <span style={{ flex: 1 }}>{text}</span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Задержка до игрока: зелёная до 40 мс, жёлтая до 80 мс, дальше красная (вероятно, ретранслятор Radmin). */
export function RttBadge({ ms }: { ms: number }) {
  const { t } = useTranslation()
  const tone = ms <= 40 ? 'good' : ms <= 80 ? 'mid' : 'bad'
  return <span className={`rtt ${tone} faint`} style={{ fontSize: 12, marginLeft: 8 }}>{t('host.latency', { ms })}</span>
}

/** Установка ViGEmBus в одно нажатие (скрипт Apollo с правами администратора). */
function GamepadDriverButton() {
  const { t } = useTranslation()
  const toast = useApp((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const install = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const r = await api().host.installGamepad()
      if (r.ok) toast({ tone: 'success', text: t('host.driverInstalled') })
      else if (r.cancelled) toast({ tone: 'warning', text: t('errors.install_cancelled') })
      else toast({ tone: 'danger', text: t('host.driverFailed') }, 8000)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size="sm" variant="primary" loading={busy} onClick={() => void install()}>
      {t('host.installDriver')}
    </Button>
  )
}
