import { motion } from 'framer-motion'
import { ArrowRight, Monitor, Moon, Sun } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Lang, ThemePref } from '@shared/types'
import { useApp } from '@/store/app'
import { Button, riseIn, Segmented, stagger } from '@/components/ui'
import { RadminHelp } from '@/components/RadminBadge'
import { PixelLogo } from '@/components/PixelLogo'

export function Onboarding() {
  const { t } = useTranslation()
  const settings = useApp((s) => s.settings)!
  const radmin = useApp((s) => s.radmin)
  const update = useApp((s) => s.updateSettings)
  const go = useApp((s) => s.go)
  const [nick, setNick] = useState(settings.nickname)
  const [busy, setBusy] = useState(false)

  const finish = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await update({ nickname: nick.trim(), onboarded: true })
      go('home')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-inner onboarding">
      <motion.div variants={stagger} initial="hidden" animate="show" className="onboarding-grid">
        <motion.div variants={riseIn} className="onboarding-hero">
          <motion.div
            className="hero-logo"
            initial={{ scale: 0.6, rotate: -12, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 220, damping: 16, delay: 0.1 }}
          >
            <PixelLogo size={72} />
          </motion.div>
          <h1 className="hero-title">{t('onboarding.welcome')}</h1>
          <p className="muted hero-sub">{t('onboarding.subtitle')}</p>
        </motion.div>

        <motion.div variants={riseIn} className="card card-pad onboarding-form">
          <div className="field">
            <span className="field-label">{t('onboarding.language')}</span>
            <Segmented<Lang>
              value={settings.language}
              onChange={(v) => void update({ language: v })}
              options={[
                { value: 'ru', label: 'Русский' },
                { value: 'en', label: 'English' }
              ]}
            />
          </div>
          <div className="field">
            <span className="field-label">{t('onboarding.theme')}</span>
            <Segmented<ThemePref>
              value={settings.theme}
              onChange={(v) => void update({ theme: v })}
              options={[
                { value: 'system', label: <><Monitor size={14} />{t('settings.themes.system')}</> },
                { value: 'light', label: <><Sun size={14} />{t('settings.themes.light')}</> },
                { value: 'dark', label: <><Moon size={14} />{t('settings.themes.dark')}</> }
              ]}
            />
          </div>
          <label className="field">
            <span className="field-label">{t('onboarding.nickname')}</span>
            <input className="input" value={nick} maxLength={24} onChange={(e) => setNick(e.target.value)} />
            <span className="field-hint">{t('onboarding.nicknameHint')}</span>
          </label>
        </motion.div>

        <motion.div variants={riseIn} className="card card-pad">
          <div className="section-title">{t('onboarding.network')}</div>
          {radmin.connected ? (
            <div className="pill pill-success" style={{ height: 34, padding: '0 14px' }}>
              <span className="dot pulse" />
              {t('radmin.connected', { ip: radmin.ip })}
            </div>
          ) : (
            <RadminHelp compact />
          )}
        </motion.div>

        <motion.div variants={riseIn} style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="primary" size="lg" disabled={!nick.trim()} loading={busy} onClick={() => void finish()}>
            {t('onboarding.start')}
            <ArrowRight size={18} />
          </Button>
        </motion.div>
      </motion.div>
    </div>
  )
}
