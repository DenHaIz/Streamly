import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ElevatedResult {
  ok: boolean
  cancelled?: boolean
  error?: string
  steps?: string[]
}

/** Строка в одинарных кавычках PowerShell (внутри '' — экранированная кавычка). */
export const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`

export function run(file: string, args: string[], timeoutMs = 15000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number(err.code) : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

const encode = (script: string): string => Buffer.from(script, 'utf16le').toString('base64')

/** Код выхода внешнего PowerShell, когда пользователь отказался в окне UAC (ERROR_CANCELLED). */
const UAC_CANCELLED = 1223

/**
 * Запускает PowerShell-скрипт с правами администратора (одно окно UAC).
 * Скрипт передаётся целиком через -EncodedCommand, а не файлом во временной папке:
 * его нельзя подменить между записью и подтверждением UAC.
 * Параметры подставляются как переменные PowerShell в начало скрипта. В переменной $ResultFile
 * скрипт должен записать JSON вида { ok, error?, steps? }.
 */
export async function runElevatedScript(
  script: string,
  params: Record<string, string | boolean>,
  timeoutMs = 10 * 60_000
): Promise<ElevatedResult> {
  const resultPath = join(tmpdir(), `streamly-${randomUUID()}.json`)
  const header = Object.entries({ ...params, ResultFile: resultPath })
    .map(([k, v]) => `$${k} = ${typeof v === 'boolean' ? (v ? '$true' : '$false') : psQuote(v)}`)
    .join('\n')
  const inner = encode(`$ProgressPreference = 'SilentlyContinue'\n${header}\n${script}`)

  const outer =
    `$ProgressPreference = 'SilentlyContinue'; ` +
    `try { $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden ` +
    `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${inner}'); exit $p.ExitCode } ` +
    `catch { if ($_.Exception.NativeErrorCode -eq ${UAC_CANCELLED} -or $_.Exception.HResult -eq -2147023673) { exit ${UAC_CANCELLED} }; ` +
    `[Console]::Error.WriteLine($_.Exception.Message); exit 2 }`

  try {
    const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(outer)], timeoutMs)
    if (res.code === UAC_CANCELLED) return { ok: false, cancelled: true }
    if (res.code === 3) return { ok: false, error: 'result path is a reparse point' }
    try {
      const text = readFileSync(resultPath, 'utf8').replace(/^﻿/, '')
      return JSON.parse(text) as ElevatedResult
    } catch {
      return { ok: false, error: res.stderr.trim() || `exit ${res.code}` }
    }
  } finally {
    rmSync(resultPath, { force: true })
  }
}
