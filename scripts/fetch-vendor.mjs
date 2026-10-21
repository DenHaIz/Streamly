// Скачивает готовые сборки Apollo (хост) и Moonlight (клиент) с их официальных релизов на GitHub
// в папку vendor/, откуда electron-builder кладёт их в установщик.
//
//   npm run fetch-vendor            скачать и проверить по vendor.lock.json
//   npm run fetch-vendor -- --pin   записать SHA-256 скачанных файлов в vendor.lock.json
//
// Хэши закрепляются при первом скачивании (--pin), дальше любое расхождение — ошибка.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'vendor')
const lockPath = join(root, 'vendor.lock.json')

const ASSETS = [
  {
    name: 'apollo',
    url: 'https://github.com/ClassicOldSong/Apollo/releases/download/v0.4.6/Apollo-0.4.6.exe',
    file: 'apollo/Apollo-setup.exe'
  },
  {
    name: 'moonlight',
    url: 'https://github.com/moonlight-stream/moonlight-qt/releases/download/v6.2.0/MoonlightPortable-x64-6.2.0.zip',
    file: 'moonlight.zip',
    extractTo: 'moonlight'
  }
]

const pin = process.argv.includes('--pin')
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : {}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, buf)
  return createHash('sha256').update(buf).digest('hex')
}

/** Moonlight.exe может лежать во вложенной папке архива: поднимаем содержимое на уровень выше. */
function flattenTo(dir) {
  const find = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      if (e.toLowerCase() === 'moonlight.exe') return d
      if (statSync(p).isDirectory()) {
        const r = find(p)
        if (r) return r
      }
    }
    return null
  }
  const exeDir = find(dir)
  if (!exeDir) throw new Error('Moonlight.exe not found in archive')
  if (exeDir === dir) return
  for (const e of readdirSync(exeDir)) renameSync(join(exeDir, e), join(dir, e))
}

for (const a of ASSETS) {
  const dest = join(vendor, a.file)
  process.stdout.write(`↓ ${a.name}: ${a.url}\n`)
  const hash = await download(a.url, dest)
  if (pin) {
    lock[a.name] = { url: a.url, sha256: hash }
  } else if (lock[a.name]?.sha256 && lock[a.name].sha256 !== hash) {
    rmSync(dest, { force: true })
    throw new Error(`${a.name}: SHA-256 mismatch (expected ${lock[a.name].sha256}, got ${hash})`)
  } else if (!lock[a.name]) {
    process.stdout.write(`  ! ${a.name} не закреплён в vendor.lock.json, запустите с --pin\n`)
  }
  process.stdout.write(`  sha256 ${hash}\n`)
  if (a.extractTo) {
    const out = join(vendor, a.extractTo)
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
    // tar из Windows 10+ (bsdtar) умеет распаковывать zip. Именно его, а не GNU tar из Git Bash:
    // тот принимает «C:» за имя удалённого хоста и не распаковывает ничего.
    const winTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    execFileSync(existsSync(winTar) ? winTar : 'tar', ['-xf', dest, '-C', out], { stdio: 'inherit' })
    flattenTo(out)
    rmSync(dest, { force: true })
  }
}

if (pin) writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
process.stdout.write('✓ vendor готов\n')
