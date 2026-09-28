@echo off
rem ---------------------------------------------------------------------------
rem  run.cmd - node launcher wrapper for this workspace
rem
rem  WHY THIS EXISTS:
rem  Under the DSH process sandbox (WRITE_RESTRICTED restricted token + Low
rem  integrity), PowerShell's native invocation `& node.exe ...` silently loses
rem  the child's stdout (observed: exit=0 with no output), while `cmd /c`
rem  redirection works. That is a host token behaviour, not a defect of this
rem  tool, so tests are run through this wrapper to stay reproducible.
rem
rem  NOTE: keep this file pure ASCII. cmd.exe parses batch files using the OEM
rem  code page, so UTF-8 comments (Chinese text, box-drawing characters) are
rem  decoded as garbage and executed as commands.
rem
rem  USAGE:  run.cmd <script.mjs> [args...]
rem ---------------------------------------------------------------------------
setlocal
if "%NODE_EXE%"=="" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"
"%NODE_EXE%" %*
exit /b %ERRORLEVEL%
