import { AnimatePresence, motion } from 'framer-motion'
import { Archive, ClipboardCopy, Download, FileText, FolderOpen, Gamepad2, Info, Keyboard, Monitor, Moon, Mouse, Server, ShieldCheck, SlidersHorizontal, Stethoscope, Sun, Tv, Volume2, Wrench } from 'lucide-react'
import { currentPreset, PRESETS, type Preset } from '@/lib/quality'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { InputPerms } from '@shared/perms'
import type { Codec, DisplayMode, EncoderPreset, HostDisplay, Lang, LossProtection, Resolution, CaptureKeys, ThemePref, TrustedFriendView } from '@shared/types'
import { useApp, type SettingsTab } from '@/store/app'
import { api } from '@/lib/bridge'
import { PixelLogo } from '@/components/PixelLogo'
import { EncoderCustomPanel } from '@/components/EncoderCustomPanel'
import { UpdatePanel } from '@/components/Update'
import { HotkeysCard } from '@/components/Hotkeys'
import { PadsCard } from '@/components/Pads'
import { useVolume } from '@/components/StreamControls'
import { Avatar, Button, Collapse, Row, Segmented, Select, Slider, softSpring, spring, Switch } from '@/components/ui'

type Tab = SettingsTab

export function SettingsScreen() {
  const { t } = useTranslation()
  const tab = useApp((x) => x.settingsTab)
  const setTab = useApp((x) => x.setSettingsTab)
  const advanced = useApp((x) => x.settings!.showAdvanced)
  const update = useApp((x) => x.updateSettings)
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
        <div className="spacer" />
        {/* Редко нужные настройки спрятаны: один переключатель на все вкладки. */}
        <div className="advanced-toggle" title={t('settings.showAdvancedHint')}>
          <Wrench size={15} />
          <span>{t('settings.showAdvanced')}</span>
          <Switch checked={advanced} onChange={(v) => void update({ showAdvanced: v })} label={t('settings.showAdvanced')} />
        </div>
      </div>
      <div className="settings-layout">
        <nav className="tabs" role="tablist" aria-orientation="vertical">
          {tabs.map((x) => (
            <button
              key={x.id}
              id={`tab-${x.id}`}
              role="tab"
              aria-selected={tab === x.id}
              aria-controls="settings-panel"
              tabIndex={tab === x.id ? 0 : -1}
              className={`tab ${tab === x.id ? 'active' : ''}`}
              onClick={() => setTab(x.id)}
              onKeyDown={(e) => {
                const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
                if (!dir) return
                e.preventDefault()
                const i = tabs.findIndex((y) => y.id === tab)
                const next = tabs[(i + dir + tabs.length) % tabs.length].id
                setTab(next)
                document.getElementById(`tab-${next}`)?.focus()
              }}
            >
              {tab === x.id && <motion.span layoutId="tab-pill" className="tab-pill" transition={spring} />}
              {x.icon}
              {t(`settings.tabs.${x.id}`)}
            </button>
          ))}
        </nav>
        <div className="tab-body" id="settings-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
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

/** Карточка расширенных настроек: раскрывается и сворачивается вместе с переключателем в заголовке. */
function AdvancedCard({ title, children }: { title?: string; children: ReactNode }) {
  const { t } = useTranslation()
  const open = useApp((x) => x.settings!.showAdvanced)
  return (
    <Collapse open={open}>
      <div className="card card-pad advanced-card">
        <div className="section-title">
          <Wrench size={14} />
          {title ?? t('settings.advanced')}
        </div>
        {children}
      </div>
    </Collapse>
  )
}

function General() {
  const { t } = useTranslation()
  const s = useApp((x) => x.settings)!
  const update = useApp((x) => x.updateSettings)
  const [nick, setNick] = useState(s.nickname)
  useEffect(() => setNick(s.nickname), [s.nickname])
  return (
    <div className="settings-stack">
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
            style={{ width: 220, maxWidth: '100%' }}
            value={nick}
            maxLength={24}
            aria-label={t('settings.nickname')}
            onChange={(e) => setNick(e.target.value)}
            onBlur={() => {
              const clean = nick.trim()
              // Пустой ник не сохраняем и возвращаем прежний, чтобы было видно, какой действует.
              if (!clean) return setNick(s.nickname)
              if (clean !== s.nickname) void update({ nickname: clean })
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </Row>
        <Row title={t('settings.autostart')}>
          <Switch checked={s.autostart} onChange={(v) => void update({ autostart: v })} />
        </Row>
        <Row title={t('settings.closeToTray')} hint={t('settings.closeToTrayHint')}>
          <Switch checked={s.closeToTray} onChange={(v) => void update({ closeToTray: v })} />
        </Row>
      </div>
      <HotkeysCard />
      <LogsCard />
      <AdvancedCard>
        <Row title={t('settings.autoStartHosting')} hint={t('settings.autoStartHostingHint')}>
          <Switch checked={s.host.autoStartHosting} onChange={(v) => void update({ host: { autoStartHosting: v } })} />
        </Row>
      </AdvancedCard>
    </div>
  )
}

/** Журнал работы: 14 дней, архив для отправки, отчёт в буфер. */
function LogsCard() {
  const { t } = useTranslation()
  const toast = useApp((x) => x.toast)
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const path = await api().exportLogs()
      if (path) toast({ tone: 'success', text: t('logs.saved') }, 6000)
    } catch {
      toast({ tone: 'danger', text: t('logs.failed') })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="card card-pad">
      <div className="section-title">
        <FileText size={14} />
        {t('logs.title')}
      </div>
      <div className="faint hotkeys-hint">{t('logs.hint')}</div>
      <div className="row-buttons" style={{ marginTop: 10 }}>
        <Button size="sm" variant="primary" icon={<Archive size={15} />} loading={busy} onClick={() => void save()}>
          {t('logs.save')}
        </Button>
        <Button size="sm" icon={<ClipboardCopy size={15} />} onClick={() => void api().copyDiagnostics().then(() => toast({ tone: 'success', text: t('settings.diagnosticsCopied') }))}>
          {t('settings.copyDiagnostics')}
        </Button>
        <Button size="sm" variant="ghost" icon={<FolderOpen size={15} />} onClick={() => void api().openLogs()}>
          {t('settings.openLogs')}
        </Button>
      </div>
    </div>
  )
}

function StreamTab() {
  const { t } = useTranslation()
  const st = useApp((x) => x.settings)!.stream
  const advanced = useApp((x) => x.settings!.showAdvanced)
  const update = useApp((x) => x.updateSettings)
  const set = (patch: Partial<typeof st>): void => void update({ stream: patch })
  const preset = currentPreset(st)
  const [vol, setVol] = useVolume()
  const keys = useApp((x) => x.settings!.hotkeys)
  return (
    <div className="settings-stack">
      <div className="card card-pad">
        <div className="section-title">{t('settings.quality')}</div>
        <Row title={t('settings.autoQuality')} hint={t('settings.autoQualityHint')}>
          <Switch checked={st.autoQuality} onChange={(v) => set({ autoQuality: v })} />
        </Row>
        <div className="preset-block" style={{ opacity: st.autoQuality ? 0.5 : 1 }}>
          <Segmented<Preset | 'custom'>
            value={preset}
            disabled={st.autoQuality}
            // «Вручную» раскрывает расширенные настройки, где разрешение, частота и битрейт.
            onChange={(v) => (v === 'custom' ? !advanced && void update({ showAdvanced: true }) : set(PRESETS[v]))}
            options={(['economy', 'balanced', 'high', 'custom'] as const).map((v) => ({ value: v, label: t(`settings.presets.${v}`) }))}
          />
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={st.autoQuality ? 'auto' : preset} className="preset-hint" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }}>
              {st.autoQuality ? t('settings.presetsByAuto') : t(`settings.presetsHint.${preset}`)}
            </motion.div>
          </AnimatePresence>
        </div>
        <HostQualityList />
      </div>
      <div className="card card-pad">
        <div className="section-title">{t('settings.inGame')}</div>
        <Row title={t('stream.volume')} hint={t('settings.volumeHint')}>
          <div className="slider-field">
            <Slider value={vol} onChange={setVol} />
            <span className="sc-value">{vol}%</span>
          </div>
        </Row>
        <Row title={t('stream.muteChat')} hint={t('settings.muteChatHint')}>
          <Switch checked={st.muteHostChat} onChange={(v) => set({ muteHostChat: v })} />
        </Row>
        <Row title={t('settings.displayMode')} hint={st.displayMode === 'fullscreen' ? t('settings.fullscreenWarn') : undefined}>
          <Select<DisplayMode>
            value={st.displayMode}
            onChange={(v) => set({ displayMode: v })}
            options={(['fullscreen', 'borderless', 'windowed'] as const).map((v) => ({ value: v, label: t(`settings.displayModes.${v}`) }))}
          />
        </Row>
        <Row title={t('settings.overlayKey')} hint={t('settings.overlayKeyHint')}>
          <span className="kbd-group">
            {keys.clientMenu && <kbd className="kbd">{keys.clientMenu}</kbd>}
            {keys.clientMenuAlt && <kbd className="kbd">{keys.clientMenuAlt}</kbd>}
            {!keys.clientMenu && !keys.clientMenuAlt && <span className="faint">{t('hotkeys.off')}</span>}
          </span>
        </Row>
      </div>
      <PadsCard />
      <AdvancedCard title={t('settings.advancedStream')}>
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
              ...[...new Set([5, 10, 15, 20, 30, 40, 50, 80, 120, ...(st.bitrateKbps ? [st.bitrateKbps / 1000] : [])])]
                .sort((a, b) => a - b)
                .map((m) => ({ value: m * 1000, label: t('settings.mbps', { value: m }) }))
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
        <Row title={t('settings.hdr')} hint={t('settings.hdrHint')}>
          <Switch checked={st.hdr} onChange={(v) => set({ hdr: v })} />
        </Row>
        <Row title={t('settings.yuv444')} hint={t('settings.yuv444Hint')}>
          <Switch checked={st.yuv444} onChange={(v) => set({ yuv444: v })} />
        </Row>
        <Row title={t('settings.singleGamepad')} hint={t('settings.singleGamepadHint')}>
          <Switch checked={st.singleGamepad} onChange={(v) => set({ singleGamepad: v })} />
        </Row>
        <Row title={t('settings.absoluteMouse')} hint={t('settings.absoluteMouseHint')}>
          <Switch checked={st.absoluteMouse} onChange={(v) => set({ absoluteMouse: v })} />
        </Row>
        <Row title={t('settings.vsync')} hint={t('settings.vsyncHint')}>
          <Switch checked={st.vsync} onChange={(v) => set({ vsync: v })} />
        </Row>
        <Row title={t('settings.framePacing')} hint={t('settings.framePacingHint')}>
          <Switch checked={st.framePacing} onChange={(v) => set({ framePacing: v })} />
        </Row>
        <Row title={t('settings.perfOverlay')}>
          <Switch checked={st.perfOverlay} onChange={(v) => set({ perfOverlay: v })} />
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
            options={[{ value: 0, label: t('common.auto') }, ...[1024, 1200, 1300, 1392].map((v) => ({ value: v, label: t('settings.bytes', { value: v }) }))]}
          />
        </Row>
      </AdvancedCard>
    </div>
  )
}

/** Своё качество отдельных хостов (запоминается из меню Alt+F2). */
function HostQualityList() {
  const { t } = useTranslation()
  const hq = useApp((x) => x.settings!.hostQuality)
  const recent = useApp((x) => x.settings!.recentHosts)
  const update = useApp((x) => x.updateSettings)
  const entries = Object.entries(hq)
  return (
    <Collapse open={entries.length > 0}>
      <div style={{ paddingTop: 14 }}>
        <div className="section-title">{t('settings.hostQuality')}</div>
        <AnimatePresence initial={false}>
          {entries.map(([addr, q]) => {
            const p = currentPreset(q)
            return (
              <motion.div key={addr} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={softSpring} style={{ overflow: 'hidden' }}>
                <div className="row">
                  <div className="row-text">
                    <div className="row-title">{recent.find((h) => h.address === addr)?.name ?? addr}</div>
                    <div className="row-hint">
                      {addr} · {t(`settings.presets.${p}`)}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void update({ hostQuality: { [addr]: null } } as never)}>
                    {t('settings.resetHostQuality')}
                  </Button>
                </div>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </Collapse>
  )
}

function HostTab() {
  const { t, i18n } = useTranslation()
  const h = useApp((x) => x.settings)!.host
  const update = useApp((x) => x.updateSettings)
  const [trusted, setTrusted] = useState<TrustedFriendView[] | null>(null)
  const [displays, setDisplays] = useState<HostDisplay[]>([])
  const pendingRestart = useApp((x) => x.host?.pendingRestart)

  useEffect(() => {
    void api().host.listTrusted().then(setTrusted)
    void api().host.listDisplays().then(setDisplays)
  }, [])

  const known = displays.some((d) => d.id === h.display)
  const displayOptions = [
    { value: 'primary', label: t('settings.displayPrimary') },
    ...displays.map((d, i) => ({
      value: d.id,
      label: `${d.name || t('settings.displayN', { n: i + 1 })}${d.width ? ` · ${d.width}×${d.height}${d.fps ? ` · ${t('settings.hz', { value: d.fps })}` : ''}` : ''}${d.primary ? ` (${t('settings.displayIsPrimary')})` : ''}`
    })),
    // Монитор из настроек сейчас не подключён (или список ещё не получен): оставляем его в списке.
    ...(h.display !== 'primary' && h.display !== 'virtual' && !known ? [{ value: h.display, label: t('settings.displayMissing') }] : []),
    { value: 'virtual', label: t('settings.displayVirtual') }
  ]

  // Только изменённый пункт: быстрые нажатия по разным пунктам не затирают друг друга.
  const setDefault = (key: keyof InputPerms, v: boolean): void => void update({ host: { defaultPerms: { [key]: v } } })
  const remove = async (id: string): Promise<void> => {
    await api().host.removeTrusted(id)
    setTrusted(await api().host.listTrusted())
  }
  const fmt = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="settings-stack">
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
        <Row title={t('settings.notifyRequests')}>
          <Switch checked={h.notifyRequests} onChange={(v) => void update({ host: { notifyRequests: v } })} />
        </Row>
        <Row title={t('settings.requestSound')} hint={t('settings.requestSoundHint')}>
          <Switch checked={h.requestSound} onChange={(v) => void update({ host: { requestSound: v } })} />
        </Row>
        <Row title={t('settings.gameNotify')} hint={t('settings.gameNotifyHint')}>
          <Switch checked={h.gameNotify} onChange={(v) => void update({ host: { gameNotify: v } })} />
        </Row>
        <Row title={t('settings.inviteAutoAdmit')} hint={t('settings.inviteAutoAdmitHint')}>
          <Switch checked={h.inviteAutoAdmit} onChange={(v) => void update({ host: { inviteAutoAdmit: v } })} />
        </Row>
      </div>

      <div className="card card-pad">
        <div className="section-title">
          <Monitor size={14} />
          {t('settings.hostScreen')}
        </div>
        <Row title={t('settings.display')} hint={displays.length ? t('settings.displayHint') : t('settings.displayHintEmpty')}>
          <Select<string> value={h.display} onChange={(v) => void update({ host: { display: v } })} options={displayOptions} />
        </Row>
        <Collapse open={h.display === 'virtual'}>
          <div className="info-note">{t('settings.virtualExplain')}</div>
          <Row title={t('settings.virtualOnly')} hint={t('settings.virtualOnlyHint')}>
            <Switch checked={h.virtualOnly} onChange={(v) => void update({ host: { virtualOnly: v } })} />
          </Row>
        </Collapse>
        <Collapse open={!!pendingRestart}>
          <div className="info-note warn">{t('settings.pendingRestart')}</div>
        </Collapse>
      </div>

      <div className="card card-pad">
        <div className="section-title">
          <Volume2 size={14} />
          {t('settings.hostSound')}
        </div>
        <Row title={t('settings.keepHostAudio')} hint={t('settings.keepHostAudioHint')}>
          <Switch checked={h.keepHostAudio} onChange={(v) => void update({ host: { keepHostAudio: v } })} />
        </Row>
        <Row title={t('settings.chatRouting')} hint={t('settings.chatRoutingHint')}>
          <Switch checked={h.chatRouting} onChange={(v) => void update({ host: { chatRouting: v } })} />
        </Row>
      </div>

      <AdvancedCard title={t('settings.advancedHost')}>
        <Row title={t('settings.encoderPreset')} hint={t(`settings.encoderPresetHint.${h.encoderPreset}`)}>
          <Segmented<EncoderPreset>
            value={h.encoderPreset}
            onChange={(v) => void update({ host: { encoderPreset: v } })}
            options={(['latency', 'balanced', 'quality', 'custom'] as const).map((v) => ({ value: v, label: t(`settings.encoderPresets.${v}`) }))}
          />
        </Row>
        <AnimatePresence initial={false}>{h.encoderPreset === 'custom' && <EncoderCustomPanel key="enc" />}</AnimatePresence>
        <Row title={t('settings.maxBitrate')} hint={t('settings.maxBitrateHint')}>
          <Select<number>
            value={h.maxBitrateKbps}
            onChange={(v) => void update({ host: { maxBitrateKbps: v } })}
            options={[
              { value: -1, label: t('settings.bitrateCapAuto') },
              ...[5, 10, 15, 20, 30, 50].map((m) => ({ value: m * 1000, label: t('settings.mbps', { value: m }) })),
              { value: 0, label: t('settings.unlimited') }
            ]}
          />
        </Row>
        <Row title={t('settings.lossProtection')} hint={t('settings.lossProtectionHint')}>
          <Segmented<LossProtection>
            value={h.lossProtection}
            onChange={(v) => void update({ host: { lossProtection: v } })}
            options={(['normal', 'high'] as const).map((v) => ({ value: v, label: t(`settings.loss.${v}`) }))}
          />
        </Row>
      </AdvancedCard>

      <div className="card card-pad">
        <Row title={t('settings.selfCheck')} hint={t('settings.selfCheckHint')}>
          <Button size="sm" icon={<Stethoscope size={15} />} onClick={() => useApp.getState().openDiag({ mode: 'host' })}>
            {t('host.selfCheck')}
          </Button>
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
            <motion.div key={f.deviceId} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={softSpring} style={{ overflow: 'hidden' }}>
              <div className="row">
                <Avatar name={f.nickname} size={34} />
                <div className="row-text">
                  <div className="row-title">{f.nickname}</div>
                  {f.lastSeen && <div className="row-hint">{t('settings.lastSeen', { date: fmt.format(f.lastSeen) })}</div>}
                </div>
                <Button size="sm" variant="danger" onClick={() => void remove(f.deviceId)}>
                  {t('settings.remove')}
                </Button>
              </div>
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
  const auto = useApp((x) => x.settings!.updates.auto)
  const update = useApp((x) => x.updateSettings)
  return (
    <div className="settings-stack">
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
      </div>

      <div className="card card-pad">
        <div className="section-title">
          <Download size={14} />
          {t('update.title')}
        </div>
        <UpdatePanel />
        <Row title={t('update.auto')} hint={t('update.autoHint')}>
          <Switch checked={auto} onChange={(v) => void update({ updates: { auto: v } })} />
        </Row>
      </div>

      <AdvancedCard title={t('settings.components')}>
        <Row title="Moonlight">
          <span className={`pill ${info?.moonlightAvailable ? 'pill-success' : 'pill-danger'}`}>{info?.moonlightAvailable ? t('settings.bundled') : t('settings.notBundled')}</span>
        </Row>
        <Row title="Apollo">
          <span className={`pill ${info?.apolloInstalled ? 'pill-success' : info?.apolloBundled ? 'pill-accent' : 'pill-danger'}`}>
            {info?.apolloInstalled ? t('settings.installed') : info?.apolloBundled ? t('settings.notInstalledBundled') : t('settings.notBundled')}
          </span>
        </Row>
        <div className="row-buttons" style={{ marginTop: 14 }}>
          <Button size="sm" onClick={() => void api().openExternal('https://github.com/DenHaIz/Streamly')}>
            Streamly
          </Button>
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
      </AdvancedCard>
    </div>
  )
}
