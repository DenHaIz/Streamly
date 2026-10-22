import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/theme.css'
import './styles/screens.css'
import { App } from './App'
import { Overlay } from './screens/Overlay'
import { HostMenu, HostNotify } from './screens/HostOverlays'
import { initI18n } from './i18n'
import { useApp } from './store/app'
import { api } from './lib/bridge'
import { OverlayBoundary } from './components/ErrorBoundary'

/** Ошибки интерфейса — в журнал Streamly (для разбора по архиву журнала). */
function reportErrors(): void {
  const send = (text: string): void => void api().logError(`${location.hash || '#main'} ${text}`).catch(() => undefined)
  window.addEventListener('error', (e) => {
    // Безобидное предупреждение браузера о ResizeObserver — не ошибка Streamly.
    if (/ResizeObserver loop/.test(e.message)) return
    send(`${e.message} at ${e.filename}:${e.lineno}:${e.colno}${e.error?.stack ? `\n${e.error.stack}` : ''}`)
  })
  window.addEventListener('unhandledrejection', (e) => send(`unhandled rejection: ${e.reason instanceof Error ? (e.reason.stack ?? e.reason.message) : String(e.reason)}`))
}

async function boot(): Promise<void> {
  // В обычном браузере (npm run dev:web) нет Electron: подключаем фейковый API.
  if (!window.streamly) await import('./dev/mockBridge')
  reportErrors()
  // Окна поверх игры — то же приложение в прозрачном окне: меню игрока (Alt+F2), меню хоста и плашка запросов.
  const views: Record<string, (() => ReactNode) | undefined> = {
    '#overlay': () => (
      <OverlayBoundary onFail={() => void api().overlay.close()}>
        <Overlay />
      </OverlayBoundary>
    ),
    '#hostmenu': () => (
      <OverlayBoundary onFail={() => void api().host.closeMenu()}>
        <HostMenu />
      </OverlayBoundary>
    ),
    '#hostnotify': () => (
      <OverlayBoundary onFail={() => undefined}>
        <HostNotify />
      </OverlayBoundary>
    )
  }
  const view = views[location.hash]
  if (view) document.documentElement.classList.add('overlay-mode')
  if (location.hash === '#hostnotify') document.documentElement.classList.add('notify-mode')
  await useApp.getState().init()
  initI18n(useApp.getState().settings!.language)
  createRoot(document.getElementById('root')!).render(<StrictMode>{view ? view() : <App />}</StrictMode>)
}

void boot()
