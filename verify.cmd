@echo off
rem ---------------------------------------------------------------------------
rem  verify.cmd - run every OFFLINE deterministic suite.
rem
rem  These suites need no Win32 sandbox, no restricted token, and no reboot, so
rem  they run in any session (including a confined one). Use them before asking
rem  anyone to re-run the in-sandbox audit.
rem
rem  NOTE: keep this file pure ASCII. cmd.exe parses batch files using the OEM
rem  code page, so non-ASCII comments get decoded as garbage and executed.
rem ---------------------------------------------------------------------------
setlocal
if "%NODE_EXE%"=="" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"
cd /d "%~dp0"
set FAIL=0
rem  The list below must match src\testrunner.mjs OFFLINE_SUITES. The fix phase added
rem  appcontainer-layout + meta-runner (they existed but verify.cmd never ran them,
rem  which made "verify is green" weaker than it looked), paths-masks and
rem  workspace-regressions (both new: mask-list/probe mapping, and the D8/D10 fixes).
rem  The wire-up phase (FIX-F) added appcontainer-runtime and probe-selfkill-guard:
rem  both existed and were green when run by hand, but neither was in this loop nor
rem  in OFFLINE_SUITES, so nothing would have noticed them breaking.
for %%S in (tests\selftest.mjs tests\e2e-flow.mjs tests\struct-layout.mjs tests\appcontainer-layout.mjs tests\paths-masks.mjs tests\workspace-regressions.mjs tests\registry-guard.mjs tests\resolve-exec.mjs tests\executor-stub.mjs tests\audit-parse.mjs tests\meta-runner.mjs tests\appcontainer-runtime.mjs tests\probe-selfkill-guard.mjs) do (
  echo === %%S ===
  "%NODE_EXE%" %%S
  if errorlevel 1 set FAIL=1
)
echo.
if "%FAIL%"=="1" (echo RESULT: FAIL) else (echo RESULT: ALL PASS)
exit /b %FAIL%
