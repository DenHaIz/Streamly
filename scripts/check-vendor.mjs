// Перед сборкой установщика: все программы из комплекта на месте (иначе установщик соберётся «пустым»).
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const vendor = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor')
const required = [
  ['apollo/Apollo-setup.exe', 'npm run fetch-vendor'],
  ['moonlight/Moonlight.exe', 'npm run fetch-vendor'],
  ['helper/StreamlyHelper.exe', 'npm run build:helper']
]
const missing = required.filter(([file, fix]) => fix && !existsSync(join(vendor, file)))
if (missing.length) {
  for (const [file, fix] of missing) console.error(`check-vendor: vendor/${file} is missing — run \`${fix}\``)
  process.exit(1)
}
console.log('check-vendor: ok')
