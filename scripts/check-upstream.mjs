// Есть ли новые версии Apollo и Moonlight по сравнению с теми, что в комплекте (vendor.lock.json).
// Запуск: npm run check-upstream. Обновление комплекта — ссылки в scripts/fetch-vendor.mjs и npm run fetch-vendor -- --pin.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const lock = JSON.parse(readFileSync(join(root, 'vendor.lock.json'), 'utf8'))
const projects = [
  { name: 'Apollo', repo: 'ClassicOldSong/Apollo', url: lock.apollo?.url },
  { name: 'Moonlight-qt', repo: 'moonlight-stream/moonlight-qt', url: lock.moonlight?.url }
]
const num = (v) => (v ?? '').replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0)
const newer = (a, b) => {
  const pa = num(a)
  const pb = num(b)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

let updates = 0
for (const p of projects) {
  const current = /\/v([\d.]+)\//.exec(p.url ?? '')?.[1] ?? '?'
  const res = await fetch(`https://api.github.com/repos/${p.repo}/releases?per_page=10`, { headers: { 'User-Agent': 'streamly-check-upstream', Accept: 'application/vnd.github+json' } })
  if (!res.ok) {
    console.log(`${p.name}: GitHub ${res.status}`)
    continue
  }
  const releases = await res.json()
  const stable = releases.find((r) => !r.prerelease && !r.draft)
  const pre = releases.find((r) => r.prerelease && !r.draft)
  const latest = stable?.tag_name?.replace(/^v/, '')
  let line = `${p.name}: в комплекте ${current}, последняя стабильная ${latest ?? '?'} (${stable?.published_at?.slice(0, 10) ?? '?'})`
  if (pre && newer(pre.tag_name, stable?.tag_name ?? '0')) line += `, тестовая ${pre.tag_name} (${pre.published_at?.slice(0, 10)})`
  if (latest && newer(latest, current)) {
    line += ' — ЕСТЬ ОБНОВЛЕНИЕ'
    updates++
  }
  console.log(line)
}
console.log(updates ? 'Обновите ссылки в scripts/fetch-vendor.mjs и выполните npm run fetch-vendor -- --pin, затем проверьте на реальном ПК.' : 'Комплект актуален.')
