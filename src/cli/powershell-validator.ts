import { spawnSync } from 'node:child_process'

export interface PowerShellValidationError {
  kind: 'parse' | 'binding' | 'spawn' | 'unsupported-platform'
  message: string
}

/**
 * AST-parse + parameter-bind a PowerShell script and return null when every
 * cmdlet call in the script binds against a real parameter (or unambiguous
 * prefix) on a real cmdlet — or a structured error describing the first
 * mismatch.
 *
 * Closes the `service-manager.test.ts` grep-only verification gap that let
 * `New-ScheduledTaskSettingsSet -AllowHardTerminate $true` ship in v0.5.1
 * (the cmdlet exposes no such parameter; its inverse switch is
 * `-DisallowHardTerminate`). Grep-style assertions confirm a substring is
 * present; this validator confirms PowerShell will actually accept the
 * script.
 *
 * Implementation: spawns `powershell.exe`, decodes the script back from
 * UTF-16 LE base64, runs `[Parser]::ParseInput`, walks `CommandAst` nodes,
 * resolves each via `Get-Command`, and checks every supplied parameter
 * name against the cmdlet's `Parameters.Keys`. External executables
 * (`Get-Command` returns `Application`) are skipped — their flags can't be
 * introspected and would generate false positives.
 *
 * Platform-gated: returns `unsupported-platform` on non-win32 (the cmdlets
 * we want to validate ship only with Windows). CI windows-latest matrix
 * runs the validator; ubuntu/macOS matrices skip it.
 */
export function validatePowerShellScript(script: string): PowerShellValidationError | null {
  if (process.platform !== 'win32') {
    return { kind: 'unsupported-platform', message: 'powershell.exe is only available on Windows' }
  }
  // The user's script is embedded as base64 inside the validator script so
  // we never have to worry about single-quote escaping, here-string
  // termination, or interpolation collisions. The validator script itself
  // is then UTF-16 LE base64-encoded for `-EncodedCommand` (same approach
  // service-manager.psCmd uses).
  const userScriptB64 = Buffer.from(script, 'utf16le').toString('base64')
  const validator = `$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction SilentlyContinue | Out-Null
$bytes = [Convert]::FromBase64String('${userScriptB64}')
$src = [System.Text.Encoding]::Unicode.GetString($bytes)
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$errors)
if ($errors -and $errors.Count -gt 0) {
  foreach ($e in $errors) { Write-Output ("PARSE: " + $e.Message) }
  exit 2
}
$cmds = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)
foreach ($c in $cmds) {
  $name = $c.GetCommandName()
  if (-not $name) { continue }
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) { continue }
  if ($cmd.CommandType -notin 'Cmdlet','Function') { continue }
  $valid = @($cmd.Parameters.Keys)
  foreach ($el in $c.CommandElements) {
    if ($el -isnot [System.Management.Automation.Language.CommandParameterAst]) { continue }
    $p = $el.ParameterName
    $hits = @($valid | Where-Object { $_ -like "$p*" })
    if ($hits.Count -eq 0) {
      Write-Output ("BIND: " + $name + " has no parameter -" + $p)
      exit 3
    }
  }
}
exit 0
`
  const utf16 = Buffer.from(validator, 'utf16le')
  const b64 = utf16.toString('base64')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { encoding: 'utf8', windowsHide: true })
  if (r.status === 0) return null
  if (r.error) return { kind: 'spawn', message: r.error.message }
  const output = ((r.stdout ?? '') + (r.stderr ?? '')).trim()
  if (r.status === 2) return { kind: 'parse', message: output || 'parse error' }
  if (r.status === 3) return { kind: 'binding', message: output || 'binding error' }
  return { kind: 'spawn', message: `powershell exited ${r.status}\n${output}` }
}
