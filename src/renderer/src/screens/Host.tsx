import { AnimatePresence, motion } from 'framer-motion'
import {
  Check,
  Copy,
  Download,
  Gamepad2,
  Keyboard,
  LogIn,
  Mouse,
  Power,
  RotateCw,
  Server,
  ShieldCheck,
  TriangleAlert,
  UserMinus,
  Radio,
  UserPlus,
  Users,
  X
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { InputPerms } from '@shared/perms'
import type { HostState, JoinRequestView, PlayerView } from '@shared/types'
import { useApp } from '@/store/app'
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
      .finally(() => setStarting(false))
  }

  // Заходя на экран (или когда появилась сеть Radmin), сразу запускаем хост: пользователь уже нажал «Я хост».
  // Только при входе: после «Остановить» экран не должен перезапускать хост сам.
  useEffect(() => {
    const phase = useApp.getState().host?.phase
    if (radmin.connected && (!phase || phase === 'idle')) start()
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
      {phase === 'installing' && <p className="muted" style={{ marginBottom: 0 }}>{t('host.installHint')}</p>}
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
  const [attempt, setAttempt] = useState(0)
  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const ok = await api().host.submitCredentials(user, pass)
      setBad(!ok)
      if (!ok) setAttempt((n) => n + 1)
    } catch {
      setBad(true)
      setAttempt((n) => n + 1)
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
        <input className={`input ${bad ? 'invalid' : ''}`} placeholder={t('host.username')} value={user} onChange={(e) => setUser(e.target.value)} autoFocus />
        <motion.input
          key={attempt}
          className={`input ${bad ? 'invalid' : ''}`}
          type="password"
          placeholder={t('host.password')}
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          animate={bad ? { x: [0, -8, 8, -5, 5, 0] } : { x: 0 }}
          transition={{ duration: 0.4 }}
        />
        <AnimatePresence>
          {bad && (
            <motion.div className="pill pill-danger" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 26 }} exit={{ opacity: 0, height: 0 }}>
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
        <motion.span key={i} className={`slot ${i < used ? 'on' : ''}`} layout initial={false} animate={{ scale: i < used ? 1 : 0.85 }} transition={spring} />
      ))}
    </div>
  )
}

function Dashboard({ host }: { host: HostState }) {
  const { t } = useTranslation()
  const go = useApp((s) => s.go)
  const [confirmStop, setConfirmStop] = useState(false)
  const [stopping, setStopping] = useState(false)
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
        <Button variant="danger" icon={<Power size={16} />} loading={stopping} onClick={() => (host.players.length ? setConfirmStop(true) : stop())}>
          {t('host.stop')}
        </Button>
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
        </motion.div>
      </motion.div>

      <AnimatePresence>
        {!host.gamepadDriver && (
          <motion.div className="card warn-card" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <TriangleAlert size={18} />
            <span style={{ flex: 1 }}>{t('host.noGamepadDriver')}</span>
            <Button size="sm" onClick={() => void api().openExternal(VIGEM_URL)}>
              {t('host.getDriver')}
            </Button>
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
      <motion.div className="players" layout>
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
      </motion.div>

      <Modal open={confirmStop} onClose={() => setConfirmStop(false)}>
        <h3 style={{ marginTop: 0 }}>{t('host.stop')}?</h3>
        <p className="muted">{t('host.stopConfirm')}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button onClick={() => setConfirmStop(false)}>{t('common.cancel')}</Button>
          <Button variant="danger" icon={<Power size={16} />} onClick={stop}>
            {t('host.stop')}
          </Button>
        </div>
      </Modal>
    </motion.div>
  )
}

function RequestCard({ r }: { r: JoinRequestView }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const respond = (d: 'allow' | 'trust' | 'deny'): void => {
    if (busy) return
    setBusy(true)
    void api().host.respond(r.id, d)
  }
  return (
    <motion.div
      layout
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
        </div>
        <div className="faint" style={{ fontSize: 12.5 }}>
          {r.address}
        </div>
      </div>
      <Button size="sm" variant="ghost" icon={<X size={15} />} disabled={busy} onClick={() => respond('deny')}>
        {t('host.deny')}
      </Button>
      <Button size="sm" icon={<ShieldCheck size={15} />} disabled={busy} onClick={() => respond('trust')}>
        {t('host.trust')}
      </Button>
      <Button size="sm" variant="success" icon={<Check size={15} />} disabled={busy} onClick={() => respond('allow')}>
        {t('host.allow')}
      </Button>
    </motion.div>
  )
}

function PermToggle({ on, icon, label, onClick }: { on: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <motion.button className={`perm ${on ? 'on' : ''}`} onClick={onClick} whileTap={{ scale: 0.92 }} transition={spring} aria-pressed={on} title={label}>
      <motion.span className="perm-icon" animate={{ rotate: on ? 0 : -8, scale: on ? 1 : 0.92 }} transition={spring}>
        {icon}
      </motion.span>
      <span>{label}</span>
      <motion.span className="perm-led" animate={{ opacity: on ? 1 : 0.25, scale: on ? 1 : 0.7 }} transition={spring} />
    </motion.button>
  )
}

function PlayerCard({ p }: { p: PlayerView }) {
  const { t } = useTranslation()
  const toggle = (key: keyof InputPerms): void => void api().host.setPerms(p.deviceId, { [key]: !p.perms[key] })
  const tone = p.status === 'streaming' ? 'pill-success' : p.status === 'pairing' || p.status === 'connecting' ? 'pill-accent' : ''
  return (
    <motion.div
      layout
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
        </div>
        <motion.button className="btn btn-ghost icon-btn kick" onClick={() => void api().host.kick(p.deviceId)} title={t('host.kick')} aria-label={t('host.kick')} whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.9 }}>
          <UserMinus size={17} />
        </motion.button>
      </div>
      <div className="perms">
        <PermToggle on={p.perms.keyboard} icon={<Keyboard size={17} />} label={t('host.keyboard')} onClick={() => toggle('keyboard')} />
        <PermToggle on={p.perms.mouse} icon={<Mouse size={17} />} label={t('host.mouse')} onClick={() => toggle('mouse')} />
        <PermToggle on={p.perms.gamepad} icon={<Gamepad2 size={17} />} label={t('host.gamepad')} onClick={() => toggle('gamepad')} />
      </div>
    </motion.div>
  )
}
