/* WinStageSandbox -- T4 shim: file API hooks.
 *
 * Write-intent calls are redirected into the staging tree; read calls consult the
 * overlay first and fall through to the real file on a miss (readThrough).
 * Fail-closed: when the provider cannot stage a write, the call fails with
 * ERROR_ACCESS_DENIED and the real system is NOT touched.
 *
 * Two things are load-bearing and easy to regress:
 *   - the hook engine must never patch the IAT of a module the shim itself
 *     imports from (ws_hook.c `ws_collect_self_providers`), or ws_log() ->
 *     CreateFileW re-enters ws_CreateFileW and recurses (see
 *     docs/T6-门禁收敛与载体完整性报告.md §2);
 *   - stat/existence (GetFileAttributes*) must answer from the OVERLAY, or a
 *     sandboxed process cannot see its own staged writes (`Test-Path` false ->
 *     the redirect canary's read-back is skipped; docs/T6 §3).
 */
#include "winstage_internal.h"

/* R11-D-13d-seq: shared per-process call ordinal, so log lines can be ordered and bound
 * to probe actions (existsSync -> statSync -> lstatSync -> readFileSync). */
static volatile LONG g_wsSeqN;
static long ws_seq(void) { return (long)InterlockedIncrement(&g_wsSeqN); }

/* Verbose file tracing (WINSTAGE_SHIM_VERBOSE=1). */
#define WS_TRACE_FILE(...) do { if (g_ws.verbose) ws_log(__VA_ARGS__); } while (0)

/* Re-entrancy guard for shim-internal mutations of STAGED paths.
 *
 * kernelbase.dll's IAT is patched too (it is not one of the shim's own import
 * providers -- measured: the hook log lists kernelbase!), so the real
 * DeleteFileW/RemoveDirectoryW that we call on a staged path reaches
 * kernelbase's internal NtSetInformationFile through OUR hook. Without this
 * guard ws_DeleteFileW would recurse into ws_NtSetInformationFile, which would
 * delete the staged copy again and whiteout the logical path, forever.
 * Thread-local: another thread's delete must still be intercepted. */
static _Thread_local int t_wsFileBusy;

/* --------------------------------------------------------------- helpers */

/* Windows console/pseudo devices are not files: intercepting them turns console
 * I/O into staged file I/O. `CONOUT$` was the one that mattered: PowerShell's
 * console writes were staged, the copy-on-write of CONOUT$ failed, and the
 * fail-closed ACCESS_DENIED killed the process (0x80131623 masked as a CLR
 * error). The check is applied to the basename as well, because the path may
 * already have been made absolute. */
static int ws_is_device_name(const wchar_t *s)
{
    static const wchar_t *exact[] = {
        L"NUL", L"CON", L"PRN", L"AUX", L"CONOUT$", L"CONIN$", L"CONOUT", L"CONIN", L"CLOCK$", L"$MFT",
    };
    static const wchar_t *withExt[] = { L"CON", L"PRN", L"AUX", L"NUL" };
    if (!s || !s[0]) {
        return 0;
    }
    for (size_t i = 0; i < sizeof(exact) / sizeof(exact[0]); i++) {
        if (ws_wcscmp_ci(s, exact[i]) == 0) {
            return 1;
        }
        /* CONOUT$ can also appear as CONOUT$.something in weird callers */
        if (ws_starts_with_ci_w(s, exact[i]) && s[wcslen(exact[i])] == L'.') {
            return 1;
        }
    }
    for (size_t i = 0; i < sizeof(withExt) / sizeof(withExt[0]); i++) {
        if (ws_starts_with_ci_w(s, withExt[i])) {
            size_t n = wcslen(withExt[i]);
            if (s[n] == 0 || s[n] == L'.') {
                return 1;
            }
        }
    }
    if ((ws_starts_with_ci_w(s, L"COM") || ws_starts_with_ci_w(s, L"LPT")) &&
        s[3] >= L'1' && s[3] <= L'9' && (s[4] == 0 || s[4] == L'.')) {
        return 1;
    }
    return 0;
}

static int ws_is_device_path(const wchar_t *norm)
{
    if (ws_starts_with_ci_w(norm, L"\\\\.\\") ||
        ws_starts_with_ci_w(norm, L"\\Device\\") ||
        ws_starts_with_ci_w(norm, L"\\\\?\\GLOBALROOT") ||
        ws_starts_with_ci_w(norm, L"\\??\\")) {
        return 1;
    }
    if (ws_is_device_name(norm)) {
        return 1;
    }
    const wchar_t *base = wcsrchr(norm, L'\\');
    return ws_is_device_name(base ? base + 1 : norm);
}
/* Prefix test for the staging root / passthrough entries: the prefix must end at
 * a path separator, otherwise a real file whose name merely STARTS WITH the
 * staging root (e.g. stage root "C:\s\stage" and file "C:\s\stage-report.txt")
 * would silently bypass the sandbox and be written to the real system. */
static int ws_under_prefix(const wchar_t *norm, const wchar_t *prefix)
{
    if (!ws_starts_with_ci_w(norm, prefix)) {
        return 0;
    }
    size_t n = wcslen(prefix);
    return norm[n] == 0 || norm[n] == L'\\';
}

/* 1 = intercept, 0 = pass through to the real API unchanged. */
static int ws_should_intercept(const wchar_t *path, wchar_t *norm, DWORD cch)
{
    /* ★ WP13（B5）：`GetFullPathNameW` 失败时会改 last error，而本函数是**每一个**
     * 文件钩子的第一跳，只用一个布尔结果回答"是否接管"。判断结果由返回值表达，
     * 因此入口保存、每条出口还原，对调用方在线程状态上完全透明。 */
    DWORD ws_saved_last_error = GetLastError();
    if (!path || !path[0] || !g_ws.haveStageRoot) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    /* Device/console names first, and on the raw string: GetFullPathNameW would
     * happily turn "CONOUT$" into "<cwd>\CONOUT$". */
    wchar_t probe[WS_PATH_MAX];
    if (ws_normalize_path(path, probe, WS_PATH_MAX) && ws_is_device_path(probe)) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    /* Relative paths are resolved against the process CWD before staging, so a
     * relative write is staged instead of silently reaching the real disk. */
    wchar_t full[WS_PATH_MAX];
    if (!GetFullPathNameW(path, WS_PATH_MAX, full, NULL)) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    if (!ws_normalize_path(full, norm, cch)) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    if (ws_is_device_path(norm)) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    if (ws_under_prefix(norm, g_ws.stageRoot)) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    for (int i = 0; i < g_ws.passthroughCount; i++) {
        if (ws_under_prefix(norm, g_ws.passthrough[i])) {
            SetLastError(ws_saved_last_error);
            return 0;
        }
    }
    SetLastError(ws_saved_last_error);
    return 1;
}

static int ws_resolve_file(const wchar_t *norm, uint32_t intent, wchar_t *out, uint32_t *flags)
{
    if (!g_wsStage.file_resolve) {
        return -1;
    }
    return g_wsStage.file_resolve(norm, intent, out, WS_PATH_MAX, flags);
}

/* Real-API accessors for the stat family. These MUST NOT re-enter the hooks:
 * they are used by ws_file_exists() (a CoW/whiteout decision about the REAL
 * file) and as the tail of the overlay-aware wrappers. The captured original is
 * preferred; the plain call is only reached before ws_hook_init captured the
 * originals (nothing is patched yet) or if a capture ever failed, and our own
 * module's import table is never patched, so it still reaches the real API. */
static DWORD ws_real_attrs_w(const wchar_t *path)
{
    return g_orig.GetFileAttributesW ? g_orig.GetFileAttributesW(path) : GetFileAttributesW(path);
}

static BOOL ws_real_attrs_ex_w(const wchar_t *path, GET_FILEEX_INFO_LEVELS level, LPVOID info)
{
    return g_orig.GetFileAttributesExW ? g_orig.GetFileAttributesExW(path, level, info)
                                       : GetFileAttributesExW(path, level, info);
}

/* ★ WP13（B7）：这是每次 CreateFile / Delete / Move / SetFileAttributes 都会跑的
 * 探测（`ws_create_file_core` 入口就调用它），也是**运行期最高频**的 last-error 污染点。
 * 它只回答一个布尔问题，却会把 `GetFileAttributesW` 的 2/3 号错误留在调用者的线程状态上。
 * 注意 `ws_real_attrs_w` 本身**不要**改：它必须把真实 API 的错误交给这里的调用者判断，
 * 透明化点就在这一层。 */
static int ws_file_exists(const wchar_t *norm)
{
    DWORD ws_saved_last_error = GetLastError();
    int exists = ws_real_attrs_w(norm) != INVALID_FILE_ATTRIBUTES;
    SetLastError(ws_saved_last_error);
    return exists;
}

static void ws_a2w_buf(const char *in, wchar_t *out, DWORD cch)
{
    out[0] = 0;
    if (in) {
        if (!MultiByteToWideChar(CP_ACP, 0, in, -1, out, (int)cch)) {
            out[0] = 0;
        }
    }
}

#define WS_FILE_WRITE_ACCESS_MASK \
    (GENERIC_WRITE | GENERIC_ALL | FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | \
     FILE_WRITE_ATTRIBUTES | DELETE | WRITE_DAC | WRITE_OWNER | FILE_DELETE_CHILD)

static uint32_t ws_intent_of_create(DWORD access, DWORD disposition)
{
    DWORD writeAccess = access & WS_FILE_WRITE_ACCESS_MASK;
    switch (disposition) {
    case CREATE_NEW:
    case CREATE_ALWAYS:
    case TRUNCATE_EXISTING:
    case OPEN_ALWAYS:
        return WINSTAGE_IO_WRITE;
    default:
        return writeAccess ? WINSTAGE_IO_WRITE : WINSTAGE_IO_READ;
    }
}

/* --------------------------------------------------------------- hooks */

/* Write-intent opens of an EXISTING real file must copy the real content into
 * the overlay first (copy-on-write). Without CoW, an OPEN_ALWAYS/GENERIC_WRITE
 * open of a real file was redirected to a non-existent overlay path, which
 * OPEN_ALWAYS then silently created as an empty file -- the caller read an empty
 * file where the real system had content. That is what broke PowerShell's
 * InitialSessionState (.NET reads files with OPEN_ALWAYS during startup). */
static HANDLE ws_create_file_core(LPCWSTR lpFileName, DWORD dwDesiredAccess, DWORD dwShareMode,
                                  LPSECURITY_ATTRIBUTES lpSecurityAttributes, DWORD dwCreationDisposition,
                                  DWORD dwFlagsAndAttributes, HANDLE hTemplateFile, int isAnsi)
{
    /* Read masking (task-10) runs before anything else, so a sensitive path is
     * denied even if it would otherwise pass through (staging root, device names,
     * passthrough prefixes). Only read-class access is subject to the mask; writes
     * keep the staging behaviour. */
    DWORD writeAccessMask = dwDesiredAccess & WS_FILE_WRITE_ACCESS_MASK;
    int destructiveMask = (dwCreationDisposition == CREATE_NEW || dwCreationDisposition == CREATE_ALWAYS ||
                           dwCreationDisposition == TRUNCATE_EXISTING);
    if (ws_mask_declared() && !writeAccessMask && !destructiveMask && lpFileName && lpFileName[0]) {
        wchar_t maskedBy[256];
        if (ws_mask_decide_read(lpFileName, maskedBy, 256)) {
            ws_log_w(L"read masked", lpFileName);
            WS_TRACE_FILE("CreateFile read denied by mask rule %ls", maskedBy);
            SetLastError(ERROR_ACCESS_DENIED);
            return INVALID_HANDLE_VALUE;
        }
    }

    wchar_t norm[WS_PATH_MAX];
    int intercept = ws_should_intercept(lpFileName, norm, WS_PATH_MAX);
    WS_TRACE_FILE("CreateFile request raw=%ls normalized=%ls intercept=%d access=0x%lx disp=%lu",
                  lpFileName ? lpFileName : L"(null)", norm, intercept,
                  (unsigned long)dwDesiredAccess, (unsigned long)dwCreationDisposition);
    if (g_ws.auditPath[0] && lpFileName) {
        char esc[WS_PATH_MAX * 3];
        ws_audit_escape_w(lpFileName, esc, sizeof(esc));
        ws_audit("{\"op\":\"file.open\",\"mode\":\"%s\",\"path\":\"%s\",\"disp\":%lu}",
                 (writeAccessMask || destructiveMask) ? "write" : "read", esc,
                 (unsigned long)dwCreationDisposition);
    }
    if (!intercept) {
        return isAnsi ? g_orig.CreateFileA((LPCSTR)lpFileName, dwDesiredAccess, dwShareMode,
                                           lpSecurityAttributes, dwCreationDisposition,
                                           dwFlagsAndAttributes, hTemplateFile)
                      : g_orig.CreateFileW(lpFileName, dwDesiredAccess, dwShareMode,
                                           lpSecurityAttributes, dwCreationDisposition,
                                           dwFlagsAndAttributes, hTemplateFile);
    }
    DWORD writeAccess = writeAccessMask;
    int destructive = destructiveMask;
    int realExists = ws_file_exists(norm);

    /* A pure read (or a read-only OPEN_ALWAYS where the real file exists) is
     * never staged: the real API is authoritative. */
    if (!destructive && !writeAccess &&
        !(dwCreationDisposition == OPEN_ALWAYS && !realExists)) {
        wchar_t mapped[WS_PATH_MAX];
        uint32_t rflags = 0;
        if (ws_resolve_file(norm, WINSTAGE_IO_READ, mapped, &rflags) != 0) {
            ws_log_w(L"fail-closed CreateFile(read)", norm);
            SetLastError(ERROR_ACCESS_DENIED);
            return INVALID_HANDLE_VALUE;
        }
        if (rflags & WINSTAGE_RES_WHITEOUT) {
            SetLastError(ERROR_FILE_NOT_FOUND);
            return INVALID_HANDLE_VALUE;
        }
        if (g_ws.traceStagedOps) {
            /* ★ round-4 诊断：读分支此前**只在 RES_STAGED 时**打日志，读穿路径完全静默 ——
             * 失败run 的日志因此停在 "CreateFile request" 那一行，无法区分"死在我们钩子里"
             * 与"死在钩子之后"。这里记下解析结果；else 分支再记一次开启结果，两者一对比
             * 就能把死亡点夹在中间。 */
            ws_log("read-branch resolved flags=0x%lx mapped=%ls", (unsigned long)rflags, mapped);
        }
        HANDLE h;
        DWORD stagedErr = ERROR_SUCCESS;
        if (rflags & WINSTAGE_RES_STAGED) {
            /* ── WP13 overlay 读穿（read-through）修复 ────────────────────────────
             * `WINSTAGE_RES_STAGED` 只是"解析那一刻 overlay 里有件"的**快照**
             * （ws_stage.c `ws_exists(staged)`）。旧实现在这里无条件返回这次打开的
             * 结果，于是"快照命中、对象随后不可用"就变成一次**没有回落**的失败。
             * 实测形态（shim.log，PID 6104）：
             *   [5] CreateFileW staged(write) ...\dsh-stage-temp\<uuid>\__PSScriptPolicyTest_*.rnf.ps1
             *   [7] CreateFile overlay(read)  <同一路径>
             * 第二条实测路径（同一份日志，PID 3412/12072/5444/12020/11060/2180/2640/1584/3804 同形）：
             *   ...\AppData\Local\Microsoft\Windows\PowerShell\StartupProfileData-NonInteractive
             * 这正是 PowerShell 启动期/策略探针把读取路由成 overlay 读、缺件时拿不到真实文件
             * ⇒ `0x80070002`（进而 `0xE0434352`）的来源。
             *
             * 修法：**仅当 overlay 打开失败**且**调用方不是破坏性打开**时，回落一次真实
             * 路径。三条同时成立才回落，任何一条不满足就原样返回，fail-closed 语义不被放宽：
             *   ① `!destructive`：CREATE_ALWAYS/TRUNCATE_EXISTING 绝不能借回落去动真实文件
             *      （本分支由外层 if 已保证，这里再断言一次）；
             *   ② `wcscmp(mapped, norm) != 0`：真回落，不是同一路径空转；
             *   ③ `ws_file_exists(norm)`：真实文件确实存在（否则回落也只是换个
             *      ERROR_FILE_NOT_FOUND，白付一次系统调用）。
             * 回落失败时**保留 overlay 那次错误**（否则调用者看到 3 而非 2，语义漂移）。
             * 幂等/不递归：回落目标 `norm` 位于 stageRoot 与 passthrough 之外
             * （ws_should_intercept 已排除），且经 `g_orig.CreateFileW` 直调、不进钩子。 */
            h = g_orig.CreateFileW(mapped, dwDesiredAccess, dwShareMode, lpSecurityAttributes,
                                   dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
            stagedErr = GetLastError();
    { /* R11-D-13d-ovl: record the overlay open's own outcome (zero semantic change) */
        DWORD ovl_se = GetLastError();
        ws_log("ATTRDBG-CFW-OVL handle=%p valid=%d err=%lu path=%ls", (void *)h,
               (h != INVALID_HANDLE_VALUE) ? 1 : 0, (unsigned long)stagedErr, lpFileName);
        SetLastError(ovl_se);
    }
            if (h == INVALID_HANDLE_VALUE && !destructive &&
                ws_wcscmp_ci(mapped, norm) != 0 && ws_file_exists(norm)) {
                ws_log_w(L"CreateFile overlay(read) miss -> read-through real", norm);
                HANDLE hReal = g_orig.CreateFileW(norm, dwDesiredAccess, dwShareMode, lpSecurityAttributes,
                                                  dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
                h = hReal;
                stagedErr = (hReal == INVALID_HANDLE_VALUE) ? stagedErr : ERROR_SUCCESS;
            }
        } else {
            h = g_orig.CreateFileW(mapped, dwDesiredAccess, dwShareMode, lpSecurityAttributes,
                                   dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
            stagedErr = GetLastError();
            if (g_ws.traceStagedOps) {
                /* ★ round-4 诊断：读穿（RES_REAL）分支的**开启结果**。与上面的
                 * "read-branch resolved" 配对：若失败run 只有 resolved 没有这一行，
                 * 死亡点就在 `g_orig.CreateFileW` 之内/紧后；若两行都有，则死在钩子之外。 */
                ws_log("read-branch real-open ok=%d err=%lu", h != INVALID_HANDLE_VALUE,
                       (unsigned long)stagedErr);
            }
        }
        if (g_ws.traceStagedOps && (rflags & WINSTAGE_RES_STAGED)) {
            /* ★ round-4 诊断：这条日志此前**成败共用同一行**，于是失败run 的日志
             * 里根本看不出那次 overlay 读到底成没成。失败时补上错误码与
             * "真实文件是否存在"，用于区分：
             *   err=2  ⇒ 暂存副本不在（写侧与读侧口径不一致/被删）
             *   err=5  ⇒ 暂存副本在但打不开（ACL/共享/CoW 痕迹）
             *   err=32 ⇒ 被别的句柄占用（共享模式不匹配） */
            if (h == INVALID_HANDLE_VALUE) {
                ws_log("CreateFile overlay(read) FAILED mapped=%ls err=%lu realExists=%d", mapped,
                       (unsigned long)stagedErr, ws_file_exists(norm));
            } else {
                ws_log_w(L"CreateFile overlay(read)", mapped);
            }
            SetLastError(stagedErr);
        }
        return h;
    }

    wchar_t staged[WS_PATH_MAX];
    uint32_t wflags = 0;
    if (ws_resolve_file(norm, WINSTAGE_IO_WRITE, staged, &wflags) != 0) {
        ws_log_w(L"fail-closed CreateFileW", norm);
        SetLastError(ERROR_ACCESS_DENIED);
        return INVALID_HANDLE_VALUE;
    }
    int stagedExists = ws_file_exists(staged);
    if (dwCreationDisposition == CREATE_NEW && (realExists || stagedExists)) {
        SetLastError(ERROR_FILE_EXISTS);
        return INVALID_HANDLE_VALUE;
    }
    /* Copy-on-write. Needed for every write-intent open whose overlay content is
     * kept (OPEN_* with write access) AND for TRUNCATE_EXISTING: a truncate still
     * needs an overlay file to act on, otherwise the staged open fails with
     * ERROR_FILE_NOT_FOUND even though the real file exists (PowerShell's
     * FileMode.Truncate hit exactly that: disp=5 reached the shim, .NET reported
     * "Cannot create <path>", and no overlay file was created). Copying instead
     * of creating an empty file also preserves a read-only attribute, so the
     * truncate then fails with ERROR_ACCESS_DENIED exactly like the real API.
     * CREATE_ALWAYS discards the content in the open itself and CREATE_NEW was
     * already rejected above, so neither needs the copy. */
    if (!stagedExists && realExists && (!destructive || dwCreationDisposition == TRUNCATE_EXISTING)) {
        DWORD realAttrs = ws_real_attrs_w(norm);
        if (realAttrs != INVALID_FILE_ATTRIBUTES && (realAttrs & FILE_ATTRIBUTE_DIRECTORY)) {
            /* ★ round-4 修复：**目录不能 CoW** —— `CopyFileW` 对目录必然失败，旧代码于是把
             * "打开一个已存在的目录"误判成 `copy-on-write failed` 并 fail-closed 拒绝。
             * 实测受害路径：`C:\ProgramData\Microsoft\Windows\WER\Temp`（WER 注册自己的临时
             * 目录；真实文件系统允许这种打开，我们的拒绝让 .NET 的错误报告路径拿不到目录，
             * 随后放大了它自己的失败）。正确做法：在覆盖层**镜像一个目录**，然后照常继续
             * （调用方的 FILE_FLAG_BACKUP_SEMANTICS 等标志原样传下去，语义与真实 API 一致）。 */
            if (!ws_ensure_dirs(staged, 1)) {
                ws_log_w(L"fail-closed CreateFileW (staged dir create failed)", staged);
                SetLastError(ERROR_ACCESS_DENIED);
                return INVALID_HANDLE_VALUE;
            }
            ws_log_w(L"CreateFileW stage-directory", staged);
        } else if (!g_orig.CopyFileW(norm, staged, FALSE)) {
            ws_log_w(L"fail-closed CreateFileW (copy-on-write failed)", norm);
            SetLastError(ERROR_ACCESS_DENIED);
            return INVALID_HANDLE_VALUE;
        } else {
            ws_log_w(L"CreateFileW copy-on-write", staged);
        }
    }
    HANDLE h = g_orig.CreateFileW(staged, dwDesiredAccess, dwShareMode, lpSecurityAttributes,
                                  dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
    if (g_ws.traceStagedOps && (writeAccess || destructive)) {
        /* Do not lose the failing call's error code while tracing it (see the
         * read branch above): the sandboxed caller must see the same error an
         * uninjected caller sees. */
        DWORD lastErr = GetLastError();
        ws_log_w(h == INVALID_HANDLE_VALUE ? L"CreateFileW staged FAILED" : L"CreateFileW staged(write)", staged);
        SetLastError(lastErr);
    }
    return h;
}

HANDLE WINAPI ws_CreateFileW(LPCWSTR lpFileName, DWORD dwDesiredAccess, DWORD dwShareMode,
                             LPSECURITY_ATTRIBUTES lpSecurityAttributes, DWORD dwCreationDisposition,
                             DWORD dwFlagsAndAttributes, HANDLE hTemplateFile)
{
    { /* R11-D-13d-cfw: open-form log, LastError-safe (zero semantic change) */
        DWORD cfw_se = GetLastError();
        ws_log("ATTRDBG-CFW seq=%ld desiredAccess=0x%lx share=0x%lx disposition=%lu flags=0x%lx path=%ls", /* R11-D-13d-seq */
               ws_seq(), (unsigned long)dwDesiredAccess, (unsigned long)dwShareMode, (unsigned long)dwCreationDisposition,
               (unsigned long)dwFlagsAndAttributes, lpFileName);
        SetLastError(cfw_se);
    }
    ws_callhit_named("CreateFileW"); /* R11-D-13d */
    WS_STUCK("CreateFileW");
    ws_stuck_path(lpFileName);
    return ws_create_file_core(lpFileName, dwDesiredAccess, dwShareMode, lpSecurityAttributes,
                               dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile, 0);
}
HANDLE WINAPI ws_CreateFileA(LPCSTR lpFileName, DWORD dwDesiredAccess, DWORD dwShareMode,
                             LPSECURITY_ATTRIBUTES lpSecurityAttributes, DWORD dwCreationDisposition,
                             DWORD dwFlagsAndAttributes, HANDLE hTemplateFile)
{
    wchar_t wide[WS_PATH_MAX];
    ws_a2w_buf(lpFileName, wide, WS_PATH_MAX);
    return ws_create_file_core(wide[0] ? wide : NULL, dwDesiredAccess, dwShareMode, lpSecurityAttributes,
                               dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile, 0);
}

BOOL WINAPI ws_CreateDirectoryW(LPCWSTR lpPathName, LPSECURITY_ATTRIBUTES lpSecurityAttributes)
{
    wchar_t norm[WS_PATH_MAX];
    if (!ws_should_intercept(lpPathName, norm, WS_PATH_MAX)) {
        return g_orig.CreateDirectoryW(lpPathName, lpSecurityAttributes);
    }
    if (ws_file_exists(norm)) {
        SetLastError(ERROR_ALREADY_EXISTS);
        return FALSE;
    }
    wchar_t mapped[WS_PATH_MAX];
    uint32_t flags = 0;
    if (ws_resolve_file(norm, WINSTAGE_IO_WRITE, mapped, &flags) != 0) {
        ws_log_w(L"fail-closed CreateDirectoryW", norm);
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    BOOL ok = g_orig.CreateDirectoryW(mapped, lpSecurityAttributes);
    DWORD lastErr = GetLastError();
    ws_log_w(ok ? L"CreateDirectoryW staged" : L"CreateDirectoryW staged FAILED", mapped);
    SetLastError(lastErr);
    return ok;
}

BOOL WINAPI ws_CreateDirectoryA(LPCSTR lpPathName, LPSECURITY_ATTRIBUTES lpSecurityAttributes)
{
    wchar_t wide[WS_PATH_MAX];
    ws_a2w_buf(lpPathName, wide, WS_PATH_MAX);
    return ws_CreateDirectoryW(wide[0] ? wide : NULL, lpSecurityAttributes);
}

BOOL WINAPI ws_DeleteFileW(LPCWSTR lpFileName)
{
    WS_STUCK("DeleteFileW");
    ws_stuck_path(lpFileName);
    wchar_t norm[WS_PATH_MAX];
    int intercept = ws_should_intercept(lpFileName, norm, WS_PATH_MAX);
    WS_TRACE_FILE("DeleteFileW request raw=%ls normalized=%ls intercept=%d",
                  lpFileName ? lpFileName : L"(null)", norm, intercept);
    if (g_ws.auditPath[0]) {
        ws_audit_path("file.delete", lpFileName, NULL);
    }
    if (!intercept) {
        return g_orig.DeleteFileW(lpFileName);
    }
    int realExists = ws_file_exists(norm);
    wchar_t mapped[WS_PATH_MAX];
    uint32_t flags = 0;
    if (ws_resolve_file(norm, WINSTAGE_IO_DELETE, mapped, &flags) != 0) {
        ws_log_w(L"fail-closed DeleteFileW", norm);
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    int stagedExists = ws_file_exists(mapped);
    BOOL deletedStaged = TRUE;
    if (stagedExists) {
        /* see t_wsFileBusy: kernelbase's internals re-enter our Nt hook */
        t_wsFileBusy++;
        deletedStaged = g_orig.DeleteFileW(mapped);
        t_wsFileBusy--;
    }
    if (!realExists && !stagedExists) {
        SetLastError(ERROR_FILE_NOT_FOUND);
        return FALSE;
    }
    if (!deletedStaged) {
        return FALSE;
    }
    /* readonly attribute on the real file would have blocked a real delete */
    DWORD attrs = GetFileAttributesW(norm);
    if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY)) {
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    if (g_wsStage.file_whiteout) {
        g_wsStage.file_whiteout(norm);
    }
    DWORD lastErr = GetLastError(); /* keep the API's error, not the log write's */
    ws_log_w(L"DeleteFileW staged+whiteout", norm);
    SetLastError(lastErr);
    return TRUE;
}

BOOL WINAPI ws_DeleteFileA(LPCSTR lpFileName)
{
    wchar_t wide[WS_PATH_MAX];
    ws_a2w_buf(lpFileName, wide, WS_PATH_MAX);
    return ws_DeleteFileW(wide[0] ? wide : NULL);
}

static BOOL ws_move_locked(LPCWSTR src, LPCWSTR dst, DWORD flags)
{
    wchar_t normSrc[WS_PATH_MAX], normDst[WS_PATH_MAX];
    if (!ws_should_intercept(src, normSrc, WS_PATH_MAX) || !ws_should_intercept(dst, normDst, WS_PATH_MAX)) {
        return g_orig.MoveFileExW(src, dst, flags);
    }
    wchar_t stagedSrc[WS_PATH_MAX], stagedDst[WS_PATH_MAX];
    uint32_t fSrc = 0, fDst = 0;
    if (ws_resolve_file(normSrc, WINSTAGE_IO_WRITE, stagedSrc, &fSrc) != 0 ||
        ws_resolve_file(normDst, WINSTAGE_IO_WRITE, stagedDst, &fDst) != 0) {
        ws_log_w(L"fail-closed MoveFileExW", normDst);
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    int stagedSrcExists = ws_file_exists(stagedSrc);
    int realSrcExists = ws_file_exists(normSrc);
    if (!stagedSrcExists && !realSrcExists) {
        SetLastError(ERROR_FILE_NOT_FOUND);
        return FALSE;
    }
    BOOL ok;
    if (stagedSrcExists) {
        t_wsFileBusy++; /* kernelbase's MoveFileExW reaches NtSetInformationFile */
        ok = g_orig.MoveFileExW(stagedSrc, stagedDst, flags);
        t_wsFileBusy--;
    } else {
        /* materialize the real source into the overlay, then hide the original */
        DWORD realAttrs = GetFileAttributesW(normSrc);
        DWORD copyFlags = flags;
        (void)copyFlags;
        ok = g_orig.CopyFileW ? g_orig.CopyFileW(normSrc, stagedDst, FALSE) : FALSE;
        if (ok && g_wsStage.file_whiteout) {
            g_wsStage.file_whiteout(normSrc);
        }
        (void)realAttrs;
    }
    if (ok) {
        DWORD lastErr = GetLastError(); /* the log write must not become the caller's error */
        ws_log_w(L"MoveFileExW staged", stagedDst);
        SetLastError(lastErr);
    }
    return ok;
}

BOOL WINAPI ws_MoveFileExW(LPCWSTR lpExistingFileName, LPCWSTR lpNewFileName, DWORD dwFlags)
{
    WS_STUCK("MoveFileExW");
    ws_stuck_path(lpExistingFileName);
    if (g_ws.auditPath[0]) {
        char e1[WS_PATH_MAX * 3];
        char e2[WS_PATH_MAX * 3];
        ws_audit_escape_w(lpExistingFileName, e1, sizeof(e1));
        ws_audit_escape_w(lpNewFileName, e2, sizeof(e2));
        ws_audit("{\"op\":\"file.move\",\"from\":\"%s\",\"to\":\"%s\"}", e1, e2);
    }
    return ws_move_locked(lpExistingFileName, lpNewFileName, dwFlags);
}

BOOL WINAPI ws_MoveFileExA(LPCSTR a, LPCSTR b, DWORD dwFlags)
{
    wchar_t wa[WS_PATH_MAX], wb[WS_PATH_MAX];
    ws_a2w_buf(a, wa, WS_PATH_MAX);
    ws_a2w_buf(b, wb, WS_PATH_MAX);
    return ws_move_locked(wa[0] ? wa : NULL, wb[0] ? wb : NULL, dwFlags);
}

BOOL WINAPI ws_MoveFileW(LPCWSTR a, LPCWSTR b)
{
    return ws_move_locked(a, b, MOVEFILE_COPY_ALLOWED);
}

BOOL WINAPI ws_MoveFileA(LPCSTR a, LPCSTR b)
{
    wchar_t wa[WS_PATH_MAX], wb[WS_PATH_MAX];
    ws_a2w_buf(a, wa, WS_PATH_MAX);
    ws_a2w_buf(b, wb, WS_PATH_MAX);
    return ws_move_locked(wa[0] ? wa : NULL, wb[0] ? wb : NULL, MOVEFILE_COPY_ALLOWED);
}

static BOOL ws_remove_directory_locked(LPCWSTR path)
{
    wchar_t norm[WS_PATH_MAX];
    if (!ws_should_intercept(path, norm, WS_PATH_MAX)) {
        return g_orig.RemoveDirectoryW(path);
    }
    wchar_t staged[WS_PATH_MAX];
    uint32_t flags = 0;
    if (ws_resolve_file(norm, WINSTAGE_IO_DELETE, staged, &flags) != 0) {
        ws_log_w(L"fail-closed RemoveDirectoryW", norm);
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    int stagedExists = ws_file_exists(staged);
    int realExists = ws_file_exists(norm);
    if (!stagedExists && !realExists) {
        SetLastError(ERROR_PATH_NOT_FOUND);
        return FALSE;
    }
    if (stagedExists) {
        t_wsFileBusy++; /* RemoveDirectoryW also reaches NtSetInformationFile(kernelbase) */
        BOOL okDir = g_orig.RemoveDirectoryW(staged);
        t_wsFileBusy--;
        if (!okDir) {
            return FALSE; /* e.g. ERROR_DIR_NOT_EMPTY, same as the real API */
        }
    } else {
        /* real-only: mirror the real API's emptiness check before hiding it */
        wchar_t pattern[WS_PATH_MAX];
        size_t pos = 0;
        pattern[0] = 0;
        ws_append_w(pattern, WS_PATH_MAX, &pos, norm);
        ws_append_w(pattern, WS_PATH_MAX, &pos, L"\\*");
        WIN32_FIND_DATAW fd;
        HANDLE h = FindFirstFileW(pattern, &fd);
        if (h != INVALID_HANDLE_VALUE) {
            int nonEmpty = 0;
            do {
                if (wcscmp(fd.cFileName, L".") != 0 && wcscmp(fd.cFileName, L"..") != 0) {
                    nonEmpty = 1;
                    break;
                }
            } while (FindNextFileW(h, &fd));
            FindClose(h);
            if (nonEmpty) {
                SetLastError(ERROR_DIR_NOT_EMPTY);
                return FALSE;
            }
        }
    }
    /* ★ round-4 修复（WP13 审计 B11 邻近项）：错误必须在**调用 whiteout 之前**取走 ——
     * `g_wsStage.file_whiteout()` 内部会做文件 IO 并把**它自己**的错误留在 last error 上，
     * 旧代码在它之后才 `GetLastError()`，于是"保留 API 的错误"实际上保留成了 whiteout 的错误。 */
    DWORD lastErr = GetLastError();
    if (g_wsStage.file_whiteout) {
        g_wsStage.file_whiteout(norm);
    }
    ws_log_w(L"RemoveDirectoryW staged+whiteout", norm);
    SetLastError(lastErr);
    return TRUE;
}

BOOL WINAPI ws_RemoveDirectoryW(LPCWSTR lpPathName)
{
    WS_STUCK("RemoveDirectoryW");
    ws_stuck_path(lpPathName);
    return ws_remove_directory_locked(lpPathName);
}

BOOL WINAPI ws_RemoveDirectoryA(LPCSTR lpPathName)
{
    wchar_t wide[WS_PATH_MAX];
    ws_a2w_buf(lpPathName, wide, WS_PATH_MAX);
    return ws_remove_directory_locked(wide[0] ? wide : NULL);
}

static BOOL ws_copy_file_locked(LPCWSTR src, LPCWSTR dst, BOOL failIfExists)
{
    wchar_t normSrc[WS_PATH_MAX], normDst[WS_PATH_MAX];
    if (!ws_should_intercept(src, normSrc, WS_PATH_MAX) || !ws_should_intercept(dst, normDst, WS_PATH_MAX)) {
        return g_orig.CopyFileW(src, dst, failIfExists);
    }
    wchar_t stagedSrc[WS_PATH_MAX], stagedDst[WS_PATH_MAX];
    uint32_t fSrc = 0, fDst = 0;
    if (ws_resolve_file(normSrc, WINSTAGE_IO_READ, stagedSrc, &fSrc) != 0 ||
        ws_resolve_file(normDst, WINSTAGE_IO_WRITE, stagedDst, &fDst) != 0) {
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    if (fSrc & (WINSTAGE_RES_WHITEOUT)) {
        SetLastError(ERROR_FILE_NOT_FOUND);
        return FALSE;
    }
    if (failIfExists && ws_file_exists(normDst)) {
        SetLastError(ERROR_FILE_EXISTS);
        return FALSE;
    }
    return g_orig.CopyFileW(stagedSrc, stagedDst, FALSE);
}

BOOL WINAPI ws_CopyFileW(LPCWSTR src, LPCWSTR dst, BOOL failIfExists)
{
    return ws_copy_file_locked(src, dst, failIfExists);
}

BOOL WINAPI ws_CopyFileA(LPCSTR src, LPCSTR dst, BOOL failIfExists)
{
    wchar_t a[WS_PATH_MAX], b[WS_PATH_MAX];
    ws_a2w_buf(src, a, WS_PATH_MAX);
    ws_a2w_buf(dst, b, WS_PATH_MAX);
    return ws_copy_file_locked(a[0] ? a : NULL, b[0] ? b : NULL, failIfExists);
}

BOOL WINAPI ws_SetFileAttributesW(LPCWSTR lpFileName, DWORD dwFileAttributes)
{
    wchar_t norm[WS_PATH_MAX];
    int intercept = ws_should_intercept(lpFileName, norm, WS_PATH_MAX);
    WS_TRACE_FILE("SetFileAttributesW request raw=%ls normalized=%ls intercept=%d attrs=0x%lx",
                  lpFileName ? lpFileName : L"(null)", norm, intercept, (unsigned long)dwFileAttributes);
    if (!intercept) {
        return g_orig.SetFileAttributesW(lpFileName, dwFileAttributes);
    }
    wchar_t mapped[WS_PATH_MAX];
    uint32_t flags = 0;
    if (ws_resolve_file(norm, WINSTAGE_IO_WRITE, mapped, &flags) != 0) {
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    if (!ws_file_exists(mapped)) {
        if (!ws_file_exists(norm)) {
            SetLastError(ERROR_FILE_NOT_FOUND);
            return FALSE;
        }
        /* materialize so the attribute change is visible in the overlay */
        if (!g_orig.CopyFileW(norm, mapped, FALSE)) {
            return FALSE;
        }
    }
    BOOL ok = g_orig.SetFileAttributesW(mapped, dwFileAttributes);
    DWORD lastErr = GetLastError();
    ws_log_w(ok ? L"SetFileAttributesW staged" : L"SetFileAttributesW staged FAILED", mapped);
    SetLastError(lastErr);
    return ok;
}

/* ------------------------------------------------ stat / existence queries
 *
 * GetFileAttributes* is how runtimes ask "does this file exist?": PowerShell's
 * Test-Path, .NET File.Exists/Directory.Exists, cmd's `if exist`, CRT _access.
 * They are not file opens, so before these wrappers an existence check went
 * straight to the real disk, missed the overlay copy and made the caller skip a
 * read that would have been served from the overlay. That is the second half of
 * the redirect gap: the write was staged correctly, but the injected PowerShell
 * canary (`if (Test-Path -LiteralPath $f) { Get-Content $f }`) decided the file
 * did not exist and never opened it (no `CreateFile overlay(read)` in the log).
 *
 * Resolution mirrors a read open:
 *   !intercept          -> the real API on the caller's own path
 *   read-masked         -> look missing (existence must not leak the path)
 *   whiteout            -> look missing, ERROR_FILE_NOT_FOUND
 *   overlay copy exists -> report the OVERLAY file's attributes/data
 *   otherwise           -> report the REAL file's attributes/data
 *
 * The provider is never asked to fail closed here: a stat that cannot be
 * resolved is a read, and reads fall through to the real API.
 * ws_file_exists() deliberately keeps using the real API on the real path: it
 * decides CoW and whether a real file may be hidden, so it must never consult
 * the overlay (and it must never re-enter these wrappers). */
static int ws_stat_read_masked(LPCWSTR lpFileName)
{
    wchar_t maskedBy[256];
    return ws_mask_declared() && lpFileName && lpFileName[0] &&
           ws_mask_decide_read(lpFileName, maskedBy, 256);
}

/* PowerShell's AppLocker / App-Control lock-down probe.
 *
 * Before it decides whether scripts may run, PowerShell writes
 * "%TEMP%\__PSScriptPolicyTest_<random>.ps1" and ".psm1" (PowerShell 7.x also
 * uses __PSAppLockerTest__*) and then asks whether those files exist -- measured
 * in the shim log: GetFileAttributesExW on the probe path, then
 * `if exists -> DeleteFileW`. If the existence answer is "yes" for a file whose
 * content is only in the overlay (the OS code path that PowerShell uses to
 * actually run the probe cannot see it), PowerShell concludes that script
 * execution is blocked, enters a locked-down state and refuses to load its own
 * .psm1 script modules: Write-Output, Out-File (hence every `>` redirect) and
 * Get-ChildItem all become "not recognized". Measured: 13/13 injected
 * PowerShell 5.1 startups lost their cmdlets as soon as GetFileAttributesExW
 * reported the probe files as existing, and the same binary with the stat hooks
 * disabled kept them.
 *
 * The probe asks the OS about the OS, not about the sandbox, so it keeps the
 * real filesystem's answer; every other path stays overlay-aware.
 *
 * Measured second, independent cause of the same symptom: the provider's whiteout
 * lookup counted a DIRECTORY in the wo tree as a marker, so C:\ (and every
 * ancestor directory of any whiteout) was reported deleted. Fixed in
 * ws_stage.c (ws_marker_exists) -- see tests/file-cow-dispositions.mjs c10. */
static int ws_is_lockdown_probe(const wchar_t *path)
{
    if (!path) {
        return 0;
    }
    const wchar_t *base = wcsrchr(path, L'\\');
    base = base ? base + 1 : path;
    return ws_starts_with_ci_w(base, L"__PSScriptPolicyTest_") ||
           ws_starts_with_ci_w(base, L"__PSAppLockerTest__");
}

/* Shared resolution for the stat family. Returns 1 when the caller must look
 * "missing"; otherwise 0 with `mapped` holding the path the real API should be
 * asked about and `isStaged` telling whether that path is the overlay copy. */
static int ws_stat_resolve(LPCWSTR lpFileName, wchar_t *mapped, DWORD cch, int *isStaged)
{
    *isStaged = 0;
    if (ws_is_lockdown_probe(lpFileName)) {
        /* Delegate the raw path: the real API answers, no overlay copy is offered
         * (see ws_is_lockdown_probe). */
        /* ★ round-4 诊断：探针的 stat 是"写暂存 / 看真实"这对刻意不对称的一半，
         * 这里把**真实答案**记下来，事后可与写/读两侧对齐（失败run 里我们只能看到
         * 写成功与一次 overlay 读，看不到 stat 的回答）。 */
        {
            DWORD probeAttrs = ws_real_attrs_w(lpFileName);
            DWORD probeErr = GetLastError();
            ws_log("lockdown-probe stat: exists=%d err=%lu path=%ls",
                   probeAttrs != INVALID_FILE_ATTRIBUTES, (unsigned long)probeErr, lpFileName);
        }
        ws_strlcpy_w(mapped, lpFileName, cch);
        return 0;
    }
    wchar_t norm[WS_PATH_MAX];
    if (!ws_should_intercept(lpFileName, norm, WS_PATH_MAX)) {
        ws_strlcpy_w(mapped, lpFileName, cch);
        return 0;
    }
    uint32_t flags = 0;
    if (ws_resolve_file(norm, WINSTAGE_IO_READ, mapped, &flags) != 0) {
        ws_strlcpy_w(mapped, norm, cch); /* real API, real path */
        return 0;
    }
    if (flags & WINSTAGE_RES_WHITEOUT) {
        return 1;
    }
    *isStaged = (flags & WINSTAGE_RES_STAGED) ? 1 : 0;
    return 0;
}

/* R11-D-13d-attr: path-only logging for the attribute/open face. ZERO semantic change:
 * no argument/return/LastError touch; the sole added work is one ws_log line, and a
 * re-entrancy guard stops a log write from recursing back through our own hooks. */
static volatile LONG g_attrLogBusy;
static void ws_attr_log(const char *api, const wchar_t *path)
{
    if (InterlockedExchange(&g_attrLogBusy, 1) != 0) {
        return;
    }
    if (path) {
        ws_log("ATTRDBG seq=%ld api=%s path=%ls", ws_seq(), api, path); /* R11-D-13d-seq */
    } else {
        ws_log("ATTRDBG api=%s path=<null>", api);
    }
    InterlockedExchange(&g_attrLogBusy, 0);
}
static void ws_attr_log_nt(const char *api, const UNICODE_STRING *us)
{
    if (InterlockedExchange(&g_attrLogBusy, 1) != 0) {
        return;
    }
    if (us && us->Buffer) {
        ws_log("ATTRDBG api=%s path=%.*ls", api, (int)(us->Length / sizeof(wchar_t)), us->Buffer);
    } else {
        ws_log("ATTRDBG api=%s path=<null>", api);
    }
    InterlockedExchange(&g_attrLogBusy, 0);
}

DWORD WINAPI ws_GetFileAttributesW(LPCWSTR lpFileName)
{
    ws_attr_log("GetFileAttributesW", lpFileName); /* R11-D-13d-attr */
    ws_callhit_named("GetFileAttributesW"); /* R11-D-13d */
    if (ws_stat_read_masked(lpFileName)) {
        ws_log("ATTRDBG-W branch=masked in=%ls", lpFileName); /* R11-D-13d-w */
        SetLastError(ERROR_FILE_NOT_FOUND);
        return INVALID_FILE_ATTRIBUTES;
    }
    wchar_t mapped[WS_PATH_MAX];
    int isStaged = 0;
    if (ws_stat_resolve(lpFileName, mapped, WS_PATH_MAX, &isStaged)) {
        ws_log("ATTRDBG-W branch=resolve-fail in=%ls", lpFileName); /* R11-D-13d-w */
        SetLastError(ERROR_FILE_NOT_FOUND);
        return INVALID_FILE_ATTRIBUTES;
    }
    DWORD attrs = ws_real_attrs_w(mapped);
    /* The trace writes the log file, which leaves ERROR_ALREADY_EXISTS in this
     * thread's last error. Save/restore it: callers legitimately read
     * GetLastError after an existence query -- the CLR does exactly that, and with
     * verbose tracing on it aborted startup with "Starting the CLR failed with
     * HRESULT 800700b7" (183, the very value the log write leaves behind). */
    DWORD lastErr = GetLastError();
    WS_TRACE_FILE("GetFileAttributesW mapped=%ls staged=%d -> attrs=0x%lx err=%lu",
                  mapped, isStaged, (unsigned long)attrs, (unsigned long)lastErr);
    ws_log("ATTRDBG-W rc=0 in=%ls mapped=%ls staged=%d attrs=0x%lx err=%lu", lpFileName, mapped, isStaged, (unsigned long)attrs, (unsigned long)lastErr); /* R11-D-13d-w */
    SetLastError(lastErr);
    return attrs;
}

BOOL WINAPI ws_GetFileAttributesExW(LPCWSTR lpFileName, GET_FILEEX_INFO_LEVELS level, LPVOID info)
{
    ws_attr_log("GetFileAttributesExW", lpFileName); /* R11-D-13d-attr */
    ws_callhit_named("GetFileAttributesExW"); /* R11-D-13d */
    if (ws_stat_read_masked(lpFileName)) {
        ws_log("ATTRDBG-ExW branch=masked in=%ls", lpFileName); /* R11-D-13d-w */
        SetLastError(ERROR_FILE_NOT_FOUND);
        return FALSE;
    }
    wchar_t mapped[WS_PATH_MAX];
    int isStaged = 0;
    if (ws_stat_resolve(lpFileName, mapped, WS_PATH_MAX, &isStaged)) {
        ws_log("ATTRDBG-ExW branch=resolve-fail in=%ls", lpFileName); /* R11-D-13d-w */
        SetLastError(ERROR_FILE_NOT_FOUND);
        return FALSE;
    }
    BOOL ok = ws_real_attrs_ex_w(mapped, level, info);
    DWORD lastErr = GetLastError(); /* see ws_GetFileAttributesW: the trace clobbers it */
    WS_TRACE_FILE("GetFileAttributesExW mapped=%ls staged=%d -> ok=%d err=%lu",
                  mapped, isStaged, (int)ok, (unsigned long)lastErr);
    ws_log("ATTRDBG-ExW rc=0 in=%ls mapped=%ls staged=%d ok=%d err=%lu", lpFileName, mapped, isStaged, (int)ok, (unsigned long)lastErr); /* R11-D-13d-w */
    SetLastError(lastErr);
    return ok;
}

DWORD WINAPI ws_GetFileAttributesA(LPCSTR lpFileName)
{
    ws_callhit_named("GetFileAttributesA"); /* R11-D-13d */
    wchar_t wide[WS_PATH_MAX];
    ws_a2w_buf(lpFileName, wide, WS_PATH_MAX);
    ws_attr_log("GetFileAttributesA", wide); /* R11-D-13d-attr */
    if (!wide[0]) {
        return g_orig.GetFileAttributesA(lpFileName);
    }
    return ws_GetFileAttributesW(wide);
}

BOOL WINAPI ws_GetFileAttributesExA(LPCSTR lpFileName, GET_FILEEX_INFO_LEVELS level, LPVOID info)
{
    ws_callhit_named("GetFileAttributesExA"); /* R11-D-13d */
    wchar_t wide[WS_PATH_MAX];
    ws_a2w_buf(lpFileName, wide, WS_PATH_MAX);
    ws_attr_log("GetFileAttributesExA", wide); /* R11-D-13d-attr */
    if (!wide[0]) {
        return g_orig.GetFileAttributesExA(lpFileName, level, info);
    }
    return ws_GetFileAttributesExW(wide, level, info);
}


/* ======================================================================== *
 *  Deletion directives that never cross DeleteFileW / RemoveDirectoryW
 *
 *  Measured (shim log, WINSTAGE_SHIM_VERBOSE=1, injected cmd.exe; see
 *  docs/边界缺陷修复-①TS档删除绕过.md §3):
 *
 *    - `del` / `erase`  -> cmd.exe's own IAT slot for DeleteFileW was patched
 *      (3 sites) and our ws_DeleteFileW was NEVER entered: cmd calls
 *      ntdll!NtOpenFile(DELETE, FILE_DELETE_ON_CLOSE|FILE_NON_DIRECTORY_FILE
 *      |FILE_OPEN_FOR_BACKUP_INTENT) and the kernel deletes the real file when
 *      the handle is closed. No NtSetInformationFile(FileDispositionInformation)
 *      call is involved.
 *    - `ren`            -> MoveFileWithProgressW (a separate export that was not
 *      hooked) -> NtOpenFile + NtSetInformationFile(FileRenameInformation=10).
 *    - `rd` (empty dir) -> RemoveDirectoryW (already hooked; measured working).
 *    - `move /y`        -> MoveFileExW (already hooked; measured working).
 *    - node (libuv) / .NET callers use DeleteFileW and/or
 *      SetFileInformationByHandle(FileDispositionInfo(Ex)) -> kernelbase's
 *      internal NtSetInformationFile.
 *
 *  Everything below funnels into ONE rule: the logical path is recorded as a
 *  deletion (whiteout) in the overlay, the real file is never touched. When the
 *  overlay cannot record it, the call fails (STATUS_ACCESS_DENIED) -- never a
 *  silent write-through. */

#define WS_NT_FILE_DIRECTORY_FILE     0x00000001u
#define WS_NT_FILE_DELETE_ON_CLOSE    0x00001000u
#define WS_FID_DISPOSITION            13u          /* FileDispositionInformation */
#define WS_FID_DISPOSITION_EX         64u          /* FileDispositionInformationEx */
#define WS_FDISPOSITION_FLAG_DELETE   0x00000001u

/* Normalized path behind a file handle (GetFinalPathNameByHandleW). */
static int ws_path_of_handle(HANDLE h, wchar_t *out, DWORD cch)
{
    /* ★ WP13（B9）：`GetFinalPathNameByHandleW` 失败时会改 last error，而本函数
     * 只用一个布尔结果回答"拿到路径没有" ⇒ 入口保存、三条出口还原。 */
    DWORD ws_saved_last_error = GetLastError();
    out[0] = 0;
    if (!h || h == INVALID_HANDLE_VALUE) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    wchar_t raw[WS_PATH_MAX];
    DWORD n = GetFinalPathNameByHandleW(h, raw, WS_PATH_MAX, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (n == 0 || n >= WS_PATH_MAX) {
        n = GetFinalPathNameByHandleW(h, raw, WS_PATH_MAX, VOLUME_NAME_DOS);
        if (n == 0 || n >= WS_PATH_MAX) {
            SetLastError(ws_saved_last_error);
            return 0;
        }
    }
    int ok = ws_normalize_path(raw, out, cch);
    SetLastError(ws_saved_last_error);
    return ok;
}

/* Inverse of the built-in provider's layout (`<root>\fs\C\a\b` -> `C:\a\b`,
 * `<root>\fs\_unc\server\share\x` -> `\\server\share\x`; ws_stage.c:34-73).
 * Needed because a delete directive can arrive on a handle that OUR OWN
 * CreateFileW hook redirected to the staged copy (libuv opens with DELETE and
 * then calls SetFileInformationByHandle), so the handle's path is the staged
 * path and the whiteout must still be written for the logical path. */
static int ws_logical_from_staged(const wchar_t *norm, wchar_t *out, DWORD cch)
{
    if (!g_ws.haveStageRoot || !g_ws.stageRoot[0]) {
        return 0;
    }
    wchar_t prefix[WS_PATH_MAX];
    size_t pos = 0;
    prefix[0] = 0;
    if (!ws_append_w(prefix, WS_PATH_MAX, &pos, g_ws.stageRoot) ||
        !ws_append_w(prefix, WS_PATH_MAX, &pos, L"\\fs\\")) {
        return 0;
    }
    if (!ws_starts_with_ci_w(norm, prefix)) {
        return 0;
    }
    const wchar_t *rest = norm + wcslen(prefix);
    pos = 0;
    out[0] = 0;
    if (ws_starts_with_ci_w(rest, L"_unc\\")) {
        return ws_append_w(out, cch, &pos, L"\\\\") && ws_append_w(out, cch, &pos, rest + 5);
    }
    /* "C\a\b" -> "C:\a\b" (only the drive letter may be a single leading char) */
    if (rest[0] && rest[1] == L'\\') {
        out[pos++] = rest[0];
        out[pos++] = L':';
        out[pos] = 0;
        return ws_append_w(out, cch, &pos, rest + 1);
    }
    return 0;
}

/* Is the REAL directory empty? Mirrors the check in ws_remove_directory_locked:
 * a directory delete must fail exactly like the real API when it is not empty. */
static int ws_real_dir_is_empty(const wchar_t *norm)
{
    /* ★ WP13（B10）：`FindFirstFileW`/`FindNextFileW`/`FindClose` 都会改 last error，
     * 而本函数只返回"空/非空"这一位布尔 ⇒ 入口保存、三条出口还原。 */
    DWORD ws_saved_last_error = GetLastError();
    wchar_t pattern[WS_PATH_MAX];
    size_t pos = 0;
    pattern[0] = 0;
    if (!ws_append_w(pattern, WS_PATH_MAX, &pos, norm) ||
        !ws_append_w(pattern, WS_PATH_MAX, &pos, L"\\*")) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(pattern, &fd);
    if (h == INVALID_HANDLE_VALUE) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    int empty = 1;
    do {
        if (wcscmp(fd.cFileName, L".") != 0 && wcscmp(fd.cFileName, L"..") != 0) {
            empty = 0;
            break;
        }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
    SetLastError(ws_saved_last_error);
    return empty;
}

/* Record "the logical path has been deleted" in the overlay: drop the staged
 * copy (best effort -- the whiteout is authoritative for reads, see
 * dp_file_resolve) and write the whiteout marker. Returns 1 only when the
 * overlay really recorded it. NEVER touches the real file. */
static int ws_record_delete(const wchar_t *norm, int isDir)
{
    /* ★ WP13（B11）：`ws_resolve_file`（provider）/ `GetFileAttributesW` /
     * `RemoveDirectoryW` / `DeleteFileW` / whiteout 都会改 last error；本函数结果由
     * 返回值表达 ⇒ 出口还原。**例外**：`ERROR_DIR_NOT_EMPTY` 是刻意留给调用方的
     * 真实错误，那条出口**不还原**。 */
    DWORD ws_saved_last_error = GetLastError();
    if (!g_wsStage.file_whiteout) {
        ws_log_w(L"fail-closed delete (provider cannot whiteout)", norm);
        SetLastError(ws_saved_last_error);
        return 0;
    }
    if (isDir && !ws_real_dir_is_empty(norm)) {
        /* 刻意不还原：调用方必须看到 ERROR_DIR_NOT_EMPTY */
        SetLastError(ERROR_DIR_NOT_EMPTY);
        return 0;
    }
    wchar_t staged[WS_PATH_MAX];
    uint32_t flags = 0;
    if (ws_resolve_file(norm, WINSTAGE_IO_DELETE, staged, &flags) != 0) {
        ws_log_w(L"fail-closed delete (resolve failed)", norm);
        SetLastError(ws_saved_last_error);
        return 0;
    }
    t_wsFileBusy++;
    DWORD attrs = GetFileAttributesW(staged);
    if (attrs != INVALID_FILE_ATTRIBUTES) {
        if (attrs & FILE_ATTRIBUTE_DIRECTORY) {
            g_orig.RemoveDirectoryW(staged);
        } else {
            g_orig.DeleteFileW(staged);
        }
    }
    t_wsFileBusy--;
    if (g_wsStage.file_whiteout(norm) != 0) {
        ws_log_w(L"fail-closed delete (whiteout write failed)", norm);
        SetLastError(ws_saved_last_error);
        return 0;
    }
    SetLastError(ws_saved_last_error);
    return 1;
}

/* ntdll!NtOpenFile: the FILE_DELETE_ON_CLOSE carrier (`del`/`erase`).
 * The flag is stripped before the real open so the kernel can never delete the
 * real file; the deletion is emulated in the overlay instead. Only recorded
 * when the real open SUCCEEDED, so "delete a file that never existed" stays a
 * plain open failure with no bogus deletion candidate. */
NTSTATUS NTAPI ws_NtOpenFile(PHANDLE FileHandle, ACCESS_MASK DesiredAccess, POBJECT_ATTRIBUTES ObjectAttributes,
                             PIO_STATUS_BLOCK IoStatusBlock, ULONG ShareAccess, ULONG OpenOptions)
{
    ws_attr_log_nt("NtOpenFile", ObjectAttributes ? ObjectAttributes->ObjectName : 0); /* R11-D-13d-attr */
    ws_callhit_named("NtOpenFile"); /* R11-D-13d */
    if (t_wsFileBusy || !(OpenOptions & WS_NT_FILE_DELETE_ON_CLOSE) || !ObjectAttributes ||
        !ObjectAttributes->ObjectName || !ObjectAttributes->ObjectName->Buffer ||
        ObjectAttributes->RootDirectory) {
        return g_orig.NtOpenFile(FileHandle, DesiredAccess, ObjectAttributes, IoStatusBlock, ShareAccess, OpenOptions);
    }
    wchar_t raw[WS_PATH_MAX];
    DWORD cch = ObjectAttributes->ObjectName->Length / sizeof(wchar_t);
    if (cch >= WS_PATH_MAX) {
        cch = WS_PATH_MAX - 1;
    }
    for (DWORD i = 0; i < cch; i++) {
        raw[i] = ObjectAttributes->ObjectName->Buffer[i];
    }
    raw[cch] = 0;
    if (ws_starts_with_ci_w(raw, L"\\??\\")) {
        memmove(raw, raw + 4, (wcslen(raw + 4) + 1) * sizeof(wchar_t));
    }
    wchar_t norm[WS_PATH_MAX];
    if (!ws_should_intercept(raw, norm, WS_PATH_MAX)) {
        return g_orig.NtOpenFile(FileHandle, DesiredAccess, ObjectAttributes, IoStatusBlock, ShareAccess, OpenOptions);
    }
    WS_TRACE_FILE("NtOpenFile delete-on-close request raw=%ls normalized=%ls intercept=1 options=0x%lx",
                  raw, norm, (unsigned long)OpenOptions);
    ULONG stripped = OpenOptions & ~WS_NT_FILE_DELETE_ON_CLOSE;
    NTSTATUS st = g_orig.NtOpenFile(FileHandle, DesiredAccess, ObjectAttributes, IoStatusBlock, ShareAccess, stripped);
    if (st < 0) {
        return st; /* no file -> no whiteout (negative control) */
    }
    DWORD attrs = GetFileAttributesW(norm);
    int isDir = ((attrs != INVALID_FILE_ATTRIBUTES) && (attrs & FILE_ATTRIBUTE_DIRECTORY)) ||
                ((OpenOptions & WS_NT_FILE_DIRECTORY_FILE) != 0);
    if (!ws_record_delete(norm, isDir)) {
        if (FileHandle && *FileHandle) {
            CloseHandle(*FileHandle);
            *FileHandle = NULL;
        }
        if (IoStatusBlock) {
            IoStatusBlock->Status = (NTSTATUS)0xC0000022; /* STATUS_ACCESS_DENIED */
            IoStatusBlock->Information = 0;
        }
        ws_log_w(L"fail-closed NtOpenFile(delete-on-close)", norm);
        return (NTSTATUS)0xC0000022;
    }
    ws_log_w(L"NtOpenFile delete-on-close staged+whiteout", norm);
    return st;
}

/* ntdll!NtSetInformationFile: FileDispositionInformation(13) /
 * FileDispositionInformationEx(64) -- what SetFileInformationByHandle()
 * (kernelbase, libuv, .NET) and kernelbase's own DeleteFileW use internally. */
NTSTATUS NTAPI ws_NtSetInformationFile(HANDLE FileHandle, PIO_STATUS_BLOCK IoStatusBlock, PVOID FileInformation,
                                       ULONG Length, FILE_INFORMATION_CLASS FileInformationClass)
{
    ws_callhit_named("NtSetInformationFile"); /* R11-D-13d */
    ULONG cls = (ULONG)FileInformationClass;
    int wantDelete = 0;
    if (!t_wsFileBusy && FileHandle && cls == WS_FID_DISPOSITION && FileInformation &&
        Length >= sizeof(BOOLEAN)) {
        wantDelete = (*(BOOLEAN *)FileInformation) != 0;
    } else if (!t_wsFileBusy && FileHandle && cls == WS_FID_DISPOSITION_EX && FileInformation &&
               Length >= sizeof(ULONG)) {
        wantDelete = (*(ULONG *)FileInformation & WS_FDISPOSITION_FLAG_DELETE) != 0;
    }
    if (!wantDelete) {
        return g_orig.NtSetInformationFile(FileHandle, IoStatusBlock, FileInformation, Length, FileInformationClass);
    }
    wchar_t path[WS_PATH_MAX], norm[WS_PATH_MAX], logical[WS_PATH_MAX];
    if (!ws_path_of_handle(FileHandle, path, WS_PATH_MAX)) {
        /* Cannot prove the target is out of scope -> fail closed, never guess. */
        ws_log("fail-closed NtSetInformationFile(disposition): cannot resolve the path behind the handle");
        if (IoStatusBlock) {
            IoStatusBlock->Status = (NTSTATUS)0xC0000022;
            IoStatusBlock->Information = 0;
        }
        return (NTSTATUS)0xC0000022;
    }
    int isStagedCopy = 0;
    if (ws_should_intercept(path, norm, WS_PATH_MAX)) {
        /* handle opened on the REAL path (cmd's delete-on-close, NtOpenFile) */
    } else if (ws_logical_from_staged(path, logical, WS_PATH_MAX) &&
               ws_should_intercept(logical, norm, WS_PATH_MAX)) {
        /* handle opened on OUR staged copy (CreateFileW(DELETE) + disposition) */
        isStagedCopy = 1;
    } else {
        return g_orig.NtSetInformationFile(FileHandle, IoStatusBlock, FileInformation, Length, FileInformationClass);
    }
    WS_TRACE_FILE("NtSetInformationFile disposition class=%lu raw=%ls logical=%ls staged=%d",
                  (unsigned long)cls, path, norm, isStagedCopy);
    DWORD attrs = GetFileAttributesW(norm);
    int isDir = (attrs != INVALID_FILE_ATTRIBUTES) && (attrs & FILE_ATTRIBUTE_DIRECTORY);
    if (!ws_record_delete(norm, isDir)) {
        ws_log_w(L"fail-closed NtSetInformationFile(disposition)", norm);
        if (IoStatusBlock) {
            IoStatusBlock->Status = (NTSTATUS)0xC0000022;
            IoStatusBlock->Information = 0;
        }
        return (NTSTATUS)0xC0000022;
    }
    if (IoStatusBlock) {
        IoStatusBlock->Status = 0;
        IoStatusBlock->Information = 0;
    }
    ws_log_w(L"NtSetInformationFile disposition staged+whiteout", norm);
    return 0;
}

/* MoveFileWithProgressW: the export cmd's `ren` really calls (measured). */
BOOL WINAPI ws_MoveFileWithProgressW(LPCWSTR lpExistingFileName, LPCWSTR lpNewFileName,
                                     LPPROGRESS_ROUTINE lpProgressRoutine, LPVOID lpData, DWORD dwFlags)
{
    (void)lpProgressRoutine;
    (void)lpData;
    return ws_move_locked(lpExistingFileName, lpNewFileName, dwFlags);
}


/* ---------------------------------------------------------------- R11-D-13d-gfibh
 * ONE new target: GetFileInformationByHandle (count + per-call rc/err).
 * Safety: NEVER fail-closed -- if the captured original is missing we call the
 * real API directly (this module's own import table is never patched, so the
 * direct call still reaches kernel32). Counting itself does no I/O; the log is
 * LastError-transparent. */
BOOL WINAPI ws_GetFileInformationByHandle(HANDLE hFile, LPVOID lpFileInformation)
{
    ws_callhit_named("GetFileInformationByHandle");
    BOOL ok;
    if (g_orig.GetFileInformationByHandle) {
        ok = g_orig.GetFileInformationByHandle(hFile, lpFileInformation);
    } else {
        ok = GetFileInformationByHandle(hFile, (LPBY_HANDLE_FILE_INFORMATION)lpFileInformation);
    }
    DWORD e = GetLastError();
    ws_log("ATTRDBG-GFIBH seq=%ld handle=%p ok=%d err=%lu", ws_seq(), (void *)hFile, (int)ok, (unsigned long)e); /* R11-D-13d-seq */
    SetLastError(e);
    return ok;
}

/* ---------------------------------------------------------------- R11-D-13d-ntqif
 * ONE new ntdll target: NtQueryInformationFile (count + per-call status).
 * The original is resolved EXPLICITLY from ntdll.dll (lazily, cached); if that
 * fails we call the API directly -- this module's own import table is never
 * patched, so the direct call still reaches ntdll. NEVER fail-closed. */
static NTSTATUS(NTAPI *ws_ntqif_orig)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, int);
static volatile LONG ws_ntqifResolved;

NTSTATUS NTAPI ws_NtQueryInformationFile(HANDLE FileHandle, PIO_STATUS_BLOCK IoStatusBlock,
                                         PVOID FileInformation, ULONG Length, int FileInformationClass)
{
    ws_callhit_named("NtQueryInformationFile");
    if (!ws_ntqif_orig && InterlockedCompareExchange(&ws_ntqifResolved, 1, 0) == 0) {
        HMODULE nt = GetModuleHandleW(L"ntdll.dll");
        if (nt) {
            ws_ntqif_orig = (NTSTATUS(NTAPI *)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, int))
                GetProcAddress(nt, "NtQueryInformationFile");
        }
    }
    NTSTATUS st;
    if (ws_ntqif_orig) {
        st = ws_ntqif_orig(FileHandle, IoStatusBlock, FileInformation, Length, FileInformationClass);
    } else {
        st = NtQueryInformationFile(FileHandle, IoStatusBlock, FileInformation, Length, FileInformationClass);
    }
    ws_log("ATTRDBG-NTQIF seq=%ld handle=%p class=%d status=0x%lx", /* R11-D-13d-seq */
           ws_seq(), (void *)FileHandle, FileInformationClass, (unsigned long)st);
    return st;
}

/* ---------------------------------------------------------------- R11-D-13d-gfibhex
 * ONE new target: GetFileInformationByHandleEx (count + per-call ok/err).
 * NEVER fail-closed: if the captured original is missing we call the real API
 * directly (this module's own import table is never patched). Win32 family =>
 * LastError is saved/restored around the log. */
BOOL WINAPI ws_GetFileInformationByHandleEx(HANDLE hFile, int FileInformationClass,
                                           LPVOID lpFileInformation, DWORD dwBufferSize)
{
    ws_callhit_named("GetFileInformationByHandleEx");
    BOOL ok;
    if (g_orig.GetFileInformationByHandleEx) {
        ok = g_orig.GetFileInformationByHandleEx(hFile, FileInformationClass, lpFileInformation, dwBufferSize);
    } else {
        ok = GetFileInformationByHandleEx(hFile, (FILE_INFO_BY_HANDLE_CLASS)FileInformationClass,
                                          lpFileInformation, dwBufferSize);
    }
    DWORD e = GetLastError();
    ws_log("ATTRDBG-GFIBHEX handle=%p class=%d ok=%d err=%lu",
           (void *)hFile, FileInformationClass, (int)ok, (unsigned long)e);
    SetLastError(e);
    return ok;
}

/* ---------------------------------------------------------------- R11-D-13d-nqaf
 * 线A#1: ONE new ntdll target, NtQueryAttributesFile (count + per-call status).
 * Explicit ntdll resolution, lazy + CAS cached; unresolved => call the API
 * directly => NEVER fail-closed. Declared explicitly: unlike NtQueryInformationFile,
 * winternl.h does NOT declare NtQueryAttributesFile (compile check caught this).
 * Zero path I/O; ntdll family => LastError is NOT wrapped. */
extern NTSTATUS NTAPI NtQueryAttributesFile(POBJECT_ATTRIBUTES, PVOID);
static NTSTATUS(NTAPI *ws_nqaf_orig)(POBJECT_ATTRIBUTES, PVOID);
static volatile LONG ws_nqafResolved;

NTSTATUS NTAPI ws_NtQueryAttributesFile(POBJECT_ATTRIBUTES ObjectAttributes, PVOID FileInformation)
{
    ws_callhit_named("NtQueryAttributesFile");
    if (!ws_nqaf_orig && InterlockedCompareExchange(&ws_nqafResolved, 1, 0) == 0) {
        HMODULE nt = GetModuleHandleW(L"ntdll.dll");
        if (nt) {
            ws_nqaf_orig = (NTSTATUS(NTAPI *)(POBJECT_ATTRIBUTES, PVOID))
                GetProcAddress(nt, "NtQueryAttributesFile");
        }
    }
    NTSTATUS st;
    if (ws_nqaf_orig) {
        st = ws_nqaf_orig(ObjectAttributes, FileInformation);
    } else {
        st = NtQueryAttributesFile(ObjectAttributes, FileInformation);
    }
    const UNICODE_STRING *us = (ObjectAttributes ? ObjectAttributes->ObjectName : 0);
    if (us && us->Buffer) {
        ws_log("ATTRDBG-NQAF pid=%lu handle=%p path=%.*ls status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), (void *)0, (int)(us->Length / sizeof(wchar_t)),
               us->Buffer, (unsigned long)st, (unsigned long)0, ws_seq());
    } else {
        ws_log("ATTRDBG-NQAF pid=%lu handle=%p path=<null> status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), (void *)0, (unsigned long)st, (unsigned long)0, ws_seq());
    }
    return st;
}

/* ---------------------------------------------------------------- R11-D-13d-nqfaf
 * 线A#2: ONE new ntdll target, NtQueryFullAttributesFile (count + per-call status).
 * Same safety contract as NtQueryAttributesFile: explicit ntdll resolution (lazy+CAS),
 * unresolved => direct call => NEVER fail-closed; zero path I/O; no LastError wrap;
 * winternl.h does not declare it either => explicit extern. */
extern NTSTATUS NTAPI NtQueryFullAttributesFile(POBJECT_ATTRIBUTES, PVOID);
static NTSTATUS(NTAPI *ws_nqfaf_orig)(POBJECT_ATTRIBUTES, PVOID);
static volatile LONG ws_nqfafResolved;

NTSTATUS NTAPI ws_NtQueryFullAttributesFile(POBJECT_ATTRIBUTES ObjectAttributes, PVOID FileInformation)
{
    ws_callhit_named("NtQueryFullAttributesFile");
    if (!ws_nqfaf_orig && InterlockedCompareExchange(&ws_nqfafResolved, 1, 0) == 0) {
        HMODULE nt = GetModuleHandleW(L"ntdll.dll");
        if (nt) {
            ws_nqfaf_orig = (NTSTATUS(NTAPI *)(POBJECT_ATTRIBUTES, PVOID))
                GetProcAddress(nt, "NtQueryFullAttributesFile");
        }
    }
    NTSTATUS st;
    if (ws_nqfaf_orig) {
        st = ws_nqfaf_orig(ObjectAttributes, FileInformation);
    } else {
        st = NtQueryFullAttributesFile(ObjectAttributes, FileInformation);
    }
    const UNICODE_STRING *us = (ObjectAttributes ? ObjectAttributes->ObjectName : 0);
    if (us && us->Buffer) {
        ws_log("ATTRDBG-NQFAF pid=%lu handle=%p path=%.*ls status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), (void *)0, (int)(us->Length / sizeof(wchar_t)),
               us->Buffer, (unsigned long)st, (unsigned long)0, ws_seq());
    } else {
        ws_log("ATTRDBG-NQFAF pid=%lu handle=%p path=<null> status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), (void *)0, (unsigned long)st, (unsigned long)0, ws_seq());
    }
    return st;
}

/* ---------------------------------------------------------------- R11-D-13d-nqifbn
 * 线A#3 (last): ONE new ntdll target, NtQueryInformationByName (count + status).
 * Same safety contract: explicit ntdll resolution (lazy+CAS); unresolved => direct
 * call => NEVER fail-closed; zero path I/O; no LastError wrap; explicit extern
 * because winternl.h does not declare it either. */
extern NTSTATUS NTAPI NtQueryInformationByName(POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PVOID, ULONG, int);
static NTSTATUS(NTAPI *ws_nqifbn_orig)(POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PVOID, ULONG, int);
static volatile LONG ws_nqifbnResolved;

NTSTATUS NTAPI ws_NtQueryInformationByName(POBJECT_ATTRIBUTES ObjectAttributes, PIO_STATUS_BLOCK IoStatusBlock,
                                           PVOID FileInformation, ULONG Length, int FileInformationClass)
{
    ws_callhit_named("NtQueryInformationByName");
    if (!ws_nqifbn_orig && InterlockedCompareExchange(&ws_nqifbnResolved, 1, 0) == 0) {
        HMODULE nt = GetModuleHandleW(L"ntdll.dll");
        if (nt) {
            ws_nqifbn_orig = (NTSTATUS(NTAPI *)(POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PVOID, ULONG, int))
                GetProcAddress(nt, "NtQueryInformationByName");
        }
    }
    /* ------------------------------------------------------- R11-D-96-nqifbn
     * 线A#3 overlay 感知（D-FILE-6）：按名查询先问覆盖层，命中才换名。
     *
     * 三条被实测钉死的约束（不要"顺手简化"）：
     *   ① `ObjectName` 常见形态是 NT 名 `\??\C:\...`，而 `GetFullPathNameW` **不剥**
     *      `\??\`：D96 实测它把 `\??\C:\x` 编成 `C:\??\C:\x` ⇒ 必须**先**剥 NT 前缀、
     *      再绝对化，否则解析链永远 no-op；
     *   ② 相对名（`stage0-target.txt`）在 `ws_stat_resolve` 里是 no-op（D95 第 0 步：
     *      `isStaged=0`、`mapped==in`）⇒ 用 CWD 绝对化是必需步骤，不是保险；
     *   ③ `ObjectName` **不保证 NUL 结尾** ⇒ 一律按 `Length` 复制。
     *
     * 安全口径：只有 `isStaged==1`（provider 读分支，**覆盖层副本确实存在**）才换名；
     * whiteout 直接答"不存在"且不调真实 API；其余一切（未命中 / 路径未变 / orig 未解析 /
     * busy / RootDirectory 非空 / 名字为空或超长 / 任何解析失败）**原样透传**——
     * 绝不 fail-closed、绝不伪造成功、绝不就地改写调用方结构；本包装自身零路径 I/O。 */
    wchar_t ws_abs[WS_PATH_MAX];
    wchar_t ws_map[WS_PATH_MAX];
    ws_map[0] = 0;
    int ws_staged = -1; /* -1 = 没走到解析链；0 = 走到但无覆盖层副本；1 = 命中覆盖层 */
    const UNICODE_STRING *ws_us = (ObjectAttributes ? ObjectAttributes->ObjectName : 0);
    if (!t_wsFileBusy && ws_nqifbn_orig && IoStatusBlock && ObjectAttributes && ws_us && ws_us->Buffer &&
        ws_us->Length > 0 && ws_us->Length <= (ULONG)((WS_PATH_MAX - 1) * sizeof(wchar_t)) &&
        ObjectAttributes->RootDirectory == NULL) {
        wchar_t ws_nz[WS_PATH_MAX]; /* 按 Length 取值、补 NUL 后的逻辑名 */
        size_t ws_n = (size_t)(ws_us->Length / sizeof(wchar_t));
        memcpy(ws_nz, ws_us->Buffer, ws_n * sizeof(wchar_t));
        ws_nz[ws_n] = 0;
        /* NT 命名空间 -> Win32（见①；`\\?\` 的剥离仍由解析链里的 ws_normalize_path 负责）。 */
        if (ws_starts_with_ci_w(ws_nz, L"\\??\\UNC\\")) {
            size_t ws_len = wcslen(ws_nz + 8);
            ws_nz[0] = ws_nz[1] = L'\\';
            memmove(ws_nz + 2, ws_nz + 8, (ws_len + 1) * sizeof(wchar_t));
        } else if (ws_starts_with_ci_w(ws_nz, L"\\??\\") &&
                   ((ws_nz[4] >= L'A' && ws_nz[4] <= L'Z') || (ws_nz[4] >= L'a' && ws_nz[4] <= L'z')) &&
                   ws_nz[5] == L':' && (ws_nz[6] == L'\\' || ws_nz[6] == L'/' || ws_nz[6] == 0)) {
            /* 只剥**盘符绝对**形态 `\??\C:\...`：`\??\C:x.txt`（驱动器相对）与
             * `\??\Volume{...}`（卷 GUID）都不剥，落进下面的 NT 命名空间黑名单 ⇒ 透传。 */
            size_t ws_len = wcslen(ws_nz + 4);
            memmove(ws_nz, ws_nz + 4, (ws_len + 1) * sizeof(wchar_t));
        }
        /* 仍留在 NT 命名空间里的名字（`\Device\` / `\\.\` / `\??\` / GLOBALROOT）Win32
         * 解释不了，GetFullPathNameW 只会编出一个假盘符路径 ⇒ 不猜，原样透传。 */
        if (!(ws_starts_with_ci_w(ws_nz, L"\\Device\\") || ws_starts_with_ci_w(ws_nz, L"\\\\.\\") ||
              ws_starts_with_ci_w(ws_nz, L"\\??\\") || ws_starts_with_ci_w(ws_nz, L"\\\\?\\GLOBALROOT"))) {
            /* GetFullPathNameW 会改 last error ⇒ 单点保存/恢复（用法同 ws_mask.c:603）。 */
            DWORD ws_err = GetLastError();
            if (GetFullPathNameW(ws_nz, WS_PATH_MAX, ws_abs, NULL) == 0) {
                ws_strlcpy_w(ws_abs, ws_nz, WS_PATH_MAX);
            }
            SetLastError(ws_err);
            int ws_isStaged = 0;
            if (ws_stat_resolve(ws_abs, ws_map, WS_PATH_MAX, &ws_isStaged)) {
                /* whiteout：按契约直接答"不存在"，**不调真实 API**、不伪造成功。 */
                NTSTATUS ws_gone = (NTSTATUS)0xC0000034L; /* STATUS_OBJECT_NAME_NOT_FOUND */
                IoStatusBlock->Status = ws_gone;
                IoStatusBlock->Information = 0;
                ws_log("ATTRDBG-NQIFBN pid=%lu handle=%p path=%ls mapped=<whiteout> nt=<none> staged=0 status=0x%lx class=%lu seq=%ld",
                       (unsigned long)GetCurrentProcessId(), (void *)0, ws_nz, (unsigned long)ws_gone,
                       (unsigned long)FileInformationClass, ws_seq());
                return ws_gone;
            }
            ws_staged = ws_isStaged;
            if (ws_isStaged && ws_wcscmp_ci(ws_map, ws_abs) != 0) {
                /* ★ D98：交回真实 API 的 ObjectName 必须是 **NT 对象路径**。
                 * 规格 §3 骨架的 `un.Buffer = mapped;`（Win32 `C:\…`）是**缺陷**：
                 * RootDirectory=NULL 时对象管理器把 `C:\…` 当成根下的 `\C:\…`
                 * ⇒ 0xC000003B（STATUS_OBJECT_PATH_SYNTAX_BAD，实测定案）。
                 * 同文件先例 ws_NtOpenFile：`\??\` 只用于自己的判断，交回真实 API 时保持 NT 原名。
                 * 只认三种可安全转换的形态，其它一律不换名、原样透传（绝不猜）。 */
                wchar_t ws_nt[WS_PATH_MAX]; /* 独立缓冲：ws_map 仍要留给 Win32 的 mapped= 日志 */
                size_t ws_ntPos = 0;
                int ws_ntOk = 0;
                ws_nt[0] = 0;
                if (ws_starts_with_ci_w(ws_map, L"\\??\\") && ws_map[4]) {
                    /* 已是 NT 形态：原样使用，不重复加前缀 */
                    ws_ntOk = ws_append_w(ws_nt, WS_PATH_MAX, &ws_ntPos, ws_map);
                } else if (ws_map[0] == L'\\' && ws_map[1] == L'\\' && ws_map[2] &&
                           ws_map[2] != L'?' && ws_map[2] != L'.') {
                    /* 真 UNC：\\server\share\p -> \??\UNC\server\share\p。
                     * `\\?\…`（含 `\\?\Volume{…}` / `\\?\GLOBALROOT…`）与 `\\.\…` 是设备命名空间，
                     * **不**属于此形态 ⇒ 落到下面 ⇒ 不换名、原样透传。 */
                    ws_ntOk = ws_append_w(ws_nt, WS_PATH_MAX, &ws_ntPos, L"\\??\\UNC\\") &&
                              ws_append_w(ws_nt, WS_PATH_MAX, &ws_ntPos, ws_map + 2);
                } else if (((ws_map[0] >= L'A' && ws_map[0] <= L'Z') ||
                            (ws_map[0] >= L'a' && ws_map[0] <= L'z')) &&
                           ws_map[1] == L':' && ws_map[2] == L'\\') {
                    /* 盘符绝对：X:\p -> \??\X:\p（大小写皆可） */
                    ws_ntOk = ws_append_w(ws_nt, WS_PATH_MAX, &ws_ntPos, L"\\??\\") &&
                              ws_append_w(ws_nt, WS_PATH_MAX, &ws_ntPos, ws_map);
                }
                /* 其它一切形态（`\\?\…`、`\\.\…`、`\Device\…`、`\\?\GLOBALROOT`、单 `\` 开头、
                 * 相对名…）都构造不出可信 NT 名 ⇒ ws_ntOk==0 ⇒ 不换名、原样透传。 */
                if (ws_ntOk && ws_ntPos > 0) {
                    /* 本地副本：ObjectName 指向**覆盖层 NT 路径**、RootDirectory=NULL，
                     * 其余字段逐字保留；Length/MaximumLength 按 NT 串重算；调用方结构一字节不动。 */
                    OBJECT_ATTRIBUTES ws_oa = *ObjectAttributes;
                    UNICODE_STRING ws_un;
                    ws_un.Buffer = ws_nt;
                    ws_un.Length = (USHORT)(ws_ntPos * sizeof(wchar_t));
                    ws_un.MaximumLength = (USHORT)(ws_un.Length + sizeof(wchar_t));
                    ws_oa.ObjectName = &ws_un;
                    ws_oa.RootDirectory = NULL;
                    NTSTATUS ws_st = ws_nqifbn_orig(&ws_oa, IoStatusBlock, FileInformation, Length, FileInformationClass);
                    ws_log("ATTRDBG-NQIFBN pid=%lu handle=%p path=%ls mapped=%ls nt=%ls staged=1 status=0x%lx class=%lu seq=%ld",
                           (unsigned long)GetCurrentProcessId(), (void *)0, ws_nz, ws_map, ws_nt,
                           (unsigned long)ws_st, (unsigned long)FileInformationClass, ws_seq());
                    return ws_st;
                }
                /* 无法安全构造 NT 形态 ⇒ 不换名、原样透传（日志 staged=1 / nt=<none> 可区分）。 */
            }
        }
    }

    NTSTATUS st;
    if (ws_nqifbn_orig) {
        st = ws_nqifbn_orig(ObjectAttributes, IoStatusBlock, FileInformation, Length, FileInformationClass);
    } else {
        st = NtQueryInformationByName(ObjectAttributes, IoStatusBlock, FileInformation, Length, FileInformationClass);
    }
    const UNICODE_STRING *us = (ObjectAttributes ? ObjectAttributes->ObjectName : 0);
    const wchar_t *ws_map_log = (ws_staged >= 0 && ws_map[0]) ? ws_map : L"<none>";
    if (us && us->Buffer) {
        ws_log("ATTRDBG-NQIFBN pid=%lu handle=%p path=%.*ls mapped=%ls nt=<none> staged=%d status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), (void *)0, (int)(us->Length / sizeof(wchar_t)),
               us->Buffer, ws_map_log, ws_staged, (unsigned long)st, (unsigned long)FileInformationClass,
               ws_seq());
    } else {
        ws_log("ATTRDBG-NQIFBN pid=%lu handle=%p path=<null> mapped=%ls nt=<none> staged=%d status=0x%lx class=%lu seq=%ld",
               (unsigned long)GetCurrentProcessId(), (void *)0, ws_map_log, ws_staged, (unsigned long)st,
               (unsigned long)FileInformationClass, ws_seq());
    }
    return st;
}
