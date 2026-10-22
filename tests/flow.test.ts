// Сквозной сценарий: настоящие HostController и ClientController общаются по WebSocket через loopback,
// а Apollo и Moonlight заменены имитациями.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PERM, PERM_BASE, toApolloPerm } from '@shared/perms'
import type { ApolloClient } from '../src/main/services/apollo/api'
import type { ApolloLike, HostDeps, InstallerLike } from '../src/main/services/host/controller'
import type { RouterOptions, RouterState } from '../src/main/services/helper/helper'
import { HostController } from '../src/main/services/host/controller'
import { ClientController, type MoonlightLike } from '../src/main/services/client/controller'
import type { MoonlightProcess } from '../src/main/services/moonlight/runner'
import type { StreamSettings } from '@shared/types'
import { SecretsService, SettingsService } from '../src/main/settings'

class FakeApollo implements ApolloLike {
  clients: ApolloClient[] = []
  /** Сколько клиентов было «в процессе запуска» одновременно (Apollo держит только один такой запуск). */
  launching = 0
  maxLaunching = 0
  pending: { pin: string; onPaired: (uuid: string) => void } | null = null
  private seq = 0

  async probe(): Promise<'ok'> {
    return 'ok'
  }
  async setInitialCredentials(): Promise<void> {}
  async login(): Promise<void> {}
  async listClients(): Promise<ApolloClient[]> {
    return this.clients.map((c) => ({ ...c }))
  }
  async setPerm(uuid: string, perm: number): Promise<boolean> {
    const c = this.clients.find((x) => x.uuid === uuid)
    if (!c) return false
    c.perm = perm
    // Как в Apollo: без view и launch активная сессия рвётся.
    if (!(perm & PERM_BASE)) c.connected = false
    return true
  }
  async disconnect(uuid: string): Promise<boolean> {
    const c = this.clients.find((x) => x.uuid === uuid)
    if (c) c.connected = false
    return !!c
  }
  async unpair(uuid: string): Promise<boolean> {
    this.clients = this.clients.filter((c) => c.uuid !== uuid)
    return true
  }
  async submitPin(pin: string, name: string): Promise<boolean> {
    if (!this.pending || this.pending.pin !== pin) return false
    const uuid = `uuid-${++this.seq}`
    this.clients.push({
      name,
      uuid,
      display_mode: '',
      perm: 0x3000000,
      enable_legacy_ordering: true,
      allow_client_commands: true,
      always_use_virtual_display: false,
      connected: false
    })
    this.pending.onPaired(uuid)
    this.pending = null
    return true
  }
  patches: Record<string, string>[] = []
  async patchConfig(patch: Record<string, string>): Promise<boolean> {
    this.patches.push(patch)
    return false
  }
  async restart(): Promise<void> {}
  closed = 0
  async getLogs(): Promise<string> {
    return ''
  }
  async closeApp(): Promise<boolean> {
    this.closed++
    return true
  }
}

function fakeProcess(onKill?: () => void, exitCode?: number, lines: string[] = []): MoonlightProcess {
  let done!: (code: number) => void
  const exited = new Promise<number>((r) => (done = r))
  let alive = true
  if (exitCode !== undefined) setTimeout(() => {
    alive = false
    done(exitCode)
  }, 5)
  return {
    child: null as never,
    exited,
    kill: () => {
      if (!alive) return
      alive = false
      onKill?.()
      done(0)
    },
    output: () => lines
  }
}

/** Помощник звука: нашёл виртуальные колонки Steam и запоминает, что просил хост. */
class FakeAudio extends EventEmitter {
  readonly available = true
  routerState: RouterState | null = null
  calls: RouterOptions[] = []
  async router(opts: RouterOptions): Promise<RouterState> {
    this.calls.push(opts)
    this.routerState = {
      enabled: opts.enabled,
      virtualFound: true,
      virtualName: 'Steam Streaming Speakers',
      active: opts.enabled,
      monitoring: opts.enabled && opts.monitor,
      chatExcluded: opts.enabled && opts.excludeChat,
      error: null
    }
    this.emit('router', this.routerState)
    return this.routerState
  }
}

class FakeMoonlight implements MoonlightLike {
  readonly available = true
  streams = 0
  /** uuid клиента Apollo, с которым сопряжён этот «компьютер». */
  uuid: string | null = null
  pairs = 0
  /** Имитация сбоев: Moonlight не доходит до Apollo при сопряжении / стрим не устанавливается. */
  pairUnreachable = false
  streamHangs = false
  constructor(private readonly apollo: FakeApollo) {}
  private myClient(): ApolloClient | undefined {
    return this.apollo.clients.find((c) => c.uuid === this.uuid)
  }
  pair(_host: string, pin: string): MoonlightProcess {
    this.pairs++
    if (!this.pairUnreachable) this.apollo.pending = { pin, onPaired: (uuid) => (this.uuid = uuid) }
    return fakeProcess()
  }
  list(): MoonlightProcess {
    const c = this.myClient()
    if (!c) return fakeProcess(undefined, 0, ['Computer 127.0.0.1 has not been paired. Please open Moonlight to pair before streaming.'])
    // Без права list Apollo отдаёт заглушку «Permission Denied» — но сопряжение при этом есть.
    return fakeProcess(undefined, 0, (c.perm & 0x1000000) !== 0 ? ['Desktop', 'Steam Big Picture'] : ['Permission Denied'])
  }
  lastStream?: StreamSettings
  stream(_host: string, settings: StreamSettings): MoonlightProcess {
    this.lastStream = settings
    this.streams++
    const c = this.myClient()
    // Подключение устанавливается не мгновенно: проверяем, что хост не пускает два запуска сразу.
    this.apollo.launching++
    this.apollo.maxLaunching = Math.max(this.apollo.maxLaunching, this.apollo.launching)
    setTimeout(() => {
      this.apollo.launching--
      if (c && !this.streamHangs) c.connected = true
    }, 150)
    return fakeProcess(() => {
      const me = this.myClient()
      if (me) me.connected = false
    })
  }
}

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'streamly-test-'))
  dirs.push(d)
  return d
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > until) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const service = { running: true, starts: 0, stops: 0 }
const installer: InstallerLike = {
  hasBundledInstaller: true,
  status: async () => ({ installed: true, running: service.running, firewall: true, gamepadDriver: true, sunshineRunning: false, serviceControl: true }),
  setup: async () => ({ ok: true }),
  startService: async () => {
    service.starts++
    service.running = true
    return true
  },
  stopService: async () => {
    service.stops++
    service.running = false
    return true
  }
}

let portSeq = 0
function setup(maxPlayers = 4, extra: Partial<HostDeps> = {}) {
  const port = 47_950 + (portSeq++ % 40)
  const apollo = new FakeApollo()
  const hostSettings = new SettingsService(tmp(), 'ru')
  hostSettings.update({ nickname: 'Хост', host: { maxPlayers } })
  const hostSecrets = new SecretsService(tmp())
  hostSecrets.update((s) => {
    s.apollo = { username: 'u', password: 'p' }
  })
  const host = new HostController({
    settings: hostSettings,
    secrets: hostSecrets,
    apollo,
    installer,
    address: () => '127.0.0.1',
    appVersion: 'test',
    signalingPort: port,
    discoveryPort: 0,
    pollMs: 40,
    displayMode: () => ({ width: 1920, height: 1080, fps: 60 }),
    portOpen: async () => true,
    pairTimeoutMs: 2500,
    ...extra
  })

  const makeClient = (nick: string, opts: { streamStartTimeoutMs?: number; pairTimeoutMs?: number } = {}) => {
    const settings = new SettingsService(tmp(), 'ru')
    settings.update({ nickname: nick })
    const moonlight = new FakeMoonlight(apollo)
    const client = new ClientController({
      settings,
      secrets: new SecretsService(tmp()),
      moonlight,
      appVersion: 'test',
      probe: async () => [],
      neighbors: async () => [],
      signalingPort: port,
      pairSettleMs: 10,
      streamStartTimeoutMs: opts.streamStartTimeoutMs,
      moonlightLog: () => 'moonlight log tail'
    })
    return { client, settings, moonlight }
  }
  return { apollo, host, makeClient }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('host ↔ client flow', () => {
  it('approve, pair, stream, change permissions, trusted rejoin, kick', async () => {
    const { apollo, host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    expect(host.getState().phase).toBe('running')

    const { client, settings, moonlight } = makeClient('Вася')
    cleanups.push(() => client.cancel())
    const deviceId = settings.get().deviceId
    await client.connect('127.0.0.1')

    const req = await waitFor(() => host.getState().requests[0])
    expect(req.nickname).toBe('Вася')
    expect(client.getState().phase).toBe('waitingApproval')

    await host.respond(req.id, 'trust')
    await waitFor(() => client.getState().phase === 'streaming')
    // Хост передал условия трансляции, а задержка до хоста измеряется
    // «Авто»: одному игроку 30 Мбит/с (при 3–4 — 20).
    expect(client.getState().policy).toMatchObject({ hostAudio: true, maxBitrateKbps: 30000, hostWidth: 1920 })
    await waitFor(() => client.getState().rttMs !== undefined)
    const ac = apollo.clients[0]
    expect(ac.name).toContain('Вася')
    expect(ac.perm).toBe(toApolloPerm({ keyboard: true, mouse: true, gamepad: true }))
    await waitFor(() => host.getState().players[0]?.status === 'streaming')

    // Хост отключает клавиатуру: права в Apollo меняются, клиент получает уведомление.
    await host.setPerms(deviceId, { keyboard: false, mouse: true, gamepad: true })
    expect(apollo.clients[0].perm).toBe(toApolloPerm({ keyboard: false, mouse: true, gamepad: true }))
    await waitFor(() => client.getState().perms?.keyboard === false)

    // Клиент уходит: права снимаются, чтобы нельзя было зайти в обход Streamly.
    await client.cancel()
    await waitFor(() => host.getState().players.length === 0)
    await waitFor(() => apollo.clients[0].perm === 0)

    // Доверенный друг заходит снова без подтверждения и без повторного сопряжения, с сохранёнными правами.
    await client.connect('127.0.0.1')
    await waitFor(() => client.getState().phase === 'streaming')
    expect(host.getState().requests).toHaveLength(0)
    expect(apollo.clients).toHaveLength(1)
    expect(moonlight.pairs).toBe(1)
    expect(apollo.clients[0].perm).toBe(toApolloPerm({ keyboard: false, mouse: true, gamepad: true }))

    await host.kick(deviceId)
    await waitFor(() => client.getState().phase === 'error')
    expect(client.getState().error).toBe('kicked')
    expect(apollo.clients[0].perm).toBe(0)
    expect(apollo.clients[0].connected).toBe(false)

    // Выгнанному доверенному другу до перезапуска хоста снова нужно подтверждение.
    await client.connect('127.0.0.1')
    const again = await waitFor(() => host.getState().requests[0])
    expect(again.nickname).toBe('Вася')
    await host.respond(again.id, 'allow')
    await waitFor(() => client.getState().phase === 'streaming')
    expect(moonlight.pairs).toBe(1)
  })

  it('denied request', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const { client } = makeClient('Kate')
    cleanups.push(() => client.cancel())
    await client.connect('127.0.0.1')
    const req = await waitFor(() => host.getState().requests[0])
    await host.respond(req.id, 'deny')
    await waitFor(() => client.getState().phase === 'error')
    expect(client.getState().error).toBe('denied')
  })

  it('rejects players over the limit and intruders that bypass Streamly', async () => {
    const { apollo, host, makeClient } = setup(1)
    cleanups.push(() => host.stop())
    await host.start()
    const a = makeClient('A')
    const b = makeClient('B')
    cleanups.push(() => a.client.cancel(), () => b.client.cancel())

    await a.client.connect('127.0.0.1')
    await host.respond((await waitFor(() => host.getState().requests[0])).id, 'allow')
    await waitFor(() => a.client.getState().phase === 'streaming')

    await b.client.connect('127.0.0.1')
    await waitFor(() => b.client.getState().phase === 'error')
    expect(b.client.getState().error).toBe('host_full')

    // Кто-то сопряжён с Apollo напрямую и подключился в обход Streamly: опрос снимает права и отключает.
    apollo.clients.push({ ...apollo.clients[0], uuid: 'intruder', name: 'X', perm: 0x7000000, connected: true })
    await waitFor(() => {
      const x = apollo.clients.find((c) => c.uuid === 'intruder')
      return x && x.perm === 0 && !x.connected
    })
  })

  it('stopping the host disconnects everyone', async () => {
    const { apollo, host, makeClient } = setup()
    await host.start()
    const { client } = makeClient('Миша')
    cleanups.push(() => client.cancel())
    await client.connect('127.0.0.1')
    await host.respond((await waitFor(() => host.getState().requests[0])).id, 'allow')
    await waitFor(() => client.getState().phase === 'streaming')
    await host.stop()
    await waitFor(() => client.getState().phase === 'error')
    expect(client.getState().error).toBe('host_stopped')
    expect(apollo.clients.every((c) => c.perm === 0 && !c.connected)).toBe(true)
    expect(host.getState().phase).toBe('idle')
  })

  it('explains connection and pairing failures', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())

    // Хост не нажал «Я хост»: порт закрыт, соединение отклоняется.
    const a = makeClient('A')
    cleanups.push(() => a.client.cancel())
    await a.client.connect('127.0.0.1')
    await waitFor(() => a.client.getState().phase === 'error')
    expect(a.client.getState().error).toBe('host_not_hosting')

    await host.start()
    // Moonlight не достучался до Apollo при сопряжении (файрвол хоста).
    a.moonlight.pairUnreachable = true
    await a.client.connect('127.0.0.1')
    await host.respond((await waitFor(() => host.getState().requests[0])).id, 'allow')
    await waitFor(() => a.client.getState().phase === 'error', 8000)
    expect(a.client.getState().error).toBe('pair_no_request')
    expect(a.client.getState().errorDetail).toBe('moonlight log tail')
  }, 15000)

  it('reports a stream that never reaches the host', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const b = makeClient('B', { streamStartTimeoutMs: 400 })
    cleanups.push(() => b.client.cancel())
    b.moonlight.streamHangs = true
    await b.client.connect('127.0.0.1')
    await host.respond((await waitFor(() => host.getState().requests[0])).id, 'allow')
    await waitFor(() => b.client.getState().phase === 'error', 8000)
    expect(b.client.getState().error).toBe('stream_timeout')
  }, 15000)

  it('lets players start the stream one at a time', async () => {
    const { apollo, host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const a = makeClient('A')
    const b = makeClient('B')
    cleanups.push(() => a.client.cancel(), () => b.client.cancel())
    await a.client.connect('127.0.0.1')
    await b.client.connect('127.0.0.1')
    await waitFor(() => host.getState().requests.length === 2)
    for (const r of host.getState().requests) await host.respond(r.id, 'allow')
    await waitFor(() => a.client.getState().phase === 'streaming' && b.client.getState().phase === 'streaming', 10000)
    expect(apollo.maxLaunching).toBe(1)
  }, 15000)

  it('disconnects everyone at once and checks itself', async () => {
    const { apollo, host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const a = makeClient('A')
    const b = makeClient('B')
    cleanups.push(() => a.client.cancel(), () => b.client.cancel())
    await a.client.connect('127.0.0.1')
    await b.client.connect('127.0.0.1')
    await waitFor(() => host.getState().requests.length === 2)
    for (const r of host.getState().requests) await host.respond(r.id, 'allow')
    await waitFor(() => host.getState().players.filter((p) => p.status === 'streaming').length === 2, 10000)
    await host.kickAll()
    await waitFor(() => a.client.getState().error === 'kicked' && b.client.getState().error === 'kicked')
    expect(apollo.clients.every((c) => c.perm === 0)).toBe(true)

    const report = await host.selfCheck()
    expect(report.items.find((i) => i.id === 'hosting')?.status).toBe('ok')
    expect(report.items.find((i) => i.id === 'apolloPorts')?.status).toBe('ok')
    expect(report.summary).toBe('hostOk')
  }, 15000)

  it('keeps the connection after the stream ends: reconnect without a new approval', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const { client, moonlight } = makeClient('Оля')
    cleanups.push(() => client.cancel())
    await client.connect('127.0.0.1')
    await host.respond((await waitFor(() => host.getState().requests[0])).id, 'allow')
    await waitFor(() => client.getState().phase === 'streaming')
    // Друг закрыл окно Moonlight: стрим закончен, но он остаётся допущенным
    ;(client as unknown as { streamProc: MoonlightProcess }).streamProc.kill()
    await waitFor(() => client.getState().phase === 'ended')
    expect(host.getState().players).toHaveLength(1)
    await client.connect('127.0.0.1')
    await waitFor(() => client.getState().phase === 'streaming')
    expect(host.getState().requests).toHaveLength(0)
    expect(moonlight.pairs).toBe(1)
  }, 15000)

  it('cleans up an orphaned Apollo pairing the host forgot about', async () => {
    const { apollo, host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    // Apollo помнит старое сопряжение «Миша», а хост — нет (например, после переустановки Streamly)
    apollo.clients.push({
      name: 'Миша · Streamly-abcdef',
      uuid: 'orphan',
      display_mode: '',
      perm: 0,
      enable_legacy_ordering: true,
      allow_client_commands: true,
      always_use_virtual_display: false,
      connected: false
    })
    const { client } = makeClient('Миша')
    cleanups.push(() => client.cancel())
    await client.connect('127.0.0.1')
    await host.respond((await waitFor(() => host.getState().requests[0])).id, 'allow')
    await waitFor(() => client.getState().phase === 'streaming')
    expect(apollo.clients.some((c) => c.uuid === 'orphan')).toBe(false)
  }, 15000)

  it('runs Apollo only while hosting', async () => {
    const { host } = setup()
    service.running = false
    const starts = service.starts
    await host.start()
    expect(host.getState().phase).toBe('running')
    expect(service.starts).toBe(starts + 1)
    await host.stop()
    expect(service.running).toBe(false)
    service.running = true
  })

  it('a player turns off their own gamepad from the in-game menu', async () => {
    const { apollo, host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const { client, moonlight } = makeClient('Вася')
    cleanups.push(() => client.cancel())
    await client.connect('127.0.0.1')
    const req = await waitFor(() => host.getState().requests[0])
    await host.respond(req.id, 'allow')
    await waitFor(() => client.getState().phase === 'streaming')
    const perm = (): number => apollo.clients.find((c) => c.uuid === moonlight.uuid)!.perm

    client.setSelfOff({ gamepad: true })
    await waitFor(() => (perm() & PERM.inputController) === 0)
    const p = host.getState().players[0]
    // Хост по-прежнему разрешает геймпад, просто игрок сам его выключил.
    expect(p.perms.gamepad).toBe(true)
    expect(p.selfOff.gamepad).toBe(true)
    expect(perm() & PERM.inputKbd).toBe(PERM.inputKbd)

    client.setSelfOff({ gamepad: false })
    await waitFor(() => (perm() & PERM.inputController) !== 0)
  }, 15000)

  it('routes the sound and keeps Discord out of the stream when a player asks', async () => {
    const audio = new FakeAudio()
    const { host, makeClient } = setup(4, { audio })
    cleanups.push(() => host.stop())
    await host.start()
    // Хостинг включил маршрутизацию, но Discord пока никто не просил убрать.
    expect(audio.calls.at(-1)).toEqual({ enabled: true, monitor: true, excludeChat: false })
    expect(host.getState().audio.chatControl).toBe(true)

    const { client, settings } = makeClient('Вася')
    cleanups.push(() => client.cancel())
    await client.connect('127.0.0.1')
    const req = await waitFor(() => host.getState().requests[0])
    await host.respond(req.id, 'allow')
    await waitFor(() => client.getState().phase === 'streaming')
    // Звук идёт через виртуальные колонки: Apollo не должен оставлять его на хосте.
    expect(client.getState().policy?.hostAudio).toBe(false)
    // По умолчанию игрок просит убрать Discord.
    await waitFor(() => audio.calls.at(-1)?.excludeChat === true)
    await waitFor(() => client.getState().hostChat?.excluded === true)
    expect(host.getState().players[0].muteChat).toBe(true)

    settings.update({ stream: { muteHostChat: false } })
    client.prefsChanged()
    await waitFor(() => audio.calls.at(-1)?.excludeChat === false)
    await waitFor(() => client.getState().hostChat?.excluded === false)

    await host.stop()
    expect(audio.calls.at(-1)?.enabled).toBe(false)
  }, 15000)

  it('closes Desktop in Apollo after everyone leaves (removes the virtual monitor)', async () => {
    const { apollo, host, makeClient } = setup(4, { idleCloseMs: 150 })
    cleanups.push(() => host.stop())
    await host.start()
    const { client } = makeClient('Вася')
    cleanups.push(() => client.cancel())
    await client.connect('127.0.0.1')
    const req = await waitFor(() => host.getState().requests[0])
    await host.respond(req.id, 'allow')
    await waitFor(() => client.getState().phase === 'streaming')
    await new Promise((r) => setTimeout(r, 300))
    const closedAtStart = apollo.closed
    expect(closedAtStart).toBe(1)
    await client.cancel()
    await waitFor(() => apollo.closed > closedAtStart)
  }, 15000)

  it('restarts the stream with new quality without a new approval', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const { client, moonlight } = makeClient('Вася')
    cleanups.push(() => client.cancel())
    await client.connect('127.0.0.1')
    const req = await waitFor(() => host.getState().requests[0])
    await host.respond(req.id, 'allow')
    await waitFor(() => client.getState().phase === 'streaming')
    expect(client.restartStream()).toBe(true)
    expect(client.getState().restarting).toBe(true)
    await waitFor(() => moonlight.streams === 2 && client.getState().phase === 'streaming' && !client.getState().restarting)
    expect(host.getState().requests).toHaveLength(0)
  }, 15000)

  it('an invite link lets a friend in without approval, a wrong code does not', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const inv = host.createInvite()!
    const code = new URL(inv.link).searchParams.get('code')!
    expect(host.createInvite()!.link).toBe(inv.link)

    const a = makeClient('Вася')
    cleanups.push(() => a.client.cancel())
    await a.client.connect('127.0.0.1', { inviteCode: code })
    await waitFor(() => a.client.getState().phase === 'streaming')
    expect(host.getState().players[0].viaInvite).toBe(true)

    const b = makeClient('Петя')
    cleanups.push(() => b.client.cancel())
    await b.client.connect('127.0.0.1', { inviteCode: 'wrong-code-12345' })
    await waitFor(() => host.getState().requests.length === 1)
    expect(b.client.getState().phase).toBe('waitingApproval')
  }, 15000)

  it('a player asks for control, the host gives it or says no', async () => {
    const { apollo, host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const { client, moonlight } = makeClient('Вася')
    cleanups.push(() => client.cancel())
    await client.connect('127.0.0.1')
    const req = await waitFor(() => host.getState().requests[0])
    await host.respond(req.id, 'allow')
    await waitFor(() => client.getState().phase === 'streaming')
    const id = host.getState().players[0].deviceId
    await host.setPerms(id, { gamepad: false })
    await waitFor(() => client.getState().perms?.gamepad === false)

    client.requestInput({ gamepad: true })
    await waitFor(() => host.getState().players[0].inputRequest?.gamepad === true)
    await host.respondInput(id, false)
    await waitFor(() => client.getState().inputRequest === 'denied')
    // Повторная просьба сразу после отказа отклоняется сама.
    client.requestInput({ gamepad: true })
    expect(host.getState().players[0].inputRequest).toBeUndefined()

    await new Promise((r) => setTimeout(r, 50))
    // Хост сам выдал геймпад — просьба выполнена.
    await host.setPerms(id, { gamepad: true })
    const perm = (): number => apollo.clients.find((c) => c.uuid === moonlight.uuid)!.perm
    await waitFor(() => (perm() & PERM.inputController) !== 0)
  }, 15000)

  it('the host takes control from everyone and gives it back', async () => {
    const { apollo, host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const { client, moonlight } = makeClient('Вася')
    cleanups.push(() => client.cancel())
    await client.connect('127.0.0.1')
    const req = await waitFor(() => host.getState().requests[0])
    await host.respond(req.id, 'allow')
    await waitFor(() => client.getState().phase === 'streaming')
    const perm = (): number => apollo.clients.find((c) => c.uuid === moonlight.uuid)!.perm
    const input = PERM.inputKbd | PERM.inputMouse | PERM.inputController

    await host.setInputPaused(true)
    await waitFor(() => (perm() & input) === 0 && client.getState().inputPaused === true)
    // Опрос Apollo не возвращает права, пока пауза.
    await new Promise((r) => setTimeout(r, 200))
    expect(perm() & input).toBe(0)
    // Выданные права не меняются: после паузы всё возвращается.
    expect(host.getState().players[0].perms).toEqual({ keyboard: true, mouse: true, gamepad: true })
    await host.setInputPaused(false)
    await waitFor(() => (perm() & input) === input && client.getState().inputPaused === false)
  }, 15000)

  it('auto quality measures the channel and starts with the picked bitrate', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const { client, settings, moonlight } = makeClient('Вася')
    settings.update({ stream: { autoQuality: true } })
    cleanups.push(() => client.cancel())
    await client.connect('127.0.0.1')
    const req = await waitFor(() => host.getState().requests[0])
    await host.respond(req.id, 'allow')
    await waitFor(() => client.getState().phase === 'streaming')
    const st = client.getState()
    expect(st.speedMbps).toBeGreaterThan(0)
    expect(st.active?.auto).toBe(true)
    // Через loopback канал быстрый: упираемся в потолок хоста («Авто» для одного игрока — 30 Мбит/с).
    expect(moonlight.lastStream?.bitrateKbps).toBe(30000)
  }, 15000)

  it('applies the encoder preset tuned for RTX by default and manual settings on request', async () => {
    const { apollo, host } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    expect(apollo.patches.at(-1)).toMatchObject({ nvenc_preset: '3', nvenc_twopass: 'quarter_res', amd_usage: 'ultralowlatency', fec_percentage: '30', max_bitrate: '30000' })
  }, 15000)
})
