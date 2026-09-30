@echo off
rem ASCII only. Prints why the win32-process binding table cannot be loaded.
setlocal
if "%NODE_EXE%"=="" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"
cd /d "%~dp0"
"%NODE_EXE%" tests\diag-bindings.mjs
exit /b %ERRORLEVEL%
