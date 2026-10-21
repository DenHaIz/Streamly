import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/theme.css'
import './styles/screens.css'
import { App } from './App'
import { initI18n } from './i18n'
import { useApp } from './store/app'

async function boot(): Promise<void> {
  // В обычном браузере (npm run dev:web) нет Electron: подключаем фейковый API.
  if (!window.streamly) await import('./dev/mockBridge')
  await useApp.getState().init()
  initI18n(useApp.getState().settings!.language)
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void boot()
