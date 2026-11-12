@echo off
rem Claude Token Ledger CLI wrapper (cmd.exe). Requires Node.js 22.13 or newer on PATH.
setlocal
set "TL_NODE=node"
if defined TOKEN_LEDGER_NODE set "TL_NODE=%TOKEN_LEDGER_NODE%"
where /q "%TL_NODE%" 2>nul
if errorlevel 1 if not exist "%TL_NODE%" (
  echo token-ledger: Node.js 22.13 or newer is required but was not found. 1>&2
  echo Install it with: winget install OpenJS.NodeJS.LTS   then open a new terminal. 1>&2
  exit /b 3
)
"%TL_NODE%" --no-warnings "%~dp0token-ledger.mjs" %*
exit /b %ERRORLEVEL%
