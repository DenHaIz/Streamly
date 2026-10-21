import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApolloApi, ApolloError } from '../src/main/services/apollo/api'

/** Минимальная имитация веб-API Apollo (по src/confighttp.cpp). */
class FakeApolloServer {
  server: Server
  creds: { username: string; password: string } | null = { username: 'u', password: 'p' }
  session: string | null = null
  config: Record<string, string> = { sunshine_name: 'Old', port: '47989' }
  clients = [
    { name: 'A', uuid: 'a1', display_mode: '1920x1080x60', perm: 0x3000000, enable_legacy_ordering: false, allow_client_commands: false, always_use_virtual_display: true, connected: false, do: [{ cmd: 'x' }], undo: [] }
  ]
  updates: Record<string, unknown>[] = []
  posted: Record<string, unknown>[] = []
  pinPending = false
  logins = 0

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res))
  }

  async listen(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()))
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  private body(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {}))
    })
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const json = (status: number, obj?: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
      res.end(obj === undefined ? '' : JSON.stringify(obj))
    }
    const path = req.url ?? ''
    if (req.method === 'POST' && req.headers['content-type'] !== 'application/json') return json(400, { status: false, error: 'Content type mismatch' })
    const body = await this.body(req)

    if (path === '/api/password' && !this.creds) {
      this.creds = { username: String(body.newUsername), password: String(body.newPassword) }
      return json(200, { status: true })
    }
    if (!this.creds) {
      res.writeHead(307, { Location: '/welcome' })
      return void res.end()
    }
    if (path === '/api/login') {
      if (body.username !== this.creds.username || body.password !== this.creds.password) return json(401)
      this.logins++
      // Apollo держит одну сессию: новый вход вытесняет старый.
      this.session = `s${this.logins}`.padEnd(64, 'x')
      return json(200, undefined, { 'Set-Cookie': `auth=${this.session}; Secure; SameSite=Strict; Max-Age=2592000; Path=/` })
    }
    const cookie = /auth=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
    if (!cookie || cookie !== this.session) return json(401, { status_code: 401, status: false, error: 'Unauthorized' })

    switch (path) {
      case '/api/clients/list':
        return json(200, { named_certs: this.clients, platform: 'windows', status: true })
      case '/api/clients/update': {
        this.updates.push(body)
        const c = this.clients.find((x) => x.uuid === body.uuid)
        if (c) Object.assign(c, body)
        return json(200, { status: !!c })
      }
      case '/api/pin':
        if (!this.pinPending || !/^\d{4}$/.test(String(body.pin))) return json(200, { status: false })
        this.pinPending = false
        this.clients.push({ ...this.clients[0], name: String(body.name), uuid: 'new', perm: 0x3000000 })
        return json(200, { status: true })
      case '/api/config':
        if (req.method === 'GET') return json(200, { status: true, platform: 'windows', version: '0.4.6', vdisplayStatus: 0, ...this.config })
        this.posted.push(body)
        this.config = body as Record<string, string>
        return json(200, { status: true })
      default:
        return json(404)
    }
  }
}

describe('ApolloApi', () => {
  let fake: FakeApolloServer
  let api: ApolloApi

  beforeEach(async () => {
    fake = new FakeApolloServer()
    const url = await fake.listen()
    api = new ApolloApi(() => fake.creds ?? undefined, url)
  })
  afterEach(() => fake.server.close())

  it('reports first-run setup and sets credentials', async () => {
    fake.creds = null
    expect(await api.probe()).toBe('needsSetup')
    await api.setInitialCredentials({ username: 'streamly', password: 'secret' })
    expect(fake.creds).toEqual({ username: 'streamly', password: 'secret' })
    expect(await api.probe()).toBe('ok')
  })

  it('logs in lazily and re-logs in when another session took over', async () => {
    expect(await api.listClients()).toHaveLength(1)
    expect(fake.logins).toBe(1)
    fake.session = 'someone-else'
    expect(await api.listClients()).toHaveLength(1)
    expect(fake.logins).toBe(2)
  })

  it('fails with auth error on wrong password', async () => {
    const bad = new ApolloApi(() => ({ username: 'u', password: 'wrong' }), (api as unknown as { baseUrl: string }).baseUrl)
    await expect(bad.listClients()).rejects.toBeInstanceOf(ApolloError)
  })

  it('sends the full client record when changing permissions', async () => {
    expect(await api.setPerm('a1', 0x1000)).toBe(true)
    const u = fake.updates[0]
    expect(u.perm).toBe(0x1000)
    expect(u.display_mode).toBe('1920x1080x60')
    expect(u.always_use_virtual_display).toBe(true)
    expect(u.allow_client_commands).toBe(false)
    expect(u.do).toEqual([{ cmd: 'x' }])
    // Повторная установка того же значения не шлёт запрос.
    expect(await api.setPerm('a1', 0x1000)).toBe(true)
    expect(fake.updates).toHaveLength(1)
  })

  it('merges config and strips meta keys', async () => {
    expect(await api.patchConfig({ sunshine_name: 'New', origin_web_ui_allowed: 'pc' })).toBe(true)
    expect(fake.posted[0]).toEqual({ sunshine_name: 'New', port: '47989', origin_web_ui_allowed: 'pc' })
    expect(await api.patchConfig({ sunshine_name: 'New' })).toBe(false)
    expect(fake.posted).toHaveLength(1)
  })

  it('submits PIN only when a pairing is pending', async () => {
    expect(await api.submitPin('1234', 'Friend')).toBe(false)
    fake.pinPending = true
    expect(await api.submitPin('1234', 'Friend')).toBe(true)
    expect((await api.listClients()).map((c) => c.name)).toContain('Friend')
  })

  it('reports unreachable server', async () => {
    const dead = new ApolloApi(() => undefined, 'http://127.0.0.1:1', 1000)
    expect(await dead.probe()).toBe('down')
  })
})
