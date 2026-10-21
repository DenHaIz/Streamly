import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DISCOVERY_PORT, SIGNALING_PORT } from '@shared/protocol'
import { run, runElevatedScript, type ElevatedResult } from '../../elevate'

export const APOLLO_SERVICE = 'ApolloService'
export const FIREWALL_RULE = 'Streamly'

// Выполняется с правами администратора. Переменные $Installer, $ExpectedHash, $Program, $InstallApollo,
// $Firewall, $StartService и $ResultFile подставляет runElevatedScript.
export const SETUP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$steps = @()
$ok = $true
$err = $null
try {
  if ($InstallApollo) {
    # Копия в %SystemRoot%\Temp: обычный пользователь не сможет подменить файл между проверкой и запуском.
    $copy = Join-Path (Join-Path $env:SystemRoot 'Temp') ('streamly-apollo-' + [guid]::NewGuid().ToString('N') + '.exe')
    Copy-Item -LiteralPath $Installer -Destination $copy
    try {
      if ($ExpectedHash) {
        $actual = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash
        if ($actual -ne $ExpectedHash) { throw "Apollo installer hash mismatch: $actual" }
      }
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
  if ($StartService) {
    Set-Service -Name '${APOLLO_SERVICE}' -StartupType Automatic
    Start-Service -Name '${APOLLO_SERVICE}'
    $steps += 'service'
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
}

async function serviceState(name: string): Promise<'missing' | 'running' | 'stopped'> {
  const res = await run('sc.exe', ['query', name])
  if (res.code !== 0) return 'missing'
  return /RUNNING/.test(res.stdout) ? 'running' : 'stopped'
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
    const [svc, vigem, sunshine, fw] = await Promise.all([
      serviceState(APOLLO_SERVICE),
      serviceState('ViGEmBus'),
      serviceState('SunshineService'),
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', FIREWALL_QUERY])
    ])
    const exe = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Apollo', 'sunshine.exe')
    return {
      installed: svc !== 'missing' || existsSync(exe),
      running: svc === 'running',
      firewall: hasProgram(fw.stdout, this.programPath),
      gamepadDriver: vigem !== 'missing',
      sunshineRunning: sunshine === 'running'
    }
  }

  /** Делает всё, что требует прав администратора, за одно окно UAC. */
  async setup(opts: { installApollo: boolean; firewall: boolean; startService: boolean }): Promise<ElevatedResult> {
    if (!opts.installApollo && !opts.firewall && !opts.startService) return { ok: true }
    return runElevatedScript(SETUP_SCRIPT, {
      Installer: this.bundledInstaller,
      ExpectedHash: (this.expectedHash ?? '').toUpperCase(),
      Program: this.programPath,
      InstallApollo: opts.installApollo,
      Firewall: opts.firewall,
      StartService: opts.startService
    })
  }
}

function hasProgram(output: string, program: string): boolean {
  const want = program.toLowerCase()
  return output.split(/\r?\n/).some((line) => line.trim().toLowerCase() === want)
}
