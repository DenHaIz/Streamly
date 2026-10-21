import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { Lang } from '@shared/types'
import en from './en.json'
import ru from './ru.json'

export const resources = { ru: { translation: ru }, en: { translation: en } } as const

export function initI18n(lang: Lang): void {
  void i18n.use(initReactI18next).init({
    resources,
    lng: lang,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnNull: false
  })
  document.documentElement.lang = lang
}

export function setLanguage(lang: Lang): void {
  void i18n.changeLanguage(lang)
  document.documentElement.lang = lang
}

export default i18n
