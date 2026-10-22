import { motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import type { EncoderCustom, EncoderVendor } from '@shared/types'
import { useApp } from '@/store/app'
import { Row, Segmented, Select, softSpring, Switch } from '@/components/ui'

/** Группа параметров одного кодировщика (вне компонента панели: иначе при каждом изменении всё пересоздаётся и теряется фокус). */
function Group({ vendor, used, title, children }: { vendor: EncoderVendor; used?: EncoderVendor; title: string; children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className={`encoder-group ${used === vendor ? 'used' : ''}`}>
      <div className="section-title">
        {title}
        {used === vendor && <span className="pill pill-success tag">{t('settings.encoderUsed')}</span>}
      </div>
      {children}
    </div>
  )
}

/**
 * Ручная настройка кодировщика: отдельные группы для NVIDIA, AMD, Intel Quick Sync и процессора.
 * Apollo использует параметры того кодировщика, который нашёл на ПК (он помечен «используется»).
 */
export function EncoderCustomPanel() {
  const { t } = useTranslation()
  const c = useApp((s) => s.settings!.host.encoderCustom)
  const used = useApp((s) => s.host?.encoder?.vendor)
  const update = useApp((s) => s.updateSettings)
  const set = (patch: Partial<EncoderCustom>): void => void update({ host: { encoderCustom: patch } })

  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={softSpring} style={{ overflow: 'hidden' }}>
      <div className="info-note">{t('settings.encoderCustomHint')}</div>

      <Group used={used} vendor="nvenc" title="NVIDIA NVENC">
        <Row title={t('settings.enc.nvPreset')} hint={t('settings.enc.nvPresetHint')}>
          <Segmented<string> value={String(c.nvPreset)} onChange={(v) => set({ nvPreset: Number(v) })} options={['1', '2', '3', '4', '5', '6', '7'].map((v) => ({ value: v, label: `P${v}` }))} />
        </Row>
        <Row title={t('settings.enc.nvTwoPass')} hint={t('settings.enc.nvTwoPassHint')}>
          <Select<EncoderCustom['nvTwoPass']>
            value={c.nvTwoPass}
            onChange={(v) => set({ nvTwoPass: v })}
            options={(['disabled', 'quarter_res', 'full_res'] as const).map((v) => ({ value: v, label: t(`settings.enc.twoPass.${v}`) }))}
          />
        </Row>
        <Row title={t('settings.enc.aq')} hint={t('settings.enc.aqHint')}>
          <Switch checked={c.nvSpatialAq} onChange={(v) => set({ nvSpatialAq: v })} />
        </Row>
      </Group>

      <Group used={used} vendor="amdvce" title="AMD (Radeon)">
        <Row title={t('settings.enc.amdUsage')}>
          <Select<EncoderCustom['amdUsage']>
            value={c.amdUsage}
            onChange={(v) => set({ amdUsage: v })}
            options={(['ultralowlatency', 'lowlatency', 'lowlatency_high_quality'] as const).map((v) => ({ value: v, label: t(`settings.enc.usage.${v}`) }))}
          />
        </Row>
        <Row title={t('settings.enc.amdQuality')}>
          <Segmented<EncoderCustom['amdQuality']>
            value={c.amdQuality}
            onChange={(v) => set({ amdQuality: v })}
            options={(['speed', 'balanced', 'quality'] as const).map((v) => ({ value: v, label: t(`settings.enc.amdQualities.${v}`) }))}
          />
        </Row>
        <Row title={t('settings.enc.amdRc')} hint={t('settings.enc.amdRcHint')}>
          <Select<EncoderCustom['amdRc']>
            value={c.amdRc}
            onChange={(v) => set({ amdRc: v })}
            options={(['vbr_latency', 'cbr', 'vbr_peak'] as const).map((v) => ({ value: v, label: t(`settings.enc.rc.${v}`) }))}
          />
        </Row>
        <Row title={t('settings.enc.amdVbaq')} hint={t('settings.enc.aqHint')}>
          <Switch checked={c.amdVbaq} onChange={(v) => set({ amdVbaq: v })} />
        </Row>
        <Row title={t('settings.enc.amdPreanalysis')} hint={t('settings.enc.amdPreanalysisHint')}>
          <Switch checked={c.amdPreanalysis} onChange={(v) => set({ amdPreanalysis: v })} />
        </Row>
      </Group>

      <Group used={used} vendor="quicksync" title="Intel Quick Sync">
        <Row title={t('settings.enc.qsvPreset')} hint={t('settings.enc.qsvPresetHint')}>
          <Select<EncoderCustom['qsvPreset']>
            value={c.qsvPreset}
            onChange={(v) => set({ qsvPreset: v })}
            options={(['veryfast', 'faster', 'fast', 'medium', 'slow'] as const).map((v) => ({ value: v, label: t(`settings.enc.speed.${v}`) }))}
          />
        </Row>
      </Group>

      <Group used={used} vendor="software" title={t('settings.enc.cpu')}>
        <Row title={t('settings.enc.swPreset')} hint={t('settings.enc.swPresetHint')}>
          <Select<EncoderCustom['swPreset']>
            value={c.swPreset}
            onChange={(v) => set({ swPreset: v })}
            options={(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast'] as const).map((v) => ({ value: v, label: t(`settings.enc.speed.${v}`) }))}
          />
        </Row>
        <Row title={t('settings.enc.swThreads')} hint={t('settings.enc.swThreadsHint')}>
          <Segmented<string> value={String(c.swThreads)} onChange={(v) => set({ swThreads: Number(v) })} options={['2', '4', '8', '12', '16'].map((v) => ({ value: v, label: v }))} />
        </Row>
      </Group>
    </motion.div>
  )
}
