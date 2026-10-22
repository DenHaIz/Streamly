import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { deflateRaw, deflateRawSync } from 'node:zlib'

const deflateRawAsync = promisify(deflateRaw)

/** Сколько дней хранится журнал. */
export const LOG_RETENTION_DAYS = 14
/** Больше этого за день пишутся только ошибки: журнал не разрастается, даже если что-то зациклилось. */
const DAY_LIMIT = 25 * 1024 * 1024
/** Жёсткий предел за день (и для ошибок). */
const DAY_HARD_LIMIT = 50 * 1024 * 1024
const DAY_FILE = /^streamly-\d{4}-\d\d-\d\d\.log$/

const pad = (n: number): string => String(n).padStart(2, '0')
const dayOf = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * Журнал Streamly: по файлу на день (streamly-ГГГГ-ММ-ДД.log) в папке logs, старше 14 дней удаляются.
 * Пишется синхронно и коротко (open-append-close): при падении процесса последние строки не теряются.
 */
export class DailyLog {
  private day = ''
  private file = ''
  private size = 0

  constructor(readonly dir: string, private readonly retentionDays = LOG_RETENTION_DAYS) {
    mkdirSync(dir, { recursive: true })
    this.prune()
  }

  /** Путь к журналу за сегодня. */
  get current(): string {
    this.roll()
    return this.file
  }

  private roll(): void {
    const today = dayOf(new Date())
    if (today === this.day) return
    this.day = today
    this.file = join(this.dir, `streamly-${today}.log`)
    try {
      this.size = statSync(this.file).size
    } catch {
      this.size = 0
    }
    // Новый день — заодно убираем журналы старше срока (Streamly может работать неделями без перезапуска).
    this.prune()
  }

  write(line: string, important = false): void {
    try {
      this.roll()
      if (this.size > DAY_LIMIT && !important) return
      if (this.size > DAY_HARD_LIMIT) return
      const text = (this.size + line.length > DAY_HARD_LIMIT ? '--- log limit for today reached ---' : line) + '\n'
      appendFileSync(this.file, text)
      this.size += Buffer.byteLength(text)
    } catch {
      /* журнал не критичен */
    }
  }

  /** Журналы по дням, от старых к новым. */
  files(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => /^streamly-.*\.log$/.test(f))
        .sort()
        .map((f) => join(this.dir, f))
    } catch {
      return []
    }
  }

  /** Удаляет журналы старше срока хранения (по дате изменения файла). */
  prune(now = Date.now()): void {
    const limit = now - this.retentionDays * 24 * 3600_000
    for (const f of this.files()) {
      try {
        if (statSync(f).mtimeMs < limit) rmSync(f, { force: true })
      } catch {
        /* занят или уже удалён */
      }
    }
  }

  /** Последние строки за сегодня (и вчера, если сегодня ещё мало). */
  tail(lines: number): string {
    const out: string[] = []
    // Только журналы по дням (старый журнал до 0.5 сортируется после них по имени).
    for (const f of this.files().filter((p) => DAY_FILE.test(basename(p))).reverse()) {
      try {
        const chunk = readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean)
        out.unshift(...chunk.slice(-(lines - out.length)))
      } catch {
        /* нет файла */
      }
      if (out.length >= lines) break
    }
    return out.join('\n')
  }

  /** Старый журнал (до 0.5: streamly.log в корне данных) переезжает в папку logs. */
  adoptLegacy(dataDir: string): void {
    for (const name of ['streamly.log', 'streamly.log.old']) {
      const src = join(dataDir, name)
      if (!existsSync(src)) continue
      try {
        renameSync(src, join(this.dir, `streamly-before-0.5${name.endsWith('.old') ? '-old' : ''}.log`))
      } catch {
        rmSync(src, { force: true })
      }
    }
  }
}

// ---------- ZIP без сторонних библиотек: журналы для отправки одним файлом ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  name: string
  data: Buffer
}

/** Простой ZIP (deflate): открывается проводником Windows и любым архиватором. */
export function makeZip(entries: ZipEntry[], date = new Date(), packedData?: Buffer[]): Buffer {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [i, e] of entries.entries()) {
    const name = Buffer.from(e.name, 'utf8')
    const packed = packedData?.[i] ?? deflateRawSync(e.data)
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // имена в UTF-8
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, packed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + packed.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

/**
 * Собирает архив журналов: файлы по дням плюс дополнительные записи (отчёт, лог Moonlight, Apollo).
 * Асинхронно и по одному файлу: сжатие десятков мегабайт не должно останавливать основной процесс (и хостинг).
 */
export async function writeLogArchive(target: string, log: DailyLog, extra: ZipEntry[]): Promise<void> {
  const entries: ZipEntry[] = []
  for (const f of log.files()) {
    try {
      entries.push({ name: `logs/${basename(f)}`, data: await readFile(f) })
    } catch {
      /* пропускаем */
    }
  }
  entries.push(...extra)
  const packed: Buffer[] = []
  for (const e of entries) packed.push(await deflateRawAsync(e.data))
  await writeFile(target, makeZip(entries, new Date(), packed))
}
