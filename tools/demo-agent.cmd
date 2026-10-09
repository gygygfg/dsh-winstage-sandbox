@echo off
rem demo-agent.cmd - a tiny stand-in for "the AI's work", used to prove the
rem sandbox audit: it reads/writes/deletes files and reads/writes registry keys.
rem Run it UNDER the shim (winstage-inject.exe) so the operations are hooked and
rem land in the WINSTAGE_AUDIT_LOG. Keep this file pure ASCII (README R11).
setlocal
set "W=C:\ebk\agent-work"
mkdir "%W%" 2>nul
echo seed > "%W%\seed.txt"
type "%W%\seed.txt"
echo hello > "%W%\a.txt"
type "%W%\a.txt"
copy /Y "%W%\a.txt" "%W%\b.txt" >nul
del "%W%\seed.txt"
type C:\Windows\win.ini >nul
reg add HKCU\Software\WSTest /v K /d V /f
reg query HKCU\Software\WSTest /v K
reg add HKCU\Software\WSTest /v K2 /d V2 /f
reg delete HKCU\Software\WSTest /v K /f
reg delete HKCU\Software\WSTest /f
endlocal
