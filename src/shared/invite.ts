import type { HostState, Lang } from './types'

/** Адрес хоста в ZeroTier, если он есть и не основной (основной — Radmin). */
export function ztAddress(host: Pick<HostState, 'address' | 'addresses'>): string | undefined {
  return host.addresses?.find((a) => a.kind === 'zerotier' && a.ip !== host.address)?.ip
}

/** Сообщение-приглашение для Discord: одинаковое из окна хоста и из меню в трее. */
export function inviteMessage(lang: Lang, p: { name: string; address: string; link: string; zt?: string; ztOnly?: boolean }): string {
  const net = p.ztOnly ? 'ZeroTier' : 'Radmin VPN'
  return lang === 'ru'
    ? [
        'Заходи ко мне в Streamly!',
        p.link,
        'Скопируй это сообщение и открой Streamly — он сам предложит подключиться (ссылка действует 12 часов).',
        `Нет ссылки? ${net}: наша общая сеть → Streamly → «Подключиться» → «${p.name}» или адрес ${p.address}.`,
        ...(p.zt ? [`Через ZeroTier — адрес ${p.zt}.`] : []),
        'Нет Streamly: https://github.com/DenHaIz/Streamly/releases/latest'
      ].join('\n')
    : [
        'Join me in Streamly!',
        p.link,
        'Copy this message and open Streamly — it will offer to connect (the link works for 12 hours).',
        `No link? ${net}: our shared network → Streamly → "Connect" → "${p.name}" or address ${p.address}.`,
        ...(p.zt ? [`Over ZeroTier — address ${p.zt}.`] : []),
        'No Streamly yet: https://github.com/DenHaIz/Streamly/releases/latest'
      ].join('\n')
}

/** Параметры приглашения из состояния хоста. */
export function inviteParams(host: Pick<HostState, 'address' | 'addresses' | 'hostName'>, link: string) {
  const main = host.addresses?.find((a) => a.ip === host.address)
  return { name: host.hostName, address: host.address ?? '', link, zt: ztAddress(host), ztOnly: main?.kind === 'zerotier' }
}
