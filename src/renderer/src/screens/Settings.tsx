import { AnimatePresence, motion } from 'framer-motion'
import { Gamepad2, Info, Keyboard, Monitor, Moon, Mouse, Server, ShieldCheck, SlidersHorizontal, Sun, Tv } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { InputPerms } from '@shared/perms'
import type { Codec, DisplayMode, Lang, Resolution, CaptureKeys, ThemePref, TrustedFriendView } from '@shared/types'
import { useApp } from '@/store/app'
import { api } from '@/lib/bridge'
import { PixelLogo } from '@/components/PixelLogo'
import { Avatar, Button, Row, Segmented, Select, softSpring, spring, Switch } from '@/components/ui'

type Tab = 'general' | 'stream' | 'host' | 'about'

export function SettingsScreen() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('general')
  const tabs: { id: Tab; icon: ReactNode }[] = [
    { id: 'general', icon: <SlidersHorizontal size={16} /> },
    { id: 'stream', icon: <Tv size={16} /> },
    { id: 'host', icon: <Server size={16} /> },
    { id: 'about', icon: <Info size={16} /> }
  ]
  return (
    <div className="page-inner">
      <div className="page-header">
        <h1 className="page-title">{t('settings.title')}</h1>
      </div>
      <div className="settings-layout">
        <nav className="tabs" role="tablist">
          {tabs.map((x) => (
            <button key={x.id} role="tab" aria-selected={tab === x.id} className={`tab ${tab === x.id ? 'active' : ''}`} onClick={() => setTab(x.id)}>
              {tab === x.id && <motion.span layoutId="tab-pill" className="tab-pill" transition={spring} />}
              {x.icon}
              {t(`settings.tabs.${x.id}`)}
            </button>
          ))}
        </nav>
        <div className="tab-body">
          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
              {tab === 'general' && <General />}
              {tab === 'stream' && <StreamTab />}
              {tab === 'host' && <HostTab />}
              {tab === 'about' && <About />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

function General() {
  const { t } = useTranslation()
  const s = useApp((x) => x.settings)!
  const update = useApp((x) => x.updateSettings)
  const [nick, setNick] = useState(s.nickname)
  return (
    <div className="card card-pad">
      <Row title={t('settings.language')}>
        <Segmented<Lang>
          value={s.language}
          onChange={(v) => void update({ language: v })}
          options={[
            { value: 'ru', label: 'Русский' },
            { value: 'en', label: 'English' }
          ]}
        />
      </Row>
      <Row title={t('settings.theme')}>
        <Segmented<ThemePref>
          value={s.theme}
          onChange={(v) => void update({ theme: v })}
          options={[
            { value: 'system', label: <><Monitor size={14} />{t('settings.themes.system')}</> },
            { value: 'light', label: <><Sun size={14} />{t('settings.themes.light')}</> },
            { value: 'dark', label: <><Moon size={14} />{t('settings.themes.dark')}</> }
          ]}
        />
      </Row>
      <Row title={t('settings.nickname')} hint={t('onboarding.nicknameHint')}>
        <input
          className="input"
          style={{ width: 220 }}
          value={nick}
          maxLength={24}
          onChange={(e) => setNick(e.target.value)}
          onBlur={() => nick.trim() && nick !== s.nickname && void update({ nickname: nick })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </Row>
      <Row title={t('settings.autostart')}>
        <Switch checked={s.autostart} onChange={(v) => void update({ autostart: v })} />
      </Row>
    </div>
  )
}

function StreamTab() {
  const { t } = useTranslation()
  const st = useApp((x) => x.settings)!.stream
  const update = useApp((x) => x.updateSettings)
  const set = (patch: Partial<typeof st>): void => void update({ stream: patch })
  return (
    <div className="card card-pad">
      <Row title={t('settings.resolution')}>
        <Select<Resolution>
          value={st.resolution}
          onChange={(v) => set({ resolution: v })}
          options={[
            { value: 'auto', label: t('settings.resolutionAuto') },
            { value: '720', label: '1280 × 720' },
            { value: '1080', label: '1920 × 1080' },
            { value: '1440', label: '2560 × 1440' },
            { value: '4K', label: '3840 × 2160' }
          ]}
        />
      </Row>
      <Row title={t('settings.fps')}>
        <Segmented<string> value={String(st.fps)} onChange={(v) => set({ fps: Number(v) })} options={['30', '60', '90', '120', '144'].map((v) => ({ value: v, label: v }))} />
      </Row>
      <Row title={t('settings.bitrate')}>
        <Select<number>
          value={st.bitrateKbps}
          onChange={(v) => set({ bitrateKbps: v })}
          options={[
            { value: 0, label: t('settings.bitrateAuto') },
            ...[5, 10, 20, 30, 50, 80, 120].map((m) => ({ value: m * 1000, label: t('settings.mbps', { value: m }) }))
          ]}
        />
      </Row>
      <Row title={t('settings.codec')}>
        <Select<Codec>
          value={st.codec}
          onChange={(v) => set({ codec: v })}
          options={[
            { value: 'auto', label: t('common.auto') },
            { value: 'H.264', label: 'H.264' },
            { value: 'HEVC', label: 'HEVC (H.265)' },
            { value: 'AV1', label: 'AV1' }
          ]}
        />
      </Row>
      <Row title={t('settings.displayMode')}>
        <Select<DisplayMode>
          value={st.displayMode}
          onChange={(v) => set({ displayMode: v })}
          options={(['fullscreen', 'borderless', 'windowed'] as const).map((v) => ({ value: v, label: t(`settings.displayModes.${v}`) }))}
        />
      </Row>
      <Row title={t('settings.absoluteMouse')} hint={t('settings.absoluteMouseHint')}>
        <Switch checked={st.absoluteMouse} onChange={(v) => set({ absoluteMouse: v })} />
      </Row>
      <Row title={t('settings.vsync')} hint={t('settings.vsyncHint')}>
        <Switch checked={st.vsync} onChange={(v) => set({ vsync: v })} />
      </Row>
      <Row title={t('settings.framePacing')}>
        <Switch checked={st.framePacing} onChange={(v) => set({ framePacing: v })} />
      </Row>
      <Row title={t('settings.perfOverlay')}>
        <Switch checked={st.perfOverlay} onChange={(v) => set({ perfOverlay: v })} />
      </Row>
      <Row title={t('settings.audioOnHost')}>
        <Switch checked={st.audioOnHost} onChange={(v) => set({ audioOnHost: v })} />
      </Row>
      <Row title={t('settings.captureKeys')}>
        <Select<CaptureKeys>
          value={st.captureSystemKeys}
          onChange={(v) => set({ captureSystemKeys: v })}
          options={(['never', 'fullscreen', 'always'] as const).map((v) => ({ value: v, label: t(`settings.captureModes.${v}`) }))}
        />
      </Row>
      <Row title={t('settings.packetSize')} hint={t('settings.packetSizeHint')}>
        <Select<number>
          value={st.packetSize}
          onChange={(v) => set({ packetSize: v })}
          options={[{ value: 0, label: t('common.auto') }, ...[1024, 1200, 1300, 1392].map((v) => ({ value: v, label: `${v} B` }))]}
        />
      </Row>
    </div>
  )
}

function HostTab() {
  const { t, i18n } = useTranslation()
  const h = useApp((x) => x.settings)!.host
  const update = useApp((x) => x.updateSettings)
  const [trusted, setTrusted] = useState<TrustedFriendView[] | null>(null)

  useEffect(() => {
    void api().host.listTrusted().then(setTrusted)
  }, [])

  // Только изменённый пункт: быстрые нажатия по разным пунктам не затирают друг друга.
  const setDefault = (key: keyof InputPerms, v: boolean): void => void update({ host: { defaultPerms: { [key]: v } } })
  const remove = async (id: string): Promise<void> => {
    await api().host.removeTrusted(id)
    setTrusted(await api().host.listTrusted())
  }
  const fmt = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card card-pad">
        <Row title={t('settings.maxPlayers')}>
          <Segmented<string> value={String(h.maxPlayers)} onChange={(v) => void update({ host: { maxPlayers: Number(v) } })} options={['1', '2', '3', '4'].map((v) => ({ value: v, label: v }))} />
        </Row>
        <Row title={t('settings.defaultPerms')} hint={t('settings.defaultPermsHint')}>
          <div className="perms">
            {(
              [
                ['keyboard', <Keyboard size={16} key="k" />],
                ['mouse', <Mouse size={16} key="m" />],
                ['gamepad', <Gamepad2 size={16} key="g" />]
              ] as const
            ).map(([key, icon]) => (
              <motion.button key={key} className={`perm ${h.defaultPerms[key] ? 'on' : ''}`} aria-pressed={h.defaultPerms[key]} onClick={() => setDefault(key, !h.defaultPerms[key])} whileTap={{ scale: 0.92 }}>
                <span className="perm-icon">{icon}</span>
                {t(`host.${key}`)}
                <motion.span className="perm-led" animate={{ opacity: h.defaultPerms[key] ? 1 : 0.25 }} />
              </motion.button>
            ))}
          </div>
        </Row>
        <Row title={t('settings.virtualDisplay')} hint={t('settings.virtualDisplayHint')}>
          <Switch checked={h.useVirtualDisplay} onChange={(v) => void update({ host: { useVirtualDisplay: v } })} />
        </Row>
      </div>

      <div className="card card-pad">
        <div className="section-title">
          <ShieldCheck size={14} />
          {t('settings.trustedFriends')}
        </div>
        {trusted && trusted.length === 0 && <div className="faint">{t('settings.trustedEmpty')}</div>}
        <AnimatePresence initial={false}>
          {trusted?.map((f) => (
            <motion.div key={f.deviceId} className="row" layout initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0, padding: 0 }} transition={softSpring}>
              <Avatar name={f.nickname} size={34} />
              <div className="row-text">
                <div className="row-title">{f.nickname}</div>
                {f.lastSeen && <div className="row-hint">{t('settings.lastSeen', { date: fmt.format(f.lastSeen) })}</div>}
              </div>
              <Button size="sm" variant="danger" onClick={() => void remove(f.deviceId)}>
                {t('settings.remove')}
              </Button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}

function About() {
  const { t } = useTranslation()
  const info = useApp((x) => x.appInfo)
  return (
    <div className="card card-pad">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
        <div className="hero-logo" style={{ width: 52, height: 52, margin: 0 }}>
          <PixelLogo size={52} />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>Streamly</div>
          <div className="faint">{t('settings.version', { version: info?.version ?? '' })}</div>
        </div>
      </div>
      <p className="muted">{t('settings.aboutText')}</p>
      <div className="section-title" style={{ marginTop: 18 }}>
        {t('settings.components')}
      </div>
      <Row title="Moonlight">
        <span className={`pill ${info?.moonlightAvailable ? 'pill-success' : 'pill-danger'}`}>{info?.moonlightAvailable ? t('settings.bundled') : t('settings.notBundled')}</span>
      </Row>
      <Row title="Apollo">
        <span className={`pill ${info?.apolloInstalled ? 'pill-success' : info?.apolloBundled ? 'pill-accent' : 'pill-danger'}`}>
          {info?.apolloInstalled ? t('settings.installed') : info?.apolloBundled ? `${t('settings.notInstalled')} · ${t('settings.bundled')}` : t('settings.notBundled')}
        </span>
      </Row>
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <Button size="sm" onClick={() => void api().openExternal('https://github.com/ClassicOldSong/Apollo')}>
          Apollo
        </Button>
        <Button size="sm" onClick={() => void api().openExternal('https://github.com/moonlight-stream/moonlight-qt')}>
          Moonlight
        </Button>
        <Button size="sm" onClick={() => void api().openExternal('https://www.radmin-vpn.com/')}>
          Radmin VPN
        </Button>
      </div>
    </div>
  )
}
