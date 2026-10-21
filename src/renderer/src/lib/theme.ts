import { useEffect, useState } from 'react'
import { useApp } from '@/store/app'
import { api } from './bridge'

const media = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

/** Применяет тему к <html data-theme> и цвет системных кнопок окна. */
export function useResolvedTheme(): 'light' | 'dark' {
  const pref = useApp((s) => s.settings?.theme ?? 'system')
  const [systemDark, setSystemDark] = useState(() => media().matches)

  useEffect(() => {
    const m = media()
    const on = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])

  const resolved = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref
  useEffect(() => {
    document.documentElement.dataset.theme = resolved
    void api().setTitleBar(resolved === 'dark')
  }, [resolved])
  return resolved
}
