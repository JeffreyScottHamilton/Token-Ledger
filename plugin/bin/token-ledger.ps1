# Claude Token Ledger CLI wrapper (Windows PowerShell 5.1+ and PowerShell 7). Requires Node.js 22.13 or newer.
$ErrorActionPreference = 'Stop'
$node = $null
if ($env:TOKEN_LEDGER_NODE -and (Test-Path -LiteralPath $env:TOKEN_LEDGER_NODE)) { $node = $env:TOKEN_LEDGER_NODE }
if (-not $node) {
  $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { $node = $cmd.Source }
}
if (-not $node) {
  [Console]::Error.WriteLine('token-ledger: Node.js 22.13 or newer is required but was not found.')
  if ($IsWindows -or $env:OS -eq 'Windows_NT') { [Console]::Error.WriteLine('Install it with: winget install OpenJS.NodeJS.LTS   then open a new terminal.') }
  elseif ($IsMacOS) { [Console]::Error.WriteLine('Install it with: brew install node') }
  else { [Console]::Error.WriteLine('Install it with nvm (nvm install --lts) or your package manager (Node 22+).') }
  exit 3
}
$cli = Join-Path $PSScriptRoot 'token-ledger.mjs'
& $node --no-warnings $cli @args
exit $LASTEXITCODE
