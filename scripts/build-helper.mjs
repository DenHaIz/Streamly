// Собирает native/helper/StreamlyHelper.cs в vendor/helper/StreamlyHelper.exe.
// Компилятор C# из .NET Framework 4 есть в каждой Windows 10/11, отдельный SDK не нужен.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'native', 'helper', 'StreamlyHelper.cs')
const out = join(root, 'vendor', 'helper', 'StreamlyHelper.exe')
const windir = process.env.WINDIR ?? 'C:\\Windows'
const csc = join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')

if (process.platform !== 'win32') {
  console.log('build-helper: skipped (Windows only)')
  process.exit(0)
}
if (!existsSync(csc)) {
  console.error(`build-helper: C# compiler not found: ${csc}`)
  process.exit(1)
}
if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs && !process.argv.includes('--force')) {
  console.log('build-helper: up to date')
  process.exit(0)
}
mkdirSync(dirname(out), { recursive: true })
execFileSync(
  csc,
  [
    '/nologo',
    '/target:exe',
    '/platform:x64',
    '/optimize+',
    `/out:${out}`,
    '/r:System.Web.Extensions.dll',
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    '/r:System.Management.dll',
    src
  ],
  { stdio: 'inherit' }
)
console.log(`build-helper: ${out}`)
