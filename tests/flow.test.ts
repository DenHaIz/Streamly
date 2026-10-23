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
import { ClientController, type ClientDeps, type MoonlightLike } from '../src/main/services/client/controller'
import type { MoonlightProcess } from '../src/main/services/moonlight/runner'
import type { StreamSettings, VpnLink } from '@shared/types'
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
    child: { pid: 4000 + Math.floor(Math.random() * 1000) } as never,
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
  /** Moonlight сам теряет связь: пишет «Connection terminated» и закрывается. */
  drop: () => void = () => undefined
  /** Строка в выводе текущего Moonlight (например, «Connection status update: 1»). */
  say: (line: string) => void = () => undefined
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
    const listeners: ((line: string) => void)[] = []
    const proc = fakeProcess(() => {
      const me = this.myClient()
      if (me) me.connected = false
    })
    proc.onLine = (cb) => listeners.push(cb)
    this.drop = () => {
      listeners.forEach((cb) => cb('Connection terminated: -1'))
      proc.kill()
    }
    this.say = (line) => listeners.forEach((cb) => cb(line))
    return proc
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

  const makeClient = (nick: string, opts: { streamStartTimeoutMs?: number; pairTimeoutMs?: number; appVersion?: string; extra?: Partial<ClientDeps> } = {}) => {
    const settings = new SettingsService(tmp(), 'ru')
    // Автоподбор (по умолчанию с 0.6.1) здесь выключен: эти проверки — о самом подключении, замер — в отдельных.
    settings.update({ nickname: nick, stream: { autoQuality: false } })
    const moonlight = new FakeMoonlight(apollo)
    const client = new ClientController({
      settings,
      secrets: new SecretsService(tmp()),
      moonlight,
      appVersion: opts.appVersion ?? '0.5.0',
      probe: async () => [],
      neighbors: async () => [],
      signalingPort: port,
      pairSettleMs: 10,
      streamStartTimeoutMs: opts.streamStartTimeoutMs,
      moonlightLog: () => 'moonlight log tail',
      ...opts.extra
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
    // «Авто»: одному игроку 20 Мбит/с, как в 0.1.
    expect(client.getState().policy).toMatchObject({ hostAudio: true, maxBitrateKbps: 20000, hostWidth: 1920 })
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

  it('keeps the sound routing on when the sound module reports while the host is starting', async () => {
    const audio = new FakeAudio()
    const { apollo, host } = setup(4, { audio })
    cleanups.push(() => host.stop())
    // Помощник присылает состояние в середине запуска: после настройки звука, но до фазы «running».
    const closeApp = apollo.closeApp.bind(apollo)
    apollo.closeApp = async () => {
      if (audio.routerState) audio.emit('router', audio.routerState)
      return closeApp()
    }
    await host.start()
    expect(host.getState().phase).toBe('running')
    expect(host.getState().audio.chatControl).toBe(true)
    await host.stop()
    expect(host.getState().audio.chatControl).toBe(false)
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
    // Новый хост: канал мерится по UDP, как идёт видео. Через loopback он быстрый — замер не упирается.
    expect(st.probe).toMatchObject({ kind: 'udp', saturated: false })
    // Через loopback канал быстрый: упираемся в потолок хоста («Авто» для одного игрока — 20 Мбит/с).
    expect(moonlight.lastStream?.bitrateKbps).toBe(20000)
    // Хост узнал, что его исходящий канал не меньше замера.
    expect((host as unknown as { uplinkLower: number }).uplinkLower).toBeGreaterThanOrEqual(30000)
    // Пинги по UDP идут: видна очередь в сети.
    await waitFor(() => client.getState().queueMs !== undefined, 4000)
  }, 15000)

  it('falls back to the TCP speed test with a host that has no UDP probe', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    // Хост версии до 0.6.1 (или порт поиска занят): в joinAccepted нет 'udpProbe'.
    ;(host as unknown as { probe: null }).probe = null
    const { client, settings } = makeClient('Вася')
    settings.update({ stream: { autoQuality: true } })
    cleanups.push(() => client.cancel())
    await joined(host, client)
    expect(client.getState().probe).toMatchObject({ kind: 'tcp' })
    expect(client.getState().speedMbps).toBeGreaterThan(0)
  }, 15000)

  it('remembers that the channel to a host had to be lowered and climbs back by 15%', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const { client, settings, moonlight } = makeClient('Вася')
    settings.update({ stream: { autoQuality: true } })
    // В прошлый раз связь с этим хостом выдержала только 12 Мбит/с: старт — на 15% выше (замер даёт 20).
    settings.rememberNet('127.0.0.1', { kbps: 12000, at: Date.now(), limited: true })
    cleanups.push(() => client.cancel())
    await joined(host, client)
    expect(moonlight.lastStream?.bitrateKbps).toBe(14000)
    // Если связь продержится, в этой же игре качество поднимется до замера.
    expect((client as unknown as { memoryLimited: boolean }).memoryLimited).toBe(true)
  }, 15000)

  it('lowers the quality when the channel gets congested, before Moonlight starts losing frames', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    // Настоящие пинги здесь не нужны: задержку подставляем сами.
    const { client, settings, moonlight } = makeClient('Вася', { extra: { pingIntervalMs: 600_000, congestionLowerGapMs: 600_000 } })
    settings.update({ stream: { autoQuality: true } })
    cleanups.push(() => client.cancel())
    await joined(host, client)
    expect(moonlight.lastStream?.bitrateKbps).toBe(20000)
    const watch = (client as unknown as { watch: { add(at: number, rtt: number | null): void } }).watch
    for (let i = 0; i < 20; i++) watch.add(performance.now() - 4000 + i * 100, 5)
    // Очередь в сети: задержка выросла на 150 мс и держится.
    const pump = setInterval(() => watch.add(performance.now(), 155), 100)
    try {
      // Очередь должна держаться 8 с: короткие всплески игру не перезапускают.
      await new Promise((r) => setTimeout(r, 5000))
      expect(moonlight.streams).toBe(1)
      await waitFor(() => moonlight.streams === 2 && client.getState().phase === 'streaming' && !client.getState().restarting, 10_000)
      // Второй раз из-за одной очереди не снижаем (она бывает и не из-за нашего потока).
      await new Promise((r) => setTimeout(r, 10_000))
      expect(moonlight.streams).toBe(2)
    } finally {
      clearInterval(pump)
    }
    expect(moonlight.lastStream?.bitrateKbps).toBe(15000)
    expect(client.getState().autoLowered).toBe(true)
    // Снижение только по очереди в память о канале не идёт (очередь бывает и не из-за канала).
    expect(settings.get().netMemory['127.0.0.1']).toBeUndefined()
  }, 40000)

  it('lowers the quality when Moonlight keeps losing frames and remembers it for this host', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const { client, settings, moonlight } = makeClient('Вася', { extra: { autoLowerAfterMs: 300 } })
    settings.update({ stream: { autoQuality: true } })
    cleanups.push(() => client.cancel())
    await joined(host, client)
    moonlight.say('00:01:02 - SDL Info (0): Connection status update: 1')
    await waitFor(() => moonlight.streams === 2 && client.getState().phase === 'streaming' && !client.getState().restarting)
    expect(moonlight.lastStream?.bitrateKbps).toBe(14000)
    expect(settings.get().netMemory['127.0.0.1']).toMatchObject({ kbps: 14000, limited: true })
  }, 15000)

  it('picks HEVC or AV1 when both graphics cards can do it', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    ;(host as unknown as { encoder: unknown }).encoder = { vendor: 'nvenc', hevc: true, av1: true }
    const decoders = async () => ({ h264: true, hevc: true, av1: true })
    const a = makeClient('Вася', { extra: { decoders } })
    cleanups.push(() => a.client.cancel())
    await joined(host, a.client)
    expect(a.moonlight.lastStream?.codec).toBe('HEVC')
    expect(a.client.getState().active?.codec).toBe('HEVC')
    // «Качество» — AV1.
    const b = makeClient('Петя', { extra: { decoders } })
    b.settings.update({ stream: { priority: 'quality' } })
    cleanups.push(() => b.client.cancel())
    await joined(host, b.client)
    expect(b.moonlight.lastStream?.codec).toBe('AV1')
    // Кодек, выбранный вручную, не трогаем.
    const c = makeClient('Коля', { extra: { decoders } })
    c.settings.update({ stream: { codec: 'H.264' } })
    cleanups.push(() => c.client.cancel())
    await joined(host, c.client)
    expect(c.moonlight.lastStream?.codec).toBe('H.264')
  }, 20000)

  it('streams over ZeroTier with 1280-byte video packets and leaves Radmin as it was', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    // Через Radmin — как в 0.6.1: размер пакета выбирает Moonlight.
    const a = makeClient('Вася', { extra: { linkKind: () => 'radmin' } })
    cleanups.push(() => a.client.cancel())
    await joined(host, a.client)
    expect(a.moonlight.lastStream?.packetSize).toBe(0)
    const z = makeClient('Петя', { extra: { linkKind: () => 'zerotier' } })
    cleanups.push(() => z.client.cancel())
    await joined(host, z.client)
    expect(z.moonlight.lastStream?.packetSize).toBe(1280)
    // Размер, выбранный вручную, не трогаем.
    const m = makeClient('Коля', { extra: { linkKind: () => 'zerotier' } })
    m.settings.update({ stream: { packetSize: 1024 } })
    cleanups.push(() => m.client.cancel())
    await joined(host, m.client)
    expect(m.moonlight.lastStream?.packetSize).toBe(1024)
  }, 20000)

  it('listens on every network address of the host and follows a network that appears later', async () => {
    let links: VpnLink[] = []
    const { host, makeClient } = setup(4, { links: () => links })
    cleanups.push(() => host.stop())
    await host.start()
    const servers = (): string[] => [...(host as unknown as { servers: Map<string, unknown> }).servers.keys()]
    expect(servers()).toEqual(['127.0.0.1'])
    // Запустили ZeroTier во время хостинга (здесь — второй адрес петли).
    links = [{ kind: 'zerotier', ip: '127.0.0.2', prefix: 8, adapterName: 'ZeroTier One [t]' }]
    await host.syncNetworks()
    expect(servers()).toEqual(['127.0.0.1', '127.0.0.2'])
    expect(host.getState().addresses).toEqual([
      { ip: '127.0.0.1', kind: 'radmin' },
      { ip: '127.0.0.2', kind: 'zerotier' }
    ])
    expect(host.createInvite()?.link).toContain('alt=127.0.0.2')
    // Друг входит через второй адрес.
    const a = makeClient('Вася')
    cleanups.push(() => a.client.cancel())
    await joined(host, a.client, 'allow', '127.0.0.2')
    expect(a.client.getState().host?.address).toBe('127.0.0.2')
    // Сеть пропала (Radmin переподключается, ZeroTier выключили): серверы не закрываем, друг остаётся в игре.
    links = []
    await host.syncNetworks()
    expect(servers()).toEqual(['127.0.0.1', '127.0.0.2'])
    expect(a.client.getState().phase).toBe('streaming')
  }, 20000)

  it('does not reopen a signaling server while the host is stopping', async () => {
    let links: VpnLink[] = []
    const { host } = setup(4, { links: () => links })
    cleanups.push(() => host.stop())
    await host.start()
    const servers = (): number => (host as unknown as { servers: Map<string, unknown> }).servers.size
    const stopping = host.stop()
    // Radmin вернул адрес, пока хост останавливается.
    links = [{ kind: 'radmin', ip: '127.0.0.2', prefix: 8, adapterName: 'Radmin VPN' }]
    await host.syncNetworks()
    await stopping
    expect(servers()).toBe(0)
    // И снова «Я хост» — без «порт занят».
    await host.start()
    expect(host.getState().phase).toBe('running')
  }, 20000)

  it('shows a host that is in both networks once, via Radmin', async () => {
    const { client } = (() => {
      const { makeClient } = setup()
      return makeClient('Вася', { extra: { linkKind: (a: string) => (a.startsWith('26.') ? 'radmin' : a.startsWith('10.') ? 'zerotier' : undefined) } })
    })()
    const up = (h: object): void => (client as unknown as { upsertHost(h: object): void }).upsertHost(h)
    up({ address: '10.147.17.4', name: 'Хост', slotsUsed: 0, maxSlots: 4, source: 'broadcast', online: true })
    expect(client.getHosts().map((h) => h.address)).toEqual(['10.147.17.4'])
    up({ address: '26.1.2.3', name: 'Хост', slotsUsed: 0, maxSlots: 4, source: 'broadcast', online: true })
    expect(client.getHosts().map((h) => h.address)).toEqual(['26.1.2.3'])
    // Другой хост в ZeroTier остаётся в списке.
    up({ address: '10.147.17.9', name: 'Петя', slotsUsed: 0, maxSlots: 4, source: 'broadcast', online: true })
    expect(client.getHosts().map((h) => h.address).sort()).toEqual(['10.147.17.9', '26.1.2.3'])
  })

  it('sets the per-player cap by the host upload: higher with a proven wide channel, lower for newcomers once it saturates', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const a = makeClient('Вася')
    const b = makeClient('Петя')
    const c = makeClient('Коля')
    for (const p of [a, b, c]) {
      p.settings.update({ stream: { bitrateKbps: 50000 } })
      cleanups.push(() => p.client.cancel())
    }
    await joined(host, a.client)
    // Замер показал исходящий канал хоста не меньше 60 Мбит/с: двоим по 18 (таблица дала бы 15).
    ;(host as unknown as { uplinkLower: number }).uplinkLower = 60000
    await joined(host, b.client)
    expect(b.client.getState().policy?.maxBitrateKbps).toBe(18000)
    await waitFor(() => host.getState().players.every((p) => p.status === 'streaming'))
    const upper = (): unknown => (host as unknown as { uplinkUpper: unknown }).uplinkUpper
    const congest = (): void => {
      for (const p of [a, b]) (p.client as unknown as { send(m: unknown): void }).send({ t: 'netCongestion', on: true })
    }
    // Проблемы у обоих, но хост отдаёт мало (10 Мбит/с при потоках на 36): это их сети, не канал хоста.
    ;(host as unknown as { upload: unknown }).upload = { bytes: 0, at: 0, mbps: 10 }
    congest()
    await new Promise((r) => setTimeout(r, 300))
    expect(upper()).toBeNull()
    // Хост отдаёт 30 Мбит/с — почти всё, что нужно двум потокам: его канал упёрся.
    ;(host as unknown as { upload: unknown }).upload = { bytes: 0, at: 0, mbps: 30 }
    congest()
    await waitFor(() => upper() !== null)
    // Играющим потолок не снижают (и не перезапускают).
    await new Promise((r) => setTimeout(r, 300))
    expect(a.client.getState().policy?.maxBitrateKbps).toBe(18000)
    // Новому игроку — осторожнее: 0,75 × 30 / 3 = 7,5, но не ниже 75% таблицы (12 → 9).
    await joined(host, c.client)
    expect(c.client.getState().policy?.maxBitrateKbps).toBe(9000)
  }, 20000)

  it('applies the Apollo default encoder preset (as in 0.1) by default', async () => {
    const { apollo, host } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    expect(apollo.patches.at(-1)).toMatchObject({ nvenc_preset: '1', nvenc_twopass: 'quarter_res', amd_usage: 'ultralowlatency', fec_percentage: '20', max_bitrate: '20000' })
  }, 15000)

  it('the host reconnects a stuck gamepad: a new client restarts the stream, an old one is dropped in Apollo', async () => {
    const { apollo, host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const a = makeClient('Вася', { appVersion: '0.4.0' })
    cleanups.push(() => a.client.cancel())
    await a.client.connect('127.0.0.1')
    const req = await waitFor(() => host.getState().requests[0])
    await host.respond(req.id, 'allow')
    await waitFor(() => a.client.getState().phase === 'streaming')
    await host.resetGamepad(host.getState().players[0].deviceId)
    await waitFor(() => a.moonlight.streams === 2 && a.client.getState().phase === 'streaming' && !a.client.getState().restarting)
    expect(host.getState().requests).toHaveLength(0)

    // Игрок со старой версией Streamly сообщение не поймёт: его сессию в Apollo просто разрываем.
    const b = makeClient('Петя', { appVersion: '0.3.0' })
    cleanups.push(() => b.client.cancel())
    await b.client.connect('127.0.0.1')
    const req2 = await waitFor(() => host.getState().requests[0])
    await host.respond(req2.id, 'allow')
    await waitFor(() => b.client.getState().phase === 'streaming')
    const petya = host.getState().players.find((p) => p.nickname === 'Петя')!
    const uuid = b.moonlight.uuid
    await host.resetGamepad(petya.deviceId)
    expect(apollo.clients.find((c) => c.uuid === uuid)?.connected).toBe(false)
  }, 15000)

  it('a player reconnects their own gamepad from the in-game menu', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const { client, moonlight } = makeClient('Вася')
    cleanups.push(() => client.cancel())
    expect(client.resetGamepad()).toBe(false)
    await client.connect('127.0.0.1')
    const req = await waitFor(() => host.getState().requests[0])
    await host.respond(req.id, 'allow')
    await waitFor(() => client.getState().phase === 'streaming')
    expect(client.resetGamepad()).toBe(true)
    await waitFor(() => moonlight.streams === 2 && client.getState().phase === 'streaming')
  }, 15000)

  it('a kicked player cannot come back with the invite link, the link changes', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const inv = host.createInvite()!
    const code = new URL(inv.link).searchParams.get('code')!
    const a = makeClient('Вася')
    cleanups.push(() => a.client.cancel())
    await a.client.connect('127.0.0.1', { inviteCode: code })
    await waitFor(() => a.client.getState().phase === 'streaming')
    await host.kick(host.getState().players[0].deviceId)
    await waitFor(() => a.client.getState().phase === 'error')
    expect(host.createInvite()!.link).not.toBe(inv.link)

    // Тот же ПК с новым устройством и старой ссылкой: только через подтверждение хоста.
    const b = makeClient('Вася2')
    cleanups.push(() => b.client.cancel())
    await b.client.connect('127.0.0.1', { inviteCode: code })
    await waitFor(() => host.getState().requests.length === 1)
    expect(b.client.getState().phase).toBe('waitingApproval')
  }, 15000)

  it('a host that accepts the connection but never answers does not hang the client', async () => {
    const { WebSocketServer } = await import('ws')
    const wss = new WebSocketServer({ port: 47_990, host: '127.0.0.1' })
    cleanups.push(() => new Promise<void>((r) => wss.close(() => r())))
    const settings = new SettingsService(tmp(), 'ru')
    const client = new ClientController({
      settings,
      secrets: new SecretsService(tmp()),
      moonlight: new FakeMoonlight(new FakeApollo()),
      appVersion: 'test',
      probe: async () => [],
      neighbors: async () => [],
      signalingPort: 47_990,
      connectTimeoutMs: 300
    })
    cleanups.push(() => client.cancel())
    await client.connect('127.0.0.1')
    await waitFor(() => client.getState().phase === 'error')
    expect(client.getState().error).toBe('host_not_hosting')
  }, 15000)

  /** Сокет игрока на стороне хоста (имитация обрыва связи). */
  const hostSocketOf = (host: HostController, nickname: string): { terminate(): void } =>
    [...(host as unknown as { peers: Map<string, { ws: { terminate(): void }; nickname: string; admitted: boolean }> }).peers.values()].find((p) => p.nickname === nickname && p.admitted)!.ws

  async function joined(host: HostController, client: ClientController, how: 'allow' | 'trust' | 'spectate' = 'allow', address = '127.0.0.1'): Promise<void> {
    await client.connect(address)
    const req = await waitFor(() => host.getState().requests[0])
    await host.respond(req.id, how)
    await waitFor(() => client.getState().phase === 'streaming')
  }

  it('a short signaling drop: the game keeps going and the player comes back without approval', async () => {
    const { apollo, host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const { client, moonlight } = makeClient('Вася')
    cleanups.push(() => client.cancel())
    await joined(host, client)
    const uuid = moonlight.uuid
    let sawLost = false
    client.on('state', (st) => (sawLost ||= st.signalLost === true))
    hostSocketOf(host, 'Вася').terminate()
    // Хост держит место, права в Apollo не снимаются.
    await waitFor(() => sawLost)
    expect(apollo.clients.find((c) => c.uuid === uuid)!.perm).not.toBe(0)
    await waitFor(() => client.getState().signalLost === false && host.getState().players[0]?.status === 'streaming', 8000)
    expect(host.getState().requests).toHaveLength(0)
    expect(moonlight.streams).toBe(1)
    expect(client.getState().phase).toBe('streaming')
  }, 20000)

  it('relaunches Moonlight that lost the connection, also during a signaling drop', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const { client, moonlight } = makeClient('Вася')
    cleanups.push(() => client.cancel())
    await joined(host, client)
    // Moonlight потерял связь и закрылся, а хост на связи: запускается снова, без нового одобрения.
    moonlight.drop()
    await waitFor(() => moonlight.streams === 2 && client.getState().phase === 'streaming' && !client.getState().reconnecting, 8000)
    // То же, когда одновременно оборвалось сигнальное соединение: запуск — после возвращения к хосту.
    let dropped = false
    client.on('state', (st) => {
      if (st.signalLost && !dropped) {
        dropped = true
        moonlight.drop()
      }
    })
    hostSocketOf(host, 'Вася').terminate()
    await waitFor(() => dropped)
    await waitFor(() => moonlight.streams === 3 && client.getState().phase === 'streaming' && !client.getState().signalLost, 10000)
    expect(host.getState().requests).toHaveLength(0)
  }, 25000)

  it('the held place is released if the player does not come back', async () => {
    const { apollo, host, makeClient } = setup(4, { resumeGraceMs: 300 })
    cleanups.push(() => host.stop())
    await host.start()
    const { client, moonlight } = makeClient('Вася', { extra: { resumeWindowMs: 100 } })
    cleanups.push(() => client.cancel())
    await joined(host, client)
    // Клиент не сможет вернуться: токен потерян.
    ;(client as unknown as { resume: null }).resume = null
    hostSocketOf(host, 'Вася').terminate()
    await waitFor(() => host.getState().players.length === 0, 5000)
    await waitFor(() => apollo.clients.find((c) => c.uuid === moonlight.uuid)!.perm === 0)
  }, 15000)

  it('lets a friend in as a spectator and passes control between players', async () => {
    const { apollo, host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const a = makeClient('Вася')
    cleanups.push(() => a.client.cancel())
    await joined(host, a.client, 'spectate')
    const permA = (): number => apollo.clients.find((c) => c.uuid === a.moonlight.uuid)!.perm
    expect(permA() & (PERM.inputKbd | PERM.inputMouse | PERM.inputController)).toBe(0)
    expect(a.client.getState().perms).toEqual({ keyboard: false, mouse: false, gamepad: false })

    const b = makeClient('Петя')
    cleanups.push(() => b.client.cancel())
    await joined(host, b.client)
    const permB = (): number => apollo.clients.find((c) => c.uuid === b.moonlight.uuid)!.perm
    const vasya = host.getState().players.find((p) => p.nickname === 'Вася')!
    await host.passControl(vasya.deviceId)
    const input = PERM.inputKbd | PERM.inputMouse | PERM.inputController
    expect(permA() & input).toBe(input)
    expect(permB() & input).toBe(0)
    await waitFor(() => b.client.getState().perms?.gamepad === false && a.client.getState().perms?.gamepad === true)
    // Зритель обратно: права по умолчанию.
    const petya = host.getState().players.find((p) => p.nickname === 'Петя')!
    await host.setSpectator(petya.deviceId, false)
    expect(permB() & input).toBe(input)
  }, 15000)

  it('rebalances the bitrate cap when more players join', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const players = ['Вася', 'Петя', 'Коля'].map((n) => makeClient(n))
    for (const p of players) {
      // Битрейт выше любого потолка: действует потолок хоста.
      p.settings.update({ stream: { bitrateKbps: 50000 } })
      cleanups.push(() => p.client.cancel())
    }
    await joined(host, players[0].client)
    expect(players[0].client.getState().active?.bitrateKbps).toBe(20000)
    // Второй игрок: потолок 15 Мбит/с, но ради 20 → 15 трансляцию первому не перезапускаем.
    await joined(host, players[1].client)
    await waitFor(() => players[0].client.getState().policy?.maxBitrateKbps === 15000)
    await new Promise((r) => setTimeout(r, 300))
    expect(players[0].moonlight.streams).toBe(1)
    expect(players[1].client.getState().active?.bitrateKbps).toBe(15000)
    // Третий: 12 Мбит/с. Первый (20 Мбит/с) перезапускается, второму (15) хватает запаса.
    await joined(host, players[2].client)
    await waitFor(() => players[0].client.getState().capLowered === 12000)
    await waitFor(() => players[0].client.getState().active?.bitrateKbps === 12000 && players[0].client.getState().phase === 'streaming', 8000)
    expect(players[0].moonlight.streams).toBe(2)
    expect(players[1].moonlight.streams).toBe(1)
    expect(players[2].moonlight.streams).toBe(1)
  }, 25000)

  it('tells players their gamepad numbers and finds a gamepad by a button press', async () => {
    const slots = [
      { index: 0, connected: true, active: false },
      { index: 1, connected: false, active: false },
      { index: 2, connected: false, active: false },
      { index: 3, connected: false, active: false }
    ]
    const { host, makeClient } = setup(4, { xinput: async () => slots.map((x) => ({ ...x })) })
    cleanups.push(() => host.stop())
    await host.start()
    const { client } = makeClient('Вася')
    cleanups.push(() => client.cancel())
    await joined(host, client)
    // Apollo создал виртуальный геймпад игрока во втором слоте (первый — свой у хоста).
    slots[1].connected = true
    await waitFor(() => host.getState().players[0]?.padSlot === 2)
    await waitFor(() => client.getState().pads?.find((p) => p.you)?.slot === 2)

    client.identifyPad()
    expect(client.getState().padIdentify).toBe('waiting')
    slots[2].connected = true
    await new Promise((r) => setTimeout(r, 300))
    slots[2].active = true
    await waitFor(() => client.getState().padIdentify === 'done')
    await waitFor(() => host.getState().players[0]?.padSlot === 3)
  }, 15000)

  it('restarts a stream whose Moonlight window stopped responding', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    let hung = false
    const { client, moonlight } = makeClient('Вася', { extra: { isHung: async () => hung, hungCheckMs: 40 } })
    cleanups.push(() => client.cancel())
    await joined(host, client)
    hung = true
    await waitFor(() => moonlight.streams === 2)
    hung = false
    await waitFor(() => client.getState().phase === 'streaming' && !client.getState().reconnecting)
  }, 15000)

  it('measures the channel gently while someone else is playing', async () => {
    const { host, makeClient } = setup()
    cleanups.push(() => host.stop())
    await host.start()
    const a = makeClient('Вася')
    cleanups.push(() => a.client.cancel())
    await joined(host, a.client)
    const b = makeClient('Петя')
    b.settings.update({ stream: { autoQuality: true } })
    cleanups.push(() => b.client.cancel())
    await joined(host, b.client)
    expect(b.client.getState().speedMbps).toBeGreaterThan(0)
  }, 15000)

  it('kicking everyone also releases a place held after a drop', async () => {
    const { apollo, host, makeClient } = setup(4, { resumeGraceMs: 10_000 })
    cleanups.push(() => host.stop())
    await host.start()
    const { client, moonlight } = makeClient('Вася', { extra: { resumeWindowMs: 100 } })
    cleanups.push(() => client.cancel())
    await joined(host, client)
    ;(client as unknown as { resume: null }).resume = null
    hostSocketOf(host, 'Вася').terminate()
    await waitFor(() => host.getState().players[0]?.status === 'reconnecting')
    expect(apollo.clients.find((c) => c.uuid === moonlight.uuid)!.perm).not.toBe(0)
    await host.kickAll()
    expect(host.getState().players).toHaveLength(0)
    expect(apollo.clients.find((c) => c.uuid === moonlight.uuid)!.perm).toBe(0)
  }, 15000)
})
