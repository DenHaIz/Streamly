import type { StreamlyBridge } from '@shared/ipc'

declare global {
  interface Window {
    streamly?: StreamlyBridge
  }
}

/** API основного процесса (или фейковый, если интерфейс открыт в браузере). */
export const api = (): StreamlyBridge => window.streamly!
