import { request as httpRequest } from 'node:http'
import { request as httpsRequest, Agent } from 'node:https'

/** Запись клиента из GET /api/clients/list (Apollo). */
export interface ApolloClient {
  name: string
  uuid: string
  display_mode: string
  perm: number
  enable_legacy_ordering: boolean
  allow_client_commands: boolean
  always_use_virtual_display: boolean
  connected: boolean
  do?: unknown[]
  undo?: unknown[]
}

export class ApolloError extends Error {
  constructor(
    readonly kind: 'unreachable' | 'auth' | 'needsSetup' | 'http',
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

export interface Credentials {
  username: string
  password: string
}

interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** Ключи, которые GET /api/config добавляет сам: их нельзя отправлять обратно, иначе они попадут в sunshine.conf. */
const CONFIG_META_KEYS = new Set(['status', 'platform', 'version', 'vdisplayStatus', 'restart_supported'])

/**
 * Клиент веб-API Apollo (https://127.0.0.1:47990, самоподписанный сертификат).
 * Apollo держит одну сессию входа на всех, поэтому при 401 заново логинимся.
 */
export class ApolloApi {
  private cookie: string | null = null
  private readonly agent: Agent

  constructor(
    private readonly getCredentials: () => Credentials | undefined,
    private readonly baseUrl = 'https://127.0.0.1:47990',
    private readonly timeoutMs = 8000
  ) {
    this.agent = new Agent({ rejectUnauthorized: false, keepAlive: true })
  }

  private raw(method: string, path: string, body?: unknown, auth = true): Promise<RawResponse> {
    const url = new URL(path, this.baseUrl)
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (payload !== undefined || method === 'POST') headers['Content-Type'] = 'application/json'
    if (payload !== undefined) headers['Content-Length'] = String(Buffer.byteLength(payload))
    if (auth && this.cookie) headers.Cookie = `auth=${this.cookie}`

    // http нужен только тестам с локальным mock-сервером; Apollo всегда отвечает по https.
    const isHttps = url.protocol === 'https:'
    const request = isHttps ? httpsRequest : httpRequest
    return new Promise((resolve, reject) => {
      const req = request(url, { method, headers, agent: isHttps ? this.agent : undefined, timeout: this.timeoutMs }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        )
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', (e) => reject(new ApolloError('unreachable', e.message)))
      req.end(payload)
    })
  }

  /** Проверяет, что Apollo отвечает. Возвращает 'ok', 'needsSetup' (нет учётных данных) или 'down'. */
  async probe(): Promise<'ok' | 'needsSetup' | 'down'> {
    try {
      const res = await this.raw('GET', '/api/clients/list', undefined, false)
      if (res.status === 307 || res.status === 302) {
        const loc = String(res.headers.location ?? '')
        if (loc.includes('welcome')) return 'needsSetup'
      }
      return 'ok'
    } catch {
      return 'down'
    }
  }

  /** Первичная установка логина и пароля (работает без входа, пока учётных данных нет). */
  async setInitialCredentials(c: Credentials): Promise<void> {
    const res = await this.raw(
      'POST',
      '/api/password',
      { currentUsername: '', currentPassword: '', newUsername: c.username, newPassword: c.password, confirmNewPassword: c.password },
      false
    )
    if (res.status !== 200) throw new ApolloError('http', `password: ${res.status} ${res.body}`, res.status)
    this.cookie = null
  }

  /** Вход (в общей очереди вызовов). */
  login(c?: Credentials): Promise<void> {
    return this.exclusive(() => this.loginNow(c ?? this.getCredentials()))
  }

  private async loginNow(c: Credentials | undefined): Promise<void> {
    if (!c) throw new ApolloError('auth', 'no credentials')
    const res = await this.raw('POST', '/api/login', { username: c.username, password: c.password }, false)
    if (res.status === 307) throw new ApolloError('needsSetup', 'credentials not set')
    if (res.status !== 200) throw new ApolloError('auth', `login failed: ${res.status}`, res.status)
    const setCookie = res.headers['set-cookie']
    const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
    const match = all.map((s) => /(?:^|;\s*)auth=([^;]+)/.exec(s)).find(Boolean)
    if (!match) throw new ApolloError('auth', 'no auth cookie')
    this.cookie = match[1]
  }

  /** Цепочка вызовов: у Apollo одна сессия на всех, параллельные входы вытесняли бы друг друга. */
  private queue: Promise<unknown> = Promise.resolve()

  /** Выполняет fn после всех ранее поставленных вызовов (чтение-изменение-запись не перемешиваются). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.exclusive(() => this.callNow<T>(method, path, body))
  }

  private async callNow<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.cookie) await this.loginNow(this.getCredentials())
    let res = await this.raw(method, path, body)
    if (res.status === 401) {
      await this.loginNow(this.getCredentials())
      res = await this.raw(method, path, body)
    }
    if (res.status === 307) throw new ApolloError('needsSetup', 'credentials not set')
    if (res.status === 401) throw new ApolloError('auth', 'unauthorized', 401)
    if (res.status < 200 || res.status >= 300) throw new ApolloError('http', `${path}: ${res.status} ${res.body}`, res.status)
    if (!res.body) return {} as T
    try {
      return JSON.parse(res.body) as T
    } catch {
      return {} as T
    }
  }

  async listClients(): Promise<ApolloClient[]> {
    const r = await this.call<{ named_certs?: ApolloClient[] }>('GET', '/api/clients/list')
    return Array.isArray(r.named_certs) ? r.named_certs : []
  }

  /** Обновляет клиента. Apollo обнуляет пропущенные поля, поэтому отправляем запись целиком. */
  private static clientPayload(full: ApolloClient): Record<string, unknown> {
    return {
      uuid: full.uuid,
      name: full.name,
      display_mode: full.display_mode ?? '',
      do: full.do ?? [],
      undo: full.undo ?? [],
      perm: full.perm >>> 0,
      enable_legacy_ordering: full.enable_legacy_ordering ?? true,
      allow_client_commands: full.allow_client_commands ?? true,
      always_use_virtual_display: full.always_use_virtual_display ?? false
    }
  }

  /** Меняет права клиента: чтение и запись полной записи атомарно относительно других вызовов. */
  setPerm(uuid: string, perm: number): Promise<boolean> {
    return this.exclusive(async () => {
      const r = await this.callNow<{ named_certs?: ApolloClient[] }>('GET', '/api/clients/list')
      const client = (r.named_certs ?? []).find((c) => c.uuid === uuid)
      if (!client) return false
      if (client.perm === perm) return true
      const res = await this.callNow<{ status?: boolean }>('POST', '/api/clients/update', ApolloApi.clientPayload({ ...client, perm }))
      return res.status === true
    })
  }

  async disconnect(uuid: string): Promise<boolean> {
    const r = await this.call<{ status?: boolean }>('POST', '/api/clients/disconnect', { uuid })
    return r.status === true
  }

  async unpair(uuid: string): Promise<boolean> {
    const r = await this.call<{ status?: boolean }>('POST', '/api/clients/unpair', { uuid })
    return r.status === true
  }

  /** Отправляет PIN первому ожидающему сопряжению. false, если ожидающего сопряжения ещё нет. */
  async submitPin(pin: string, name: string): Promise<boolean> {
    const r = await this.call<{ status?: boolean }>('POST', '/api/pin', { pin, name })
    return r.status === true
  }

  async getConfig(): Promise<Record<string, string>> {
    return ApolloApi.stripConfig(await this.call<Record<string, unknown>>('GET', '/api/config'))
  }

  private static stripConfig(r: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(r)) {
      if (CONFIG_META_KEYS.has(k) || v === null || v === undefined || v === '') continue
      out[k] = typeof v === 'string' ? v : JSON.stringify(v)
    }
    return out
  }

  /**
   * Меняет часть конфигурации. POST /api/config перезаписывает весь файл,
   * поэтому сначала читаем текущий конфиг и сливаем. Возвращает true, если что-то поменялось.
   */
  patchConfig(patch: Record<string, string>): Promise<boolean> {
    return this.exclusive(async () => {
      const current = ApolloApi.stripConfig(await this.callNow<Record<string, unknown>>('GET', '/api/config'))
      const changed = Object.entries(patch).some(([k, v]) => current[k] !== v)
      if (!changed) return false
      await this.callNow('POST', '/api/config', { ...current, ...patch })
      return true
    })
  }

  /** Перезапуск Apollo. Процесс обычно падает до ответа, это нормально. */
  async restart(): Promise<void> {
    try {
      await this.call('POST', '/api/restart', {})
    } catch {
      /* соединение рвётся при перезапуске */
    }
    this.cookie = null
  }
}
