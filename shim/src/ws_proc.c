/* WinStageSandbox -- T4 shim: process-creation hooks + child self-injection.
 *
 * WHY THIS EXISTS (defect ① second half, measured):
 * The shim is a user-mode IAT patch: it only covers the process the DLL was
 * loaded into. `run.cmd ... --tier TS -- cmd /c <script>.cmd` injects **cmd.exe**
 * and nothing else, so every process the script starts (`powershell.exe`,
 * `node.exe`, ...) ran completely unhooked: measured in the shim log, only the
 * cmd.exe PID ever initialized, and `node -e "fs.writeFileSync(<real path>)"` /
 * `powershell Set-Content <real path>` created REAL files on the host disk
 * (shim/out/../.t/shim-delete/raw/diag-child.txt). Every delete form that runs in
 * such a child therefore bypassed the staging layer by construction, no matter
 * which file API it used.
 *
 * Fix: CreateProcess* are hook targets too (measured callers: cmd.exe's
 * `CreateProcessW` for `powershell.exe` and `node.exe`, IAT hits in cmd.exe,
 * ucrtbase, msvcrt, sechost). The wrapper forces CREATE_SUSPENDED on the child,
 * remote-injects this very DLL (the same CreateProcess(SUSPENDED) +
 * LoadLibraryW transport `winstage-inject.exe` uses), and resumes the child only
 * if the caller did not ask for a suspended process.
 *
 * Fail-closed, like every other hook here: if the child cannot be injected, the
 * child is terminated, CreateProcess* fails with ERROR_ACCESS_DENIED and nothing
 * runs unhooked. That is the only honest option -- a child we cannot inject WILL
 * write straight through to the real system (see the measurement above).
 */
#include "winstage_internal.h"

static wchar_t g_selfDll[WS_PATH_MAX];
static int g_selfDllOk;
/* defect 4: was a non-reentrant `volatile LONG g_procLock`. */
static WsLock g_procLock = { 0, 0, 0, "proc" };
static long g_injectCount;
static long g_injectFail;

/* defect 3: the remote LoadLibraryW wait used to be a hard 30 s. A stuck child
 * then froze the *calling* process (the carrier) for 30 s, which the outside
 * world only saw as "hangs". Injection normally takes well under 100 ms; the
 * default is deliberately far below 30 s but far above 100 ms, because a cold
 * cache / an AV scanner reading the just-loaded DLL can legitimately take a
 * second. Override with WINSTAGE_INJECT_WAIT_MS (50..60000) when bisecting. */
#define WS_INJECT_WAIT_DEFAULT_MS 2000

static DWORD ws_inject_wait_ms(void)
{
    static volatile LONG cached = -1;
    LONG c = cached;
    if (c >= 0) {
        return (DWORD)c;
    }
    DWORD ms = WS_INJECT_WAIT_DEFAULT_MS;
    wchar_t buf[32];
    DWORD n = GetEnvironmentVariableW(L"WINSTAGE_INJECT_WAIT_MS", buf, 32);
    if (n > 0 && n < 32) {
        long v = 0;
        int ok = 1;
        for (DWORD i = 0; i < n; i++) {
            if (buf[i] < L'0' || buf[i] > L'9') { ok = 0; break; }
            v = v * 10 + (buf[i] - L'0');
            if (v > 60000) { ok = 0; break; }
        }
        if (ok && v >= 50) {
            ms = (DWORD)v;
        }
    }
    InterlockedExchange(&cached, (LONG)ms);
    return ms;
}

/* Called from ws_hook_init() once the self module is known. */
void ws_proc_set_self_module(HMODULE self)
{
    if (!self) {
        return;
    }
    DWORD n = GetModuleFileNameW(self, g_selfDll, WS_PATH_MAX);
    g_selfDllOk = (n > 0 && n < WS_PATH_MAX);
    ws_log("child injection armed: self=%ls ok=%d", g_selfDllOk ? g_selfDll : L"(unknown)", g_selfDllOk);
}

/* ---------------------------------------------------------- env contract */

/* The shim's DllMain auto-initializes from WINSTAGE_STAGE_ROOT /
 * WINSTAGE_SHIM_CONFIG / WINSTAGE_SHIM_LOG. When the caller passes an explicit
 * environment block those variables are NOT necessarily in it, and an injected
 * child whose shim loads inert is worse than no injection at all (it would look
 * hooked while writing through). Rebuild the block with the three contract
 * variables overridden/added. Returns a HeapAlloc'd block (caller frees) or NULL
 * on failure (the caller then fails the CreateProcess* fail-closed). */
static wchar_t *ws_env_with_contract(const wchar_t *env)
{
    static const wchar_t *names[3] = { L"WINSTAGE_STAGE_ROOT", L"WINSTAGE_SHIM_LOG", L"WINSTAGE_SHIM_CONFIG" };
    const wchar_t *values[3] = { g_ws.stageRoot, g_ws.logPath, g_ws.configPath };
    size_t total = 1;
    for (const wchar_t *p = env; p && *p; p += wcslen(p) + 1) {
        int skip = 0;
        for (int i = 0; i < 3; i++) {
            size_t nl = wcslen(names[i]);
            if (_wcsnicmp(p, names[i], nl) == 0 && p[nl] == L'=') {
                skip = 1;
                break;
            }
        }
        if (!skip) {
            total += wcslen(p) + 1;
        }
    }
    for (int i = 0; i < 3; i++) {
        if (values[i] && values[i][0]) {
            total += wcslen(names[i]) + 1 + wcslen(values[i]) + 1;
        }
    }
    wchar_t *block = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, total * sizeof(wchar_t));
    if (!block) {
        return NULL;
    }
    size_t used = 0;
    for (const wchar_t *p = env; p && *p; p += wcslen(p) + 1) {
        int skip = 0;
        for (int i = 0; i < 3; i++) {
            size_t nl = wcslen(names[i]);
            if (_wcsnicmp(p, names[i], nl) == 0 && p[nl] == L'=') {
                skip = 1;
                break;
            }
        }
        if (skip) {
            continue;
        }
        size_t len = wcslen(p);
        memcpy(block + used, p, (len + 1) * sizeof(wchar_t));
        used += len + 1;
    }
    for (int i = 0; i < 3; i++) {
        if (!values[i] || !values[i][0]) {
            continue;
        }
        size_t nl = wcslen(names[i]);
        memcpy(block + used, names[i], nl * sizeof(wchar_t));
        used += nl;
        block[used++] = L'=';
        size_t vl = wcslen(values[i]);
        memcpy(block + used, values[i], vl * sizeof(wchar_t));
        used += vl;
        block[used++] = L'\0';
    }
    block[used] = L'\0';
    return block;
}

/* -------------------------------------------------------------- injection */

static int ws_inject_into(HANDLE hProcess)
{
    if (!g_selfDllOk) {
        SetLastError(ERROR_MOD_NOT_FOUND);
        return 0;
    }
    SIZE_T bytes = (wcslen(g_selfDll) + 1) * sizeof(wchar_t);
    void *mem = VirtualAllocEx(hProcess, NULL, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!mem) {
        return 0;
    }
    int ok = 0;
    if (WriteProcessMemory(hProcess, mem, g_selfDll, bytes, NULL)) {
        /* kernel32!LoadLibraryW is at the same address in both processes: system
         * DLLs are relocated once per boot, not once per process (the same
         * assumption winstage-inject.exe already relies on). */
        FARPROC loadLibraryW = (FARPROC)g_orig.LoadLibraryW;
        if (!loadLibraryW) {
            loadLibraryW = (FARPROC)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW");
        }
        if (loadLibraryW) {
            HANDLE th = CreateRemoteThread(hProcess, NULL, 0, (LPTHREAD_START_ROUTINE)loadLibraryW, mem, 0, NULL);
            if (th) {
                /* defect 3: bounded wait. On timeout the caller terminates the
                 * (still suspended / half-initialised) child and fails closed
                 * with ERROR_DLL_INIT_FAILED, instead of freezing the parent. */
                DWORD waitMs = ws_inject_wait_ms();
                ws_stuck_enter("inject:remote-LoadLibraryW");
                DWORD wait = WaitForSingleObject(th, waitMs);
                ws_stuck_leave();
                DWORD moduleResult = 0;
                GetExitCodeThread(th, &moduleResult);
                CloseHandle(th);
                /* moduleResult == 0 means LoadLibraryW returned NULL in the child
                 * (e.g. a 32-bit child: an x64 DLL cannot be mapped there). */
                ok = (wait == WAIT_OBJECT_0 && moduleResult != 0);
                if (wait == WAIT_TIMEOUT) {
                    ws_log("STUCK remote LoadLibraryW did not complete within %lu ms (pid=%lu); failing closed",
                           (unsigned long)waitMs, (unsigned long)GetProcessId(hProcess));
                }
                if (!ok) {
                    SetLastError(ERROR_DLL_INIT_FAILED);
                }
            }
        }
    }
    VirtualFreeEx(hProcess, mem, 0, MEM_RELEASE);
    return ok;
}

static BOOL ws_create_process_common(HANDLE token, int hasToken, LPCWSTR app, LPWSTR cmd,
                                     LPSECURITY_ATTRIBUTES pa, LPSECURITY_ATTRIBUTES ta, BOOL inherit,
                                     DWORD flags, LPVOID env, LPCWSTR cwd, LPSTARTUPINFOW si,
                                     LPPROCESS_INFORMATION pi)
{
    /* ★ WP13（C1）：本函数旧实现会在**成功路径**把调用线程的 last error 硬清成 0
     * （原 `:208` 豁免分支与 `:235` 正常分支），而中途的 `HeapFree` / `ws_log` /
     * `ResumeThread` 也会覆写它。对照真实 API 语义：
     *   · `CreateProcessW` **成功时不改** last error ⇒ 钩子也应"不改"：还原入口值；
     *   · **失败时**必须把**真实 API 刚给出的错误**交给调用方（不是入口值）；
     *   · 转发分支（`!pi`）原样放行，**不还原**；
     *   · `ERROR_NOT_ENOUGH_MEMORY`（环境构造失败）是**本函数自己**的错误，刻意保留。
     * 入口保存必须是第一条语句，后面的还原点才有意义。 */
    DWORD ws_saved_last_error = GetLastError();
    WS_STUCK("CreateProcess");
    if (app || cmd) {
        ws_stuck_path(app ? app : cmd);
    }
    if (!pi) {
        return hasToken ? g_orig.CreateProcessAsUserW(token, app, cmd, pa, ta, inherit, flags, env, cwd, si, pi)
                        : g_orig.CreateProcessW(app, cmd, pa, ta, inherit, flags, env, cwd, si, pi);
    }
    /* Debug/protected creations cannot be injected safely (the debugger owns the
     * first event) and must not be broken, so they pass through with a log. */
    int exempt = (flags & (DEBUG_PROCESS | DEBUG_ONLY_THIS_PROCESS | CREATE_PROTECTED_PROCESS)) != 0;
    int forced = 0;
    DWORD newFlags = flags;
    if (!exempt && !(flags & CREATE_SUSPENDED)) {
        newFlags = flags | CREATE_SUSPENDED;
        forced = 1;
    }
    wchar_t *newEnv = NULL;
    if (!exempt && env) {
        newEnv = ws_env_with_contract((const wchar_t *)env);
        if (!newEnv) {
            /* 自己的错误：保留（不要被下面的还原点抹掉） */
            SetLastError(ERROR_NOT_ENOUGH_MEMORY);
            return FALSE;
        }
    }
    BOOL ok = hasToken
                  ? g_orig.CreateProcessAsUserW(token, app, cmd, pa, ta, inherit, newFlags,
                                                newEnv ? newEnv : env, cwd, si, pi)
                  : g_orig.CreateProcessW(app, cmd, pa, ta, inherit, newFlags,
                                          newEnv ? newEnv : env, cwd, si, pi);
    /* 立刻取走真实 API 的错误：下面还有 HeapFree/日志，它们都会覆写线程状态 */
    DWORD createErr = GetLastError();
    if (newEnv) {
        HeapFree(GetProcessHeap(), 0, newEnv);
    }
    if (!ok) {
        SetLastError(createErr);
        return FALSE;
    }
    if (exempt) {
        ws_log("child created WITHOUT injection (debug/protected creation, flags=0x%lx)", (unsigned long)flags);
        SetLastError(ws_saved_last_error);
        return TRUE;
    }
    if (!ws_inject_into(pi->hProcess)) {
        DWORD err = GetLastError();
        ws_lock_enter(&g_procLock);
        g_injectFail++;
        ws_lock_leave(&g_procLock);
        ws_log("fail-closed CreateProcess: cannot inject the shim into the child (win32=%lu); "
               "the child was terminated rather than left unhooked", (unsigned long)err);
        TerminateProcess(pi->hProcess, (UINT)-1);
        CloseHandle(pi->hThread);
        CloseHandle(pi->hProcess);
        memset(pi, 0, sizeof(*pi));
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    ws_lock_enter(&g_procLock);
    g_injectCount++;
    ws_lock_leave(&g_procLock);
    if (g_ws.verbose) {
        ws_log("child injected (pid=%lu) app=%ls", (unsigned long)pi->dwProcessId,
               app ? app : (cmd ? cmd : L"(null)"));
    }
    if (forced) {
        ResumeThread(pi->hThread);
    }
    SetLastError(ws_saved_last_error);
    return TRUE;
}

BOOL WINAPI ws_CreateProcessW(LPCWSTR app, LPWSTR cmd, LPSECURITY_ATTRIBUTES pa, LPSECURITY_ATTRIBUTES ta,
                              BOOL inherit, DWORD flags, LPVOID env, LPCWSTR cwd,
                              LPSTARTUPINFOW si, LPPROCESS_INFORMATION pi)
{
    return ws_create_process_common(NULL, 0, app, cmd, pa, ta, inherit, flags, env, cwd, si, pi);
}

BOOL WINAPI ws_CreateProcessAsUserW(HANDLE token, LPCWSTR app, LPWSTR cmd, LPSECURITY_ATTRIBUTES pa,
                                    LPSECURITY_ATTRIBUTES ta, BOOL inherit, DWORD flags, LPVOID env,
                                    LPCWSTR cwd, LPSTARTUPINFOW si, LPPROCESS_INFORMATION pi)
{
    if (!g_orig.CreateProcessAsUserW) {
        SetLastError(ERROR_CALL_NOT_IMPLEMENTED);
        return FALSE;
    }
    return ws_create_process_common(token, 1, app, cmd, pa, ta, inherit, flags, env, cwd, si, pi);
}
