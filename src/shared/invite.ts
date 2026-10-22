import type { Lang } from './types'

/** Сообщение-приглашение для Discord: одинаковое из окна хоста и из меню в трее. */
export function inviteMessage(lang: Lang, p: { name: string; address: string; link: string }): string {
  return lang === 'ru'
    ? [
        'Заходи ко мне в Streamly!',
        p.link,
        'Скопируй это сообщение и открой Streamly — он сам предложит подключиться (ссылка действует 12 часов).',
        `Нет ссылки? Radmin VPN: наша общая сеть → Streamly → «Подключиться» → «${p.name}» или адрес ${p.address}.`,
        'Нет Streamly: https://github.com/DenHaIz/Streamly/releases/latest'
      ].join('\n')
    : [
        'Join me in Streamly!',
        p.link,
        'Copy this message and open Streamly — it will offer to connect (the link works for 12 hours).',
        `No link? Radmin VPN: our shared network → Streamly → "Connect" → "${p.name}" or address ${p.address}.`,
        'No Streamly yet: https://github.com/DenHaIz/Streamly/releases/latest'
      ].join('\n')
}
