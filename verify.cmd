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
rem  This is documented residual boundary R11 in the Windows feature list
rem  document, section 13 (that .md file is UTF-8; this .cmd must not be).
rem ---------------------------------------------------------------------------
setlocal
if "%NODE_EXE%"=="" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"
cd /d "%~dp0"
rem  Seal-hatch guard: this file runs the WHOLE gate, so it must never inherit the
rem  dev-only "unsealed" escape hatch. tests\baseline-integrity.mjs honours
rem  WINSTAGE_ALLOW_UNSEALED=1 (or --allow-unsealed) by printing
rem  "RESULT: SKIP manifest-unsealed-allowed" and exiting 0. That is correct for a
rem  human running that one suite by hand, but if the gate inherited it, moving
rem  the source baseline manifest (docs\source baseline, SHA-256 list) away would
rem  still end in "RESULT: ALL PASS" - the gate's final line is its authority, so
rem  the seal could be silently disabled in that configuration.
rem  Clearing it here covers every child process of this run; src\testrunner.mjs
rem  deletes the same key for every suite it spawns (autotest.mjs and the HTTP
rem  test service included). Keep this file pure ASCII (residual boundary R11).
set "WINSTAGE_ALLOW_UNSEALED="
set FAIL=0
rem  The list below must match src\testrunner.mjs OFFLINE_SUITES **id for id, in
rem  the same order and with the same count** (tests\suite-wiring.mjs enforces
rem  this mechanically; before that guard existed the two lists had silently
rem  drifted in order). History, so nobody re-introduces the same defect:
rem    - fix phase: added appcontainer-layout + meta-runner (they existed but
rem      verify.cmd never ran them, which made "verify is green" weaker than it
rem      looked), plus paths-masks and workspace-regressions (both new).
rem    - FIX-C: registry-guard existed and was green by hand, but was in neither
rem      list, so nothing would have noticed it breaking.
rem    - FIX-F: appcontainer-runtime + probe-selfkill-guard, same story.
rem    - this round: netpolicy / mitigations / limits / integration-wiring
rem      (three new offline capabilities plus the wiring acceptance suite) and
rem      wfp-layout (pre-existing, offline by its own header, never registered).
rem  Also added: the two governance suites suite-wiring + residual-baseline,
rem  which turn "the registry drifted" and "a residual boundary disappeared"
rem  into hard failures instead of something a human has to remember.
rem  Latest round (C3): policy-never-consistency - the machine guard for the
rem  approval-policy (ask -> never) user-visible surface: an explicit
rem  defaultPreset in the active profile (missing => the composer access-mode
rem  control disappears entirely), a static narrowest sandboxMode, a
rem  policy-independent slot takeover, no platform approval seam, and an audit
rem  mirror that never fabricates an approval decision.
rem  This round: baseline-integrity + dsh-patch-guard.
rem    - tests\baseline-integrity.mjs: the .gitignore ignores tests/ and tools/
rem      is untracked, so "comments only, no behaviour change" had no baseline
rem      to check against. docs\source baseline manifest (Chinese file name,
rem      docs\<U+6E90><U+7801><U+57FA><U+7EBF>.sha256) is now a hard gate.
rem    - tests\dsh-patch-guard.mjs: DSH is an npx cache install tree, so a hand
rem      edit is silently lost on reinstall/upgrade. The guard requires the
rem      installed file hash to be exactly before or after, else RED.
rem  Both are offline (no subprocess, no network, no admin) and are registered
rem  in src\testrunner.mjs OFFLINE_SUITES in this exact order.
rem  NOTE: tests\integration-wiring.mjs is created by a parallel agent; if it is
rem  still absent, this loop WILL fail - that is the honest outcome, not a
rem  reason to drop it from the list.
rem  Latest round (fix-3): boundary-degraded-failclosed - defect 3 (a single T0 run
rem  left an AppContainer package-SID ACE on the staged root, which permanently
rem  broke T1 staging writes while exec still ran the command and returned 0).
rem  Section A is pure/deterministic; section B injects one ACE into a scratch
rem  workspace under .t\ and always removes it again.
rem  This round (finisher): whiteout-candidate-capture - defect 1b (a shim whiteout
rem  marker under <staged>\wo\... used to be reported as a bogus `wo\...` create
rem  while a deletion of a never-staged real file produced NO delta at all, i.e.
rem  "deleted 0 items"). The suite was promoted verbatim from
rem  .t\shim-delete\test-whiteout-capture.mjs and needs no shim and no sandbox.
rem  This round (fix-2): assembly-toggle-selftest - the shell half of the sandbox was
rem  gated on the process env var WINSTAGE_SHELL, so the second instance never mounted
rem  winstage-shell and its ctx.shell stayed the platform one: no shim, hence no
rem  registry overlay and registry writes survived only as a kernel denial. The gate
rem  is now the profile switch. The suite pins the two `disabled: !!js` expressions in
rem  dsh-plugin\cordis.patch.yml as exact mutual inverses across env x profile, and
rem  also pins the YAML shape (a scalar starting with `!` is parsed as a second tag
rem  and skips the whole bundle patch).
for %%S in (tests\selftest.mjs tests\e2e-flow.mjs tests\struct-layout.mjs tests\appcontainer-layout.mjs tests\resolve-exec.mjs tests\executor-stub.mjs tests\audit-parse.mjs tests\paths-masks.mjs tests\registry-guard.mjs tests\workspace-regressions.mjs tests\meta-runner.mjs tests\appcontainer-runtime.mjs tests\probe-selfkill-guard.mjs tests\netpolicy.mjs tests\mitigations.mjs tests\limits.mjs tests\integration-wiring.mjs tests\wfp-layout.mjs tests\suite-wiring.mjs tests\residual-baseline.mjs tests\policy-never-consistency.mjs tests\baseline-integrity.mjs tests\dsh-patch-guard.mjs tests\boundary-degraded-failclosed.mjs tests\whiteout-candidate-capture.mjs tests\assembly-toggle-selftest.mjs tests\session-enclosure-selftest.mjs tests\sandbox-audit.mjs tests\environment-gate.mjs) do (
  echo === %%S ===
  "%NODE_EXE%" %%S
  if errorlevel 1 set FAIL=1
)
echo.
if "%FAIL%"=="1" (echo RESULT: FAIL) else (echo RESULT: ALL PASS)
exit /b %FAIL%
