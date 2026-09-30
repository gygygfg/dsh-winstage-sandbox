@echo off
rem ---------------------------------------------------------------------------
rem  autotest.cmd - one-command test runner for WinStageSandbox.
rem
rem  Runs every suite and writes a machine-readable report to .t\test-report.json
rem  Exit code: 0 = no failures, 1 = failures, 2 = environment error.
rem
rem  WHY A .cmd WRAPPER INSTEAD OF CALLING node DIRECTLY:
rem  Under the DSH process sandbox (WRITE_RESTRICTED restricted token), a direct
rem  native invocation from PowerShell can silently lose the child's stdout.
rem  Launching through cmd with file redirection is reliable.
rem
rem  NOTE: keep this file pure ASCII. cmd.exe parses batch files using the OEM
rem  code page, so non-ASCII comments get decoded as garbage and executed.
rem
rem  USAGE:
rem    autotest.cmd                 run everything
rem    autotest.cmd --skip-audit    offline suites only
rem    autotest.cmd --verbose       print full output for failing suites
rem    autotest.cmd --help
rem ---------------------------------------------------------------------------
setlocal
if "%NODE_EXE%"=="" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"
cd /d "%~dp0"
"%NODE_EXE%" autotest.mjs %*
exit /b %ERRORLEVEL%
