import { Component, type ReactNode } from 'react'
import { api } from '@/lib/bridge'

/**
 * Ошибка отрисовки в окне поверх игры не должна оставлять невидимое окно с фокусом над игрой:
 * пишем её в журнал и закрываем окно.
 */
export class OverlayBoundary extends Component<{ children: ReactNode; onFail: () => void }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    void api()
      .logError(`${location.hash} render error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      .catch(() => undefined)
    this.props.onFail()
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
