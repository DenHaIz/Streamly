import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { newer, notesToText, UpdateService, type UpdaterBackend } from '../src/main/services/update/updater'
import { sanitizeNickname, versionAtLeast } from '@shared/protocol'
import { buildStreamArgs } from '../src/main/services/moonlight/runner'
import { normalizeSettings } from '../src/main/settings'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

/** Подделка electron-updater: события отдаём сами. */
class FakeBackend extends EventEmitter implements UpdaterBackend {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  allowDowngrade = true
  checks = 0
  downloads = 0
  installed: [boolean?, boolean?] | null = null
  next: 'available' | 'none' | 'error' = 'available'
  async checkForUpdates(): Promise<unknown> {
    this.checks++
    if (this.next === 'error') throw new Error('net::ERR_INTERNET_DISCONNECTED')
    if (this.next === 'available') this.emit('update-available', { version: '0.5.0', releaseNotes: '<h3>Что нового</h3><ul><li><strong>Обновление</strong> &amp; звук</li></ul>' })
    else this.emit('update-not-available', {})
    return null
  }
  async downloadUpdate(): Promise<unknown> {
    this.downloads++
    this.emit('download-progress', { percent: 42.7, bytesPerSecond: 1e7 })
    this.emit('update-downloaded', { version: '0.5.0' })
    return []
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installed = [isSilent, isForceRunAfter]
  }
}

const service = (b: FakeBackend, cleanup: string[] = []) =>
  new UpdateService({
    backend: b,
    currentVersion: '0.4.0',
    autoCheck: () => true,
    skipped: () => '',
    beforeInstall: async () => void cleanup.push('cleanup')
  })

describe('updates', () => {
  it('never downloads or installs on its own', () => {
    const b = new FakeBackend()
    service(b)
    expect(b.autoDownload).toBe(false)
    expect(b.autoInstallOnAppQuit).toBe(false)
    expect(b.allowPrerelease).toBe(false)
    expect(b.allowDowngrade).toBe(false)
  })

  it('check → download → install, cleanup before installing', async () => {
    const b = new FakeBackend()
    const steps: string[] = []
    const u = service(b, steps)
    const st = await u.check()
    expect(st.status).toBe('available')
    expect(st.version).toBe('0.5.0')
    expect(st.notes).toContain('• Обновление & звук')
    expect(u.offered).toBe('0.5.0')
    await u.download()
    expect(u.getState().status).toBe('ready')
    // Скачал сам пользователь: если не нажмёт «Перезапустить», поставится при выходе.
    expect(b.autoInstallOnAppQuit).toBe(true)
    await u.install()
    expect(steps).toEqual(['cleanup'])
    expect(b.installed).toEqual([true, true])
  })

  it('a background check stays quiet on errors, a manual one explains them', async () => {
    const b = new FakeBackend()
    b.next = 'error'
    const u = service(b)
    expect((await u.check(false)).status).toBe('idle')
    expect((await u.check(true)).status).toBe('error')
    expect(u.getState().error).toBe('network')
    b.next = 'none'
    expect((await u.check(true)).status).toBe('latest')
  })

  it('without the updater (dev build) reports unsupported', async () => {
    const u = new UpdateService({ backend: null, currentVersion: '0.4.0', autoCheck: () => true, skipped: () => '', beforeInstall: async () => undefined })
    expect((await u.check()).status).toBe('unsupported')
  })

  it('compares versions and cleans release notes', () => {
    expect(newer('0.10.0', '0.9.9')).toBe(true)
    expect(newer('0.4.0', '0.4.0')).toBe(false)
    expect(versionAtLeast('0.4.1', '0.4.0')).toBe(true)
    expect(versionAtLeast('0.3.0', '0.4.0')).toBe(false)
    expect(versionAtLeast(undefined, '0.4.0')).toBe(false)
    expect(notesToText('<p>a&nbsp;b</p><p>c</p>')).toBe('a b\nc')
    expect(notesToText('')).toBeUndefined()
  })
})

describe('0.4 details', () => {
  it('strips invisible and bidi characters from nicknames', () => {
    expect(sanitizeNickname('Ва\u200bся\u202e')).toBe('Вася')
    expect(sanitizeNickname('\u2066\u2069')).toBe('Player')
  })

  it('"all gamepads as one" turns off multi-controller in Moonlight', () => {
    const s = { ...DEFAULT_SETTINGS.stream, singleGamepad: true }
    expect(buildStreamArgs('26.0.0.1', s)).toContain('--no-multi-controller')
    expect(buildStreamArgs('26.0.0.1', { ...s, singleGamepad: false })).toContain('--multi-controller')
  })

  it('new settings get defaults and are validated', () => {
    const old = { ...structuredClone(DEFAULT_SETTINGS), language: 'ru', nickname: 'A', deviceId: '00000000-0000-4000-8000-000000000000' } as Partial<Settings>
    delete old.updates
    delete old.showAdvanced
    const n = normalizeSettings(old as Settings)
    expect(n.updates).toEqual({ auto: true, skipped: '' })
    expect(n.showAdvanced).toBe(false)
    expect(n.host.requestSound).toBe(true)
    const bad = normalizeSettings({ ...n, updates: { auto: 'yes' as never, skipped: '<script>' } })
    expect(bad.updates).toEqual({ auto: true, skipped: '' })
  })
})

describe('0.5: hotkeys and logs', () => {
  it('validates hotkeys and reads them from key presses', async () => {
    const { isAccelerator, acceleratorFromEvent } = await import('@shared/hotkeys')
    for (const ok of ['Alt+F2', 'Ctrl+Shift+F2', 'F13', 'Ctrl+A', 'Alt+`', '']) expect(isAccelerator(ok)).toBe(true)
    for (const bad of ['F2', 'Shift+A', 'Alt+Alt+F2', 'Win+F2', 'Alt+F4', 'Ctrl+F25', 'A']) expect(isAccelerator(bad)).toBe(false)
    const ev = { ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }
    expect(acceleratorFromEvent({ ...ev, code: 'F2' })).toBe('Ctrl+Shift+F2')
    expect(acceleratorFromEvent({ ...ev, code: 'KeyQ' })).toBe('Ctrl+Shift+Q')
    expect(acceleratorFromEvent({ ...ev, code: 'ShiftLeft' })).toBeNull()
    const n = normalizeSettings({ ...normalizeSettings({} as Settings), hotkeys: { clientMenu: 'F2', hostMenu: 'Ctrl+F9' } as never })
    expect(n.hotkeys.clientMenu).toBe('Alt+F2')
    expect(n.hotkeys.hostMenu).toBe('Ctrl+F9')
  })

  it('keeps the log for 14 days and packs it into a zip', async () => {
    const { mkdtempSync, utimesSync, writeFileSync, existsSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { DailyLog, makeZip, crc32, writeLogArchive } = await import('../src/main/logger')
    const dir = mkdtempSync(join(tmpdir(), 'streamly-log-'))
    const old = join(dir, 'streamly-2020-01-01.log')
    writeFileSync(old, 'old')
    const past = new Date(Date.now() - 15 * 24 * 3600_000)
    utimesSync(old, past, past)
    const log = new DailyLog(dir)
    expect(existsSync(old)).toBe(false)
    log.write('hello')
    log.write('world')
    expect(log.tail(5)).toBe('hello\nworld')
    expect(crc32(Buffer.from('hello'))).toBe(0x3610a686)
    const zip = makeZip([{ name: 'a.txt', data: Buffer.from('hello') }])
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50)
    const target = join(dir, 'out.zip')
    await writeLogArchive(target, log, [{ name: 'report.txt', data: Buffer.from('report') }])
    const packed = readFileSync(target)
    // Две записи в центральном каталоге: журнал за сегодня и отчёт.
    expect(packed.readUInt16LE(packed.length - 22 + 10)).toBe(2)
  })
})
