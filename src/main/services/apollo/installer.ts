import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DISCOVERY_PORT, SIGNALING_PORT } from '@shared/protocol'
import { run, runElevatedScript, type ElevatedResult } from '../../elevate'

export const APOLLO_SERVICE = 'ApolloService'
export const FIREWALL_RULE = 'Streamly'
/** ACE для службы Apollo: прошедшие проверку пользователи могут запускать, останавливать и опрашивать её. */
export const SERVICE_ACE = '(A;;RPWPLCLO;;;AU)'

// Выполняется с правами администратора. Переменные $Installer, $ExpectedHash, $Program, $InstallApollo,
// $Firewall, $StartService, $InstallGamepad, $ServiceControl и $ResultFile подставляет runElevatedScript.
export const SETUP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
# Результат пишем только в обычный файл: ссылка или точка соединения на этом месте — повод остановиться.
$resultDir = Split-Path -LiteralPath $ResultFile
foreach ($p in @($resultDir, $ResultFile)) {
  $it = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
  if ($it -and ($it.Attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 3 }
}
$steps = @()
$ok = $true
$err = $null
try {
  if ($InstallApollo) {
    # Копия в %SystemRoot%\Temp: обычный пользователь не сможет подменить файл между проверкой и запуском.
    $copy = Join-Path (Join-Path $env:SystemRoot 'Temp') ('streamly-apollo-' + [guid]::NewGuid().ToString('N') + '.exe')
    Copy-Item -LiteralPath $Installer -Destination $copy
    try {
      # Без закреплённого хэша установщик не запускаем.
      if (-not $ExpectedHash) { throw 'Apollo installer hash is not pinned (vendor.lock.json)' }
      $actual = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash
      if ($actual -ne $ExpectedHash) { throw "Apollo installer hash mismatch: $actual" }
      $p = Start-Process -FilePath $copy -ArgumentList '/S' -Wait -PassThru
      $steps += "install:$($p.ExitCode)"
      if ($p.ExitCode -ne 0) { throw "Apollo installer exited with code $($p.ExitCode)" }
    } finally {
      Remove-Item -LiteralPath $copy -Force -ErrorAction SilentlyContinue
    }
  }
  if ($Firewall) {
    Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    # Только порты Streamly и только из сети Radmin (и локальной подсети для отладки).
    $remote = @('26.0.0.0/8', 'LocalSubnet')
    New-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -Direction Inbound -Action Allow -Program $Program -Protocol TCP -LocalPort ${SIGNALING_PORT} -RemoteAddress $remote -Profile Any | Out-Null
    New-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -Direction Inbound -Action Allow -Program $Program -Protocol UDP -LocalPort ${DISCOVERY_PORT} -RemoteAddress $remote -Profile Any | Out-Null
    $steps += 'firewall'
  }
  if ($ServiceControl) {
    # Apollo запускается только пока включён режим хоста: ручной запуск службы, и Streamly
    # (обычный пользователь) получает право запускать и останавливать её без UAC.
    & sc.exe config '${APOLLO_SERVICE}' start= demand | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc config failed: $LASTEXITCODE" }
    $sd = ((& sc.exe sdshow '${APOLLO_SERVICE}') -join '').Trim()
    if ($sd -notlike '*${SERVICE_ACE}*') {
      if ($sd -like '*S:*') { $sd = $sd.Replace('S:', '${SERVICE_ACE}S:') } else { $sd = $sd + '${SERVICE_ACE}' }
      & sc.exe sdset '${APOLLO_SERVICE}' $sd | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "sc sdset failed: $LASTEXITCODE" }
    }
    $steps += 'serviceControl'
  }
  if ($StartService) {
    Start-Service -Name '${APOLLO_SERVICE}'
    $steps += 'service'
  }
  if ($InstallGamepad) {
    # Родной скрипт Apollo ставит ViGEmBus из своего комплекта. Лежит в Program Files — менять его может только админ.
    $gp = Join-Path $env:ProgramFiles 'Apollo\scripts\install-gamepad.ps1'
    if (-not (Test-Path -LiteralPath $gp)) { throw "Apollo gamepad installer not found: $gp" }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $gp
    if ($LASTEXITCODE -ne 0) { throw "install-gamepad.ps1 exited with code $LASTEXITCODE" }
    if (-not (Get-Service -Name 'ViGEmBus' -ErrorAction SilentlyContinue)) { throw 'ViGEmBus service is still missing after install' }
    $steps += 'gamepad'
  }
} catch {
  $ok = $false
  $err = $_.ToString()
}
@{ ok = $ok; error = $err; steps = $steps } | ConvertTo-Json | Set-Content -Encoding UTF8 -Path $ResultFile
`

// Вывод в UTF-8, чтобы корректно сравнить путь с кириллицей (имя пользователя Windows).
const FIREWALL_QUERY =
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
  `(Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue | Get-NetFirewallApplicationFilter).Program`

export interface ApolloInstallStatus {
  installed: boolean
  running: boolean
  firewall: boolean
  gamepadDriver: boolean
  /** Запущен оригинальный Sunshine: он занимает те же порты. */
  sunshineRunning: boolean
  /** Служба Apollo с ручным запуском и правом управления для пользователя (Streamly включает её только на время хостинга). */
  serviceControl: boolean
  /** Версия установленного Apollo (из свойств sunshine.exe), если удалось прочитать. */
  version?: string
}

async function serviceState(name: string): Promise<'missing' | 'running' | 'stopped'> {
  const s = await serviceDetail(name)
  return s === 'missing' || s === 'running' ? s : 'stopped'
}

/** Состояние службы с переходными: sc stop возвращается, пока служба ещё останавливается. */
async function serviceDetail(name: string): Promise<'missing' | 'running' | 'stopped' | 'pending'> {
  const res = await run('sc.exe', ['query', name])
  if (res.code !== 0) return 'missing'
  if (/_PENDING/.test(res.stdout)) return 'pending'
  return /RUNNING/.test(res.stdout) ? 'running' : 'stopped'
}

/** Ждёт, пока служба придёт в нужное состояние (не дольше timeoutMs). */
async function waitService(name: string, want: 'running' | 'stopped', timeoutMs = 10_000): Promise<boolean> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const s = await serviceDetail(name)
    if (s === want) return true
    if (s === 'missing' || Date.now() > until) return false
    await new Promise((r) => setTimeout(r, 400))
  }
}

export interface SetupOptions {
  installApollo: boolean
  firewall: boolean
  startService: boolean
  installGamepad?: boolean
  serviceControl?: boolean
}

/** Определение и установка Apollo (хост-сервер) и правила файрвола для Streamly. */
export class ApolloInstaller {
  constructor(
    private readonly bundledInstaller: string,
    private readonly programPath: string,
    /** SHA-256 установщика из vendor.lock.json: сверяется уже под правами администратора. */
    private readonly expectedHash?: string
  ) {}

  get hasBundledInstaller(): boolean {
    return existsSync(this.bundledInstaller)
  }

  async status(): Promise<ApolloInstallStatus> {
    const exe = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Apollo', 'sunshine.exe')
    const [svc, vigem, sunshine, fw, qc, sd, ver] = await Promise.all([
      serviceState(APOLLO_SERVICE),
      serviceState('ViGEmBus'),
      serviceState('SunshineService'),
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', FIREWALL_QUERY]),
      run('sc.exe', ['qc', APOLLO_SERVICE]),
      run('sc.exe', ['sdshow', APOLLO_SERVICE]),
      existsSync(exe)
        ? run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`])
        : Promise.resolve({ code: 1, stdout: '', stderr: '' })
    ])
    // START_TYPE 3 = DEMAND_START (ручной запуск).
    const manual = /START_TYPE\s*:\s*3\b/.test(qc.stdout)
    const version = /\d+\.\d+\.\d+/.exec(ver.stdout)?.[0]
    return {
      installed: svc !== 'missing' || existsSync(exe),
      running: svc === 'running',
      firewall: hasProgram(fw.stdout, this.programPath),
      gamepadDriver: vigem !== 'missing',
      sunshineRunning: sunshine === 'running',
      serviceControl: svc !== 'missing' && manual && sd.stdout.includes(SERVICE_ACE),
      version
    }
  }

  /** Делает всё, что требует прав администратора, за одно окно UAC. */
  /** Запуск службы Apollo без прав администратора (после настройки serviceControl). */
  async startService(): Promise<boolean> {
    // Хост только что остановили и сразу включили снова: служба ещё останавливается, sc start не сработает.
    if ((await serviceDetail(APOLLO_SERVICE)) === 'pending') await waitService(APOLLO_SERVICE, 'stopped')
    const r = await run('sc.exe', ['start', APOLLO_SERVICE])
    // 1056 — служба уже запущена.
    if (r.code !== 0 && r.code !== 1056) return (await serviceState(APOLLO_SERVICE)) === 'running'
    return waitService(APOLLO_SERVICE, 'running')
  }

  /** Остановка службы Apollo, когда режим хоста выключен. */
  async stopService(): Promise<boolean> {
    const r = await run('sc.exe', ['stop', APOLLO_SERVICE])
    // 1062 — служба и так остановлена.
    if (r.code === 1062) return true
    return r.code === 0 && (await waitService(APOLLO_SERVICE, 'stopped'))
  }

  async setup(opts: SetupOptions): Promise<ElevatedResult> {
    if (!opts.installApollo && !opts.firewall && !opts.startService && !opts.installGamepad && !opts.serviceControl) return { ok: true }
    // Без закреплённого хэша не ставим (проверка дублируется и внутри скрипта).
    if (opts.installApollo && !this.expectedHash) return { ok: false, error: 'Apollo installer hash is not pinned (vendor.lock.json)' }
    return runElevatedScript(SETUP_SCRIPT, {
      Installer: this.bundledInstaller,
      ExpectedHash: (this.expectedHash ?? '').toUpperCase(),
      Program: this.programPath,
      InstallApollo: opts.installApollo,
      Firewall: opts.firewall,
      StartService: opts.startService,
      InstallGamepad: !!opts.installGamepad,
      ServiceControl: !!opts.serviceControl
    })
  }
}

function hasProgram(output: string, program: string): boolean {
  const want = program.toLowerCase()
  return output.split(/\r?\n/).some((line) => line.trim().toLowerCase() === want)
}
