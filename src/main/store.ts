import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Cipher {
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

/**
 * Простое JSON-хранилище в файле. Запись атомарная (через временный файл).
 * Если передан cipher, файл шифруется (в Electron это safeStorage/DPAPI).
 */
export class JsonFile<T extends object> {
  private data: T

  constructor(
    private readonly path: string,
    private readonly defaults: () => T,
    private readonly cipher?: Cipher
  ) {
    this.data = this.load()
  }

  get(): T {
    return this.data
  }

  set(next: T): void {
    this.data = next
    this.save()
  }

  update(fn: (draft: T) => void): T {
    fn(this.data)
    this.save()
    return this.data
  }

  private load(): T {
    if (!existsSync(this.path)) return this.defaults()
    try {
      const raw = readFileSync(this.path)
      const text = this.cipher ? this.cipher.decrypt(raw) : raw.toString('utf8')
      const parsed = JSON.parse(text) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      return { ...this.defaults(), ...(parsed as Partial<T>) }
    } catch {
      // Не удалось прочитать (повреждение, смена ключа DPAPI): сохраняем копию, чтобы данные можно было восстановить.
      try {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`)
      } catch {
        /* не получилось переименовать — просто начинаем с чистого */
      }
      return this.defaults()
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const text = JSON.stringify(this.data, null, 2)
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, this.cipher ? this.cipher.encrypt(text) : text)
    // Антивирус может ненадолго держать файл: несколько попыток переименования.
    for (let i = 0; ; i++) {
      try {
        renameSync(tmp, this.path)
        return
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (i >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
        const until = Date.now() + 50 * (i + 1)
        while (Date.now() < until) {
          /* короткое ожидание: запись настроек синхронная */
        }
      }
    }
  }
}

/** Глубокое слияние частичного объекта в целый (массивы заменяются целиком). */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch) || typeof base !== 'object' || base === null) {
    return patch as T
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) continue
    out[k] = deepMerge(out[k], v)
  }
  return out as T
}
