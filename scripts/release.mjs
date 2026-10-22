// Публикация релиза на GitHub: установщик, .blockmap и latest.yml (без них не работает автообновление).
// Запуск: npm run release -- --notes release-notes.md [--draft]
// Токен берётся из git credential manager (тот же, что у git push) и не выводится.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const REPO = 'DenHaIz/Streamly'
const root = join(import.meta.dirname, '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const [major, minor, patch] = version.split('.')
const tag = `v${major}.${minor}${patch && patch !== '0' ? `.${patch}` : ''}`

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const notesPath = arg('--notes')
if (!notesPath || !existsSync(notesPath)) {
  console.error('usage: npm run release -- --notes <file.md> [--draft]')
  process.exit(1)
}
const draft = process.argv.includes('--draft')

const dist = join(root, 'dist')
const installer = join(dist, `Streamly-Setup-${version}.exe`)
const files = [installer, `${installer}.blockmap`, join(dist, 'latest.yml')]
for (const f of files) {
  if (!existsSync(f)) {
    console.error(`missing ${f} — run npm run dist first`)
    process.exit(1)
  }
}
// latest.yml должен указывать на этот же установщик (иначе обновление скачает не тот файл или не найдёт его).
const latest = readFileSync(files[2], 'utf8')
if (!latest.includes(`version: ${version}`) || !latest.includes(basename(installer))) {
  console.error('latest.yml does not match the installer: rebuild with npm run dist')
  process.exit(1)
}
const sha256 = createHash('sha256').update(readFileSync(installer)).digest('hex')

const cred = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' })
const token = /^password=(.*)$/m.exec(cred)?.[1]
if (!token) throw new Error('no GitHub credential found')
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'streamly-release' }
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()

const body = readFileSync(notesPath, 'utf8').replaceAll('{{sha256}}', sha256).replaceAll('{{asset}}', basename(installer))

const existing = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers })
if (existing.status === 200) throw new Error(`release ${tag} already exists`)
const res = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ tag_name: tag, target_commitish: commit, name: `Streamly ${major}.${minor}${patch && patch !== '0' ? `.${patch}` : ''}`, body, draft, prerelease: false, make_latest: 'true' })
})
const rel = await res.json()
if (res.status !== 201) throw new Error(`create release: ${res.status} ${JSON.stringify(rel).slice(0, 300)}`)
console.log('release:', rel.html_url)

for (const f of files) {
  const data = readFileSync(f)
  const type = f.endsWith('.exe') ? 'application/vnd.microsoft.portable-executable' : f.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream'
  const up = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(basename(f))}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': type, 'Content-Length': String(data.length) },
    body: data
  })
  const asset = await up.json()
  if (up.status !== 201) throw new Error(`upload ${basename(f)}: ${up.status} ${JSON.stringify(asset).slice(0, 300)}`)
  console.log('asset:', asset.name, asset.size, 'bytes')
}
console.log('sha256:', sha256)
