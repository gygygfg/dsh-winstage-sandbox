@echo off
rem ============================================================================
rem  sbx-thread.cmd -- start ONE fresh DSH thread with the WinStage sandbox
rem  loaded, run a single task, and land every raw artifact under <outDir>.
rem
rem  USAGE
rem    sbx-thread.cmd <workspaceDir> <promptFile> <outDir> [winstage|platform]
rem
rem  ARGS
rem    workspaceDir  directory the nested thread works in. It becomes BOTH the
rem                  process cwd and the WinStage workspaceRoot (via
rem                  WINSTAGE_SBX_WORKSPACE) and the platform fs/shell root.
rem    promptFile    UTF-8 text file with the task; fed on stdin (no quoting).
rem    outDir        evidence directory (created if missing).
rem    mode          optional, default "winstage":
rem                    winstage -> WINSTAGE_SHELL=1 (force WinStage takeover)
rem                    platform -> WINSTAGE_SHELL=0 (force platform tools)
rem
rem  OUTPUT (all under <outDir>, manifest-style evidence, no bulk copies)
rem    meta.txt                 timestamp, args, env, mode, resolved paths
rem    stdout.ndjson            raw --json run events from the nested thread
rem    stderr.txt               raw stderr (loader warnings live here)
rem    exitcode.txt             dsh exit code
rem    session-id.txt           session id parsed out of the events
rem    stage-root-path.txt      the pinned WINSTAGE_STAGE_ROOT for this run
rem    lane.txt                 sandbox-lane.json verdict; LANE_OK=true means
rem                             degraded===false AND tierEffective==='TS'.
rem                             This is the ONLY proof the TS lane really ran:
rem                             staging keeps working while the lane silently
rem                             degrades to T1 (measured 2026-10-08, task-9).
rem    stage-root-inventory.txt path + size + sha256[0:12] of every staged file
rem    stage-root-meta.txt      manifest.json / review.json / queue.json excerpts
rem    workspace-inventory.txt  path + size + sha256[0:12] of the REAL workspace
rem
rem  WHY THE STAGE ROOT IS PINNED
rem    Without WINSTAGE_STAGE_ROOT the plugin keys the stage root by session id
rem    and falls back to the CONSTANT "dsh-host" (review-service.mjs:229,
rem    DEFAULT_REVIEW_SESSION_ID). Any other live WinStage host on the machine
rem    (e.g. the 3080 web host) already holds the guard on
rem    %LOCALAPPDATA%\Temp\winstage-stage\dsh-host, so a second host fail-closes
rem    with StageGuardUnavailableError and winstage-fs never activates.
rem    Pinning a unique root per run is the supported escape hatch
rem    (src/stage-guard.mjs:214-217). The pinned root lives OUTSIDE the cache
rem    base, so no keeper is attached and the staged tree survives the run --
rem    which is exactly what makes manifest-style evidence possible.
rem
rem  PITFALLS BAKED IN (all measured; see docs/round10/env/00-...md)
rem    * dsh is a .cmd shim: it MUST be invoked with `call`, otherwise control
rem      never returns and no evidence after the run is ever written.
rem    * an inherited WINSTAGE_SHELL from the calling session must be
rem      overridden explicitly, never "defaulted to".
rem    * an inherited DSH_SESSION_ID must be cleared, or the nested host aliases
rem      the caller's stage key.
rem
rem  Pure ASCII on purpose (cmd.exe / any code page).
rem ============================================================================
setlocal EnableExtensions EnableDelayedExpansion

set "WS=%~f1"
set "PROMPTFILE=%~f2"
set "OUT=%~f3"
set "MODE=%~4"
if "%WS%"=="" goto :usage
if "%PROMPTFILE%"=="" goto :usage
if "%OUT%"=="" goto :usage
if "%MODE%"=="" set "MODE=winstage"
if not exist "%WS%" ( echo [sbx-thread] workspaceDir not found: %WS% & exit /b 2 )
if not exist "%PROMPTFILE%" ( echo [sbx-thread] promptFile not found: %PROMPTFILE% & exit /b 2 )

if "%DSH_HOME%"=="" set "DSH_HOME=%USERPROFILE%\.dsh"
set "PROFILE=sbx"
set "STAGE_BASE=%LOCALAPPDATA%\Temp\winstage-stage"
set "INHERITED_WINSTAGE_SHELL=%WINSTAGE_SHELL%"
set "INHERITED_SESSION_ID=%DSH_SESSION_ID%"

if /i "%MODE%"=="platform" (set "WINSTAGE_SHELL=0") else (set "WINSTAGE_SHELL=1")

if not exist "%OUT%" mkdir "%OUT%" >nul 2>&1

rem ---- pinned, per-run stage root (never collides, survives the run) --------
set "STAGE_ROOT=%OUT%\stage-root-%RANDOM%%RANDOM%%RANDOM%"
if not "%SBX_STAGE_ROOT%"=="" set "STAGE_ROOT=%SBX_STAGE_ROOT%"
set "WINSTAGE_STAGE_ROOT=%STAGE_ROOT%"
> "%OUT%\stage-root-path.txt" echo %STAGE_ROOT%
> "%OUT%\workspace-path.txt" echo %WS%

rem ---- optional --patch overlay (e.g. scripts\overlay-ask.yml) -------------
set "PATCHARG="
if not "%SBX_PATCH%"=="" set PATCHARG=--patch "%SBX_PATCH%"

rem ---- inherited identity must not leak into the nested host ---------------
set "DSH_SESSION_ID="
set "WINSTAGE_SBX_WORKSPACE=%WS%"

rem ---- meta ----------------------------------------------------------------
> "%OUT%\meta.txt" echo started_at=%DATE% %TIME%
>> "%OUT%\meta.txt" echo mode=%MODE%
>> "%OUT%\meta.txt" echo workspace=%WS%
>> "%OUT%\meta.txt" echo prompt_file=%PROMPTFILE%
>> "%OUT%\meta.txt" echo out_dir=%OUT%
>> "%OUT%\meta.txt" echo DSH_HOME=%DSH_HOME%
>> "%OUT%\meta.txt" echo DSH_PROFILE=%PROFILE%
>> "%OUT%\meta.txt" echo WINSTAGE_SHELL=%WINSTAGE_SHELL%
>> "%OUT%\meta.txt" echo inherited_WINSTAGE_SHELL=%INHERITED_WINSTAGE_SHELL%
>> "%OUT%\meta.txt" echo inherited_DSH_SESSION_ID=%INHERITED_SESSION_ID%
>> "%OUT%\meta.txt" echo WINSTAGE_SBX_WORKSPACE=%WS%
>> "%OUT%\meta.txt" echo WINSTAGE_STAGE_ROOT=%STAGE_ROOT%
>> "%OUT%\meta.txt" echo cache_stage_base=%STAGE_BASE%
>> "%OUT%\meta.txt" echo SBX_PATCH=%SBX_PATCH%
>> "%OUT%\meta.txt" echo cmd=dsh --profile %PROFILE% %PATCHARG% --json -

if exist "%STAGE_BASE%" ( dir /b /ad "%STAGE_BASE%" > "%OUT%\cache-base-before.txt" ) else ( > "%OUT%\cache-base-before.txt" echo ^(cache stage base absent^) )

rem ---- run the nested thread ----------------------------------------------
cd /d "%WS%"
call dsh --profile %PROFILE% %PATCHARG% --json - < "%PROMPTFILE%" > "%OUT%\stdout.ndjson" 2> "%OUT%\stderr.txt"
set "RC=!ERRORLEVEL!"
> "%OUT%\exitcode.txt" echo !RC!

if exist "%STAGE_BASE%" ( dir /b /ad "%STAGE_BASE%" > "%OUT%\cache-base-after.txt" ) else ( > "%OUT%\cache-base-after.txt" echo ^(cache stage base absent^) )

node "%~dp0sbx-extract.mjs" "%OUT%"

echo [sbx-thread] mode=%MODE% exit=!RC! out=%OUT%
exit /b !RC!

:usage
echo usage: sbx-thread.cmd ^<workspaceDir^> ^<promptFile^> ^<outDir^> [winstage^|platform]
exit /b 2
