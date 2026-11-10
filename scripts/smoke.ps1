# Smoke test (Windows PowerShell 5.1+ / PowerShell 7): install twice, post a sample OTLP body, check the total,
# uninstall, check settings restored. Uses temp HOME / CLAUDE_CONFIG_DIR / TOKEN_LEDGER_HOME only.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Cli = Join-Path (Join-Path (Join-Path $Root 'plugin') 'bin') 'token-ledger.mjs'
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ('tl-smoke-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$HomeDir = Join-Path $Tmp 'home'
$env:HOME = $HomeDir
$env:USERPROFILE = $HomeDir
$env:CLAUDE_CONFIG_DIR = Join-Path $HomeDir '.claude'
$env:TOKEN_LEDGER_HOME = Join-Path $Tmp 'data'
$env:TOKEN_LEDGER_MANAGED_SETTINGS_DIR = Join-Path $Tmp 'managed'
if (-not $env:TOKEN_LEDGER_PORT) { $env:TOKEN_LEDGER_PORT = [string](Get-Random -Minimum 47900 -Maximum 48400) }
$Settings = Join-Path $env:CLAUDE_CONFIG_DIR 'settings.json'
$Sample = Join-Path (Join-Path $Root 'demo') 'otlp-sample.json'
if (-not (Test-Path -LiteralPath $Sample)) { $Sample = Join-Path $Root 'tests/install/fixtures/otlp-sample.json' }

function Tl { & node --no-warnings $Cli @args; if ($LASTEXITCODE -ne 0) { throw "token-ledger $($args -join ' ') exited $LASTEXITCODE" } }
function Fail([string]$m) { throw "SMOKE FAIL: $m" }
function HashOf([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash }
function Summary { (& node --no-warnings $Cli summary --json | Out-String | ConvertFrom-Json) }

$code = 0
try {
  New-Item -ItemType Directory -Force -Path $env:CLAUDE_CONFIG_DIR | Out-Null
  $json = "{`n  `"theme`": `"dark`",`n  `"env`": {`n    `"KEEP_ME`": `"1`",`n    `"OTEL_METRICS_EXPORTER`": `"none`"`n  },`n  `"statusLine`": {`n    `"type`": `"command`",`n    `"command`": `"echo mine`"`n  }`n}`n"
  [IO.File]::WriteAllText($Settings, $json, (New-Object Text.UTF8Encoding($false)))
  $OrigBytes = [IO.File]::ReadAllBytes($Settings)
  $Orig = HashOf $Settings
  $extra = @()
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { $extra = @('--skip-claude-check') }

  Write-Host '== install (1)'
  Tl install --yes --no-import @extra
  $H1 = HashOf $Settings
  if ($H1 -eq $Orig) { Fail 'install did not change settings.json' }
  $s = Get-Content -Raw -LiteralPath $Settings | ConvertFrom-Json
  if ($s.env.KEEP_ME -ne '1') { Fail 'existing env key lost' }
  if ($s.statusLine.command -ne 'echo mine') { Fail 'statusLine changed' }
  if ($s.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT -ne "http://127.0.0.1:$($env:TOKEN_LEDGER_PORT)/v1/logs") { Fail 'logs endpoint missing' }

  Write-Host '== install (2)'
  Tl install --yes --no-import @extra | Out-Null
  $H2 = HashOf $Settings
  if ($H1 -ne $H2) { Fail "second install changed settings.json ($H1 != $H2)" }
  if (@(Get-ChildItem -LiteralPath (Join-Path $env:TOKEN_LEDGER_HOME 'backups')).Count -ne 1) { Fail 'expected exactly one settings backup' }

  Write-Host '== verify'
  Tl verify

  Write-Host '== post sample OTLP logs'
  $uri = "http://127.0.0.1:$($env:TOKEN_LEDGER_PORT)/v1/logs"
  $body = [IO.File]::ReadAllBytes($Sample)
  Invoke-WebRequest -UseBasicParsing -Uri $uri -Method Post -ContentType 'application/json' -Body $body | Out-Null
  Start-Sleep -Seconds 2
  $sum = Summary
  Write-Host "status=$($sum.status) total=$($sum.total) requests=$($sum.requests)"
  if ($sum.status -ne 'ok') { Fail "summary status is $($sum.status)" }
  if ([long]$sum.total -le 0) { Fail 'total is not positive' }
  Invoke-WebRequest -UseBasicParsing -Uri $uri -Method Post -ContentType 'application/json' -Body $body | Out-Null
  Start-Sleep -Seconds 2
  $sum2 = Summary
  if ([long]$sum2.total -ne [long]$sum.total) { Fail "replay changed the total ($($sum.total) -> $($sum2.total))" }
  Tl summary

  Write-Host '== statusline wrap/unwrap'
  Tl statusline wrap | Out-Null
  $out = ('{}' | & node --no-warnings $Cli statusline render | Out-String).Trim()
  if (-not $out.StartsWith("mine $([char]0xB7) Total tracked tokens $([char]0xB7) ")) { Fail "statusline render gave: $out" }
  Tl statusline unwrap | Out-Null
  if ((HashOf $Settings) -ne $H1) { Fail 'statusline unwrap not byte-exact' }

  Write-Host '== uninstall --erase-data'
  Tl uninstall --erase-data
  if ((HashOf $Settings) -ne $Orig) { Fail 'settings.json not restored to the original bytes' }
  $now = [IO.File]::ReadAllBytes($Settings)
  if ([Convert]::ToBase64String($now) -ne [Convert]::ToBase64String($OrigBytes)) { Fail 'settings.json differs from original' }
  if (Test-Path -LiteralPath $env:TOKEN_LEDGER_HOME) { Fail 'data dir still exists' }
  Write-Host "SMOKE OK (PowerShell $($PSVersionTable.PSVersion)) total=$($sum.total)"
}
catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $code = 1
}
finally {
  try { & node --no-warnings $Cli stop *> $null } catch { }
  Remove-Item -Recurse -Force -LiteralPath $Tmp -ErrorAction SilentlyContinue
}
exit $code
