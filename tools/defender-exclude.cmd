@echo off
rem ---------------------------------------------------------------------------
rem  defender-exclude.cmd - P0-1 helper: stop Windows Defender from quarantining
rem  the shim toolchain (winstage-inject.exe and friends).
rem
rem  Why this exists, and why a human must run it on the host:
rem    * Defender's ML heuristic (Trojan:Win32/Bearfoos.A!ml) flags unsigned
rem      process-injection binaries and quarantines winstage-inject.exe.
rem    * Every tool then reports ENOENT for every run and the product verdict is
rem      false; see the P0-1 / P0-2 discussion in the delivery doc under docs/.
rem    * The exclusion is LOCAL MACHINE STATE (registry). It cannot be committed,
rem      needs Administrator, and must be re-applied on each machine.
rem    * The durable fix is CODE SIGNING (the owner's certificate), not this.
rem
rem  This script self-elevates (one UAC prompt) and adds:
rem    * an ExclusionPath  for this repository, and
rem    * an ExclusionProcess for winstage-inject.exe.
rem
rem  Usage (from an ordinary prompt):   tools\defender-exclude.cmd
rem  Revert:
rem    powershell -Command "Remove-MpPreference -ExclusionPath '<repo>'"
rem    powershell -Command "Remove-MpPreference -ExclusionProcess 'winstage-inject.exe'"
rem
rem  Keep this file pure ASCII: cmd.exe parses batch files with the OEM code page
rem  (README residual boundary R11), so non-ASCII comments get executed as garbage.
rem ---------------------------------------------------------------------------
setlocal
for %%I in ("%~dp0..") do set "REPO=%%~fI"
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=%REPO%"

rem --- self-elevate: Add-MpPreference requires Administrator ---
net session >nul 2>&1
if errorlevel 1 (
  echo [defender-exclude] requesting administrator privileges ^(UAC^)...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%TARGET%' -Verb RunAs"
  exit /b 0
)

echo [defender-exclude] adding Defender exclusions for:
echo     path    : %TARGET%
echo     process : winstage-inject.exe
powershell -NoProfile -Command "Add-MpPreference -ExclusionPath '%TARGET%' -ErrorAction Stop; Add-MpPreference -ExclusionProcess 'winstage-inject.exe' -ErrorAction SilentlyContinue; Write-Output 'ExclusionPath:'; (Get-MpPreference).ExclusionPath; Write-Output 'ExclusionProcess:'; (Get-MpPreference).ExclusionProcess"
echo.
echo [defender-exclude] done. Rebuild and re-check, then quantify with:
echo     node tools\build-shim.mjs
echo     node tools\carrier-flake.mjs 200
echo.
pause
