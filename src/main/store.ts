import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
    try {
      const raw = readFileSync(this.path)
      const text = this.cipher ? this.cipher.decrypt(raw) : raw.toString('utf8')
      return { ...this.defaults(), ...(JSON.parse(text) as Partial<T>) }
    } catch {
      return this.defaults()
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const text = JSON.stringify(this.data, null, 2)
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, this.cipher ? this.cipher.encrypt(text) : text)
    renameSync(tmp, this.path)
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
