@echo off
rem ---------------------------------------------------------------------------
rem  testservice.cmd - start the WinStageSandbox test service.
rem
rem  The service listens on loopback only and REQUIRES a bearer token:
rem  it executes the project's test suites on request, so an unauthenticated
rem  listener would be a local code-execution entry point (boundaries R13-R16).
rem
rem  Usage:
rem    testservice.cmd                       default 127.0.0.1:8737, random token
rem    testservice.cmd --port 8800
rem    testservice.cmd --port 8800 --token mytoken
rem    testservice.cmd --once                run one /run request then exit
rem
rem  NOTE: keep this file pure ASCII (cmd.exe parses batch files in the OEM
rem  code page; non-ASCII comments get decoded as garbage and executed).
rem ---------------------------------------------------------------------------
setlocal
if "%NODE_EXE%"=="" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"
cd /d "%~dp0"
"%NODE_EXE%" src\testservice.mjs %*
exit /b %ERRORLEVEL%
