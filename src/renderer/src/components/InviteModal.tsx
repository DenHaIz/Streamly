import { PlugZap } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '@/store/app'
import { api } from '@/lib/bridge'
import { Avatar, Button, Modal, useLastNonNull } from '@/components/ui'

/**
 * Приглашение от хоста: ссылка streamly://join/… (открыта из браузера или «Выполнить»)
 * или скопированная в буфер обмена — Discord не делает такие ссылки кликабельными.
 */
export function InviteModal() {
  const { t } = useTranslation()
  const current = useApp((s) => s.invite)
  const invite = useLastNonNull(current)
  const setInvite = useApp((s) => s.setInvite)

  useEffect(() => {
    const check = (): void => {
      const { client, screen } = useApp.getState()
      // Во время подключения, игры или хостинга не отвлекаем.
      if (client.phase !== 'idle' && client.phase !== 'ended' && client.phase !== 'error') return
      if (screen === 'host' || screen === 'onboarding') return
      void api()
        .checkInvite()
        .then((inv) => inv && setInvite(inv))
    }
    check()
    window.addEventListener('focus', check)
    const off = api().on('invite', (inv) => setInvite(inv))
    return () => {
      window.removeEventListener('focus', check)
      off()
    }
  }, [setInvite])

  const join = (): void => {
    if (!current || !invite) return
    setInvite(null)
    useApp.getState().go('connect')
    void api().client.connect(invite.address, invite.code)
  }

  return (
    <Modal open={!!current} onClose={() => setInvite(null)}>
      {invite && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
            <Avatar name={invite.name} size={56} />
          </div>
          <h3 style={{ margin: '0 0 6px' }}>{t('invite.title', { name: invite.name })}</h3>
          <p className="muted" style={{ margin: '0 0 6px' }}>
            {invite.address}
          </p>
          <p className="faint" style={{ fontSize: 12.5, margin: '0 0 18px' }}>
            {invite.code ? t('invite.noApproval') : t('invite.withApproval')}
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <Button onClick={() => setInvite(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" icon={<PlugZap size={16} />} onClick={join}>
              {t('connect.connect')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
