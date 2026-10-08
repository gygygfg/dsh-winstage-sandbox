/* WinStageSandbox -- T4 shim: T3-aligned registry staging core.
 *
 * Implements the C ABI from docs/T3-??md ?4 and the registry storage
 * backend it implies:
 *   <sessionDir>\registry\overlay.hive      app hive, loaded with RegLoadAppKeyW
 *   <sessionDir>\registry\overlay.journal   WAL, 32-byte packed header + payloads
 *   <sessionDir>\registry\overlay.state.json, overlay.discarded.journal  (host side)
 *
 * sessionDir is the `stageRoot` argument, or the DSH_REGSTAGE_ROOT environment
 * variable when the argument is NULL. This mirrors T3's resolveRegistryStage*()
 * pure functions (src/registry-stage.mjs). The shim does NOT keep a second
 * registry storage: the app hive IS the overlay and the journal IS the audit /
 * approval record the host reads.
 *
 * WAL-first is enforced here: every storage mutation is preceded by a flushed
 * journal append, and a failed append makes the caller fail.
 */
#include "winstage_internal.h"

#include <winreg.h>
#include <aclapi.h>
#include <sddl.h>

/* mingw's winreg.h declares RegLoadAppKeyW for _WIN32_WINNT >= 0x0600; Zig's
 * default target is 0x0603, but declare it defensively so this file also
 * compiles if a different SDK definition is in play. Identical declarations are
 * legal C. */
WINADVAPI LSTATUS WINAPI RegLoadAppKeyW(LPCWSTR lpFile, PHKEY phkResult, REGSAM samDesired,
                                        DWORD dwOptions, DWORD Reserved);

#pragma pack(push, 4)
typedef struct DSH_REG_STAGE_RECORD {
    UINT32 magic;      /*  0  'DSRG' = 0x47525344 (bytes 44 53 52 47) */
    UINT16 version;    /*  4  = 1 */
    UINT16 kind;       /*  6  1 CREATE_KEY 2 DELETE_KEY 3 SET_VALUE 4 DELETE_VALUE 5 HARD_DENY 6 UNSTAGED */
    UINT16 type;       /*  8  REG_* (SET_VALUE only); UNSTAGED: 1..4 = why it could not be staged */
    UINT16 flags;      /* 10  bitmask */
    UINT32 pathChars;  /* 12  UTF-16 code units, excluding NUL */
    UINT32 nameChars;  /* 16  UTF-16 code units, excluding NUL */
    UINT32 dataBytes;  /* 20 */
    UINT32 status;     /* 24  LSTATUS (HARD_DENY only; UNSTAGED keeps 0 = "we did not deny you") */
    UINT32 reserved;   /* 28  must be 0 */
} DSH_REG_STAGE_RECORD;

typedef struct DSH_REG_STAGE_STATE {
    UINT32 size;
    UINT32 abiVersion;
    UINT32 hiveLoaded;
    UINT32 journalOpen;
    UINT64 rootKey;
    UINT32 recordsAppended;
    UINT32 lastStatus;
} DSH_REG_STAGE_STATE;
#pragma pack(pop)

#define DSH_WAL_MAGIC   0x47525344u
#define DSH_WAL_VERSION 1u

#define DSH_KIND_CREATE_KEY   1
#define DSH_KIND_DELETE_KEY   2
#define DSH_KIND_SET_VALUE    3
#define DSH_KIND_DELETE_VALUE 4
#define DSH_KIND_HARD_DENY    5
/* kind 6 (T3 contract v1.4): "the overlay cannot represent this call", so it was
 * handed to the real API. NOT a denial -- status stays 0 -- and it must never be
 * replayed (the call already reached the real system). See REG_STAGE_KIND.UNSTAGED. */
#define DSH_KIND_UNSTAGED     6

#define DSH_FLAG_HARD_DENY     0x0001
#define DSH_FLAG_HAS_VALUE_NAME 0x0002
#define DSH_FLAG_HAS_DATA       0x0004
#define DSH_FLAG_VOLATILE       0x0008
#define DSH_FLAG_UNSTAGED       0x0010

/* UNSTAGED reason codes (must equal REG_STAGE_UNSTAGED_REASON in
 * src/registry-stage.mjs; they travel in the record's `type` field). */
#define DSH_UNSTAGED_WOW64_32KEY               1
#define DSH_UNSTAGED_WOW64_VIEW_IN_WOW64_PROC 2
#define DSH_UNSTAGED_UNRESOLVABLE_BASE_HANDLE  3
#define DSH_UNSTAGED_BARE_HIVE_ROOT            4

#define DSH_REG_PROCESS_APPKEY 0x00000001u
#define DSH_REG_USE_CURRENT_SECURITY_CONTEXT 0x00000002u

typedef struct WsT3 {
    int attached;
    wchar_t sessionDir[WS_PATH_MAX];
    wchar_t regRoot[WS_PATH_MAX];
    wchar_t hivePath[WS_PATH_MAX];
    /* Per-process fallback hive (`overlay.<pid>.hive`). See t3_build_paths():
     * REG_PROCESS_APPKEY makes ONE hive file loadable by ONE process at a time,
     * and every injected child calls DshRegStageAttach, so the fixed name is
     * unusable as soon as a command spawns a second process. */
    wchar_t hiveFallbackPath[WS_PATH_MAX];
    int hiveIsFallback;
    wchar_t journalPath[WS_PATH_MAX];
    wchar_t sessionId[256];
    HANDLE journal;
    HKEY root;
    UINT32 recordsAppended;
    LSTATUS lastStatus;
    /* defect 4: was a non-reentrant `volatile LONG lock`. This lock must guard
     * the WAL transaction (SetFilePointer + several WriteFile + Flush) as one
     * unit, because LockFileEx only serializes *across* processes -- two threads
     * of one process both hold the same file lock -- so the in-process lock is
     * required around the I/O. It is now reentrant + bounded. */
    WsLock lock;
} WsT3;

static WsT3 g_t3;

int ws_t3_is_attached(void)
{
    return g_t3.attached && g_t3.journal != NULL && g_t3.root != NULL;
}

HKEY ws_t3_hive_root(void)
{
    return g_t3.root;
}

const wchar_t *ws_t3_session_dir(void)
{
    return g_t3.sessionDir;
}

UINT32 ws_t3_records_appended(void)
{
    return g_t3.recordsAppended;
}

LSTATUS ws_t3_last_status(void)
{
    return g_t3.lastStatus;
}

/* Grant the current user full control of the hive file (best effort: the file is
 * created by us, so this normally just removes an inherited restriction). */
static void t3_grant_full_control(const wchar_t *file)
{
    /* ★ WP13（A8）：`ConvertStringSidToSidW` / `SetEntriesInAclW` /
     * `SetNamedSecurityInfoW` / `LocalFree` 都会改调用线程的 last error，
     * 而本函数是纯副作用函数（无返回值）⇒ 入口保存、三条出口还原。 */
    DWORD ws_saved_last_error = GetLastError();
    wchar_t sidString[256];
    if (!ws_current_user_sid()[0]) {
        SetLastError(ws_saved_last_error);
        return;
    }
    ws_strlcpy_w(sidString, ws_current_user_sid(), 256);
    PSID sid = NULL;
    if (!ConvertStringSidToSidW(sidString, &sid)) {
        SetLastError(ws_saved_last_error);
        return;
    }
    EXPLICIT_ACCESS_W ea;
    memset(&ea, 0, sizeof(ea));
    ea.grfAccessPermissions = GENERIC_ALL;
    ea.grfAccessMode = SET_ACCESS;
    ea.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    ea.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    ea.Trustee.TrusteeType = TRUSTEE_IS_USER;
    ea.Trustee.ptstrName = (LPWSTR)sid;
    PACL acl = NULL;
    if (SetEntriesInAclW(1, &ea, NULL, &acl) == ERROR_SUCCESS && acl) {
        DWORD rc = SetNamedSecurityInfoW((LPWSTR)file, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                         NULL, NULL, acl, NULL);
        if (rc != ERROR_SUCCESS) {
            ws_log("t3_grant_full_control: SetNamedSecurityInfo failed %lu", (unsigned long)rc);
        }
        LocalFree(acl);
    }
    LocalFree(sid);
    SetLastError(ws_saved_last_error);
}

/* Decimal wide formatting without pulling in the CRT's wide printf (the shim
 * only needs an unsigned long here, and this keeps the dependency surface flat). */
static void t3_u32_to_dec(unsigned long value, wchar_t *out, size_t cch)
{
    wchar_t tmp[24];
    size_t n = 0;
    size_t i;
    if (cch == 0) {
        return;
    }
    if (value == 0) {
        tmp[n++] = L'0';
    }
    while (value > 0 && n < (sizeof(tmp) / sizeof(tmp[0]))) {
        tmp[n++] = (wchar_t)(L'0' + (value % 10));
        value /= 10;
    }
    if (n >= cch) {
        n = cch - 1;
    }
    for (i = 0; i < n; i++) {
        out[i] = tmp[n - 1 - i];
    }
    out[n] = 0;
}

static int t3_build_paths(const wchar_t *sessionDir)
{
    size_t pos = 0;
    g_t3.lock.name = "t3reg"; /* literal: WsLock.name has static lifetime */
    ws_strlcpy_w(g_t3.sessionDir, sessionDir, WS_PATH_MAX);
    g_t3.regRoot[0] = 0;
    if (!ws_append_w(g_t3.regRoot, WS_PATH_MAX, &pos, sessionDir) ||
        !ws_append_w(g_t3.regRoot, WS_PATH_MAX, &pos, L"\\registry")) {
        return 0;
    }
    pos = 0;
    g_t3.hivePath[0] = 0;
    if (!ws_append_w(g_t3.hivePath, WS_PATH_MAX, &pos, g_t3.regRoot) ||
        !ws_append_w(g_t3.hivePath, WS_PATH_MAX, &pos, L"\\overlay.hive")) {
        return 0;
    }
    /* Per-process fallback hive — the fix for "registry write hard-denies in a
     * child process" (defect: `pwsh` -> `reg.exe` failed with
     * `ERROR: Access is denied.` while the journal stayed 0 bytes).
     *
     * Why the fixed name is not enough: `DSH_REG_PROCESS_APPKEY` gives the hive
     * per-process semantics, and Windows then refuses a second RegLoadAppKeyW on
     * the SAME file from another process with ERROR_SHARING_VIOLATION (32). Since
     * fix ① the shim self-injects every child, so a plain command tree
     * (`powershell.exe` -> `reg.exe`) has >= 2 attach attempts: the first process
     * wins the file, every later one fails to attach and — because this layer is
     * fail-closed — hard-denies all of its registry writes. The child is exactly
     * the process that writes in `reg add`, so the write never reaches the WAL.
     *
     * Why a per-process hive is contract-equivalent: the hive is only this
     * process's read-back view ("能读回自己写的值"); the durable, cross-process
     * truth is the SHARED append-only `overlay.journal`, which the host consumes
     * to build candidates. The fixed name is still tried first, so the
     * single-process shape (and every existing artifact/test) is unchanged. */
    pos = 0;
    g_t3.hiveFallbackPath[0] = 0;
    if (!ws_append_w(g_t3.hiveFallbackPath, WS_PATH_MAX, &pos, g_t3.regRoot) ||
        !ws_append_w(g_t3.hiveFallbackPath, WS_PATH_MAX, &pos, L"\\overlay.")) {
        return 0;
    }
    {
        wchar_t pidText[24];
        t3_u32_to_dec((unsigned long)GetCurrentProcessId(), pidText, sizeof(pidText) / sizeof(pidText[0]));
        if (!ws_append_w(g_t3.hiveFallbackPath, WS_PATH_MAX, &pos, pidText) ||
            !ws_append_w(g_t3.hiveFallbackPath, WS_PATH_MAX, &pos, L".hive")) {
            return 0;
        }
    }
    pos = 0;
    g_t3.journalPath[0] = 0;
    if (!ws_append_w(g_t3.journalPath, WS_PATH_MAX, &pos, g_t3.regRoot) ||
        !ws_append_w(g_t3.journalPath, WS_PATH_MAX, &pos, L"\\overlay.journal")) {
        return 0;
    }
    return 1;
}

/* ------------------------------------------------- 死进程的 per-process hive 清扫
 *
 * `t3_build_paths()` 在共享 `overlay.hive` 不可用时会退回**每进程**的
 * `overlay.<pid>.hive`（理由见上面那段长注释）。`DshRegStageDetach()` 只在**干净退出**
 * 时删除它；被强杀/超时的进程会把 hive（以及 `.LOG1`/`.LOG2`）永久留下 ——
 * 实测一次 `--keep-stage` 运行就堆了 **100+ 个**。长会话会无界增长。
 *
 * 因此每次 attach 都清扫一次：**只删已死进程**的 hive。判活刻意保守：
 *   · 只认严格匹配 `overlay.<数字>.hive` 的名字（共享的 `overlay.hive` 绝不碰）；
 *   · 跳过自己的 pid；
 *   · `OpenProcess` 成功 ⇒ 活着 ⇒ 保留；失败但**不是** `ERROR_INVALID_PARAMETER`
 *     （例如对活进程没有权限 → `ACCESS_DENIED`）⇒ **一律保留**，绝不在不确定时删。 */
static int t3_is_dead_pid(unsigned long pid)
{
    HANDLE proc = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)pid);
    if (proc) {
        CloseHandle(proc);
        return 0;
    }
    return GetLastError() == ERROR_INVALID_PARAMETER;
}

static void t3_delete_hive_set(const wchar_t *baseName)
{
    static const wchar_t *suffixes[] = { L"", L".LOG1", L".LOG2" };
    for (size_t i = 0; i < sizeof(suffixes) / sizeof(suffixes[0]); i++) {
        wchar_t full[WS_PATH_MAX];
        size_t pos = 0;
        full[0] = 0;
        if (!ws_append_w(full, WS_PATH_MAX, &pos, g_t3.regRoot) ||
            !ws_append_w(full, WS_PATH_MAX, &pos, L"\\") ||
            !ws_append_w(full, WS_PATH_MAX, &pos, baseName) ||
            !ws_append_w(full, WS_PATH_MAX, &pos, suffixes[i])) {
            continue;
        }
        DeleteFileW(full);
    }
}

static int t3_sweep_stale_hives(void)
{
    if (!g_t3.regRoot[0]) {
        return 0;
    }
    wchar_t pattern[WS_PATH_MAX];
    size_t pos = 0;
    pattern[0] = 0;
    if (!ws_append_w(pattern, WS_PATH_MAX, &pos, g_t3.regRoot) ||
        !ws_append_w(pattern, WS_PATH_MAX, &pos, L"\\overlay.*.hive")) {
        return 0;
    }
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(pattern, &fd);
    if (h == INVALID_HANDLE_VALUE) {
        return 0;
    }
    unsigned long self = (unsigned long)GetCurrentProcessId();
    int removed = 0;
    do {
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            continue;
        }
        if (!ws_starts_with_ci_w(fd.cFileName, L"overlay.")) {
            continue;
        }
        const wchar_t *p = fd.cFileName + 8; /* 跳过 "overlay." */
        unsigned long pid = 0;
        size_t digits = 0;
        while (p[digits] >= L'0' && p[digits] <= L'9') {
            pid = pid * 10 + (unsigned long)(p[digits] - L'0');
            digits++;
        }
        if (digits == 0 || wcscmp(p + digits, L".hive") != 0) {
            continue;
        }
        if (pid == 0 || pid == self) {
            continue;
        }
        if (!t3_is_dead_pid(pid)) {
            continue;
        }
        t3_delete_hive_set(fd.cFileName);
        removed++;
    } while (FindNextFileW(h, &fd));
    FindClose(h);
    return removed;
}

/* ------------------------------------------------------------------ exports */

UINT32 __cdecl DshRegStageAbiVersion(void)
{
    return 1;
}

LSTATUS __cdecl DshRegStageAttach(const wchar_t *stageRoot, const wchar_t *sessionId)
{
    /* ★ WP13（A7）：本函数是**初始化期**（`ws_init_full` → 每条命令的子进程）
     * 必经之路，内部逐句调用 `GetEnvironmentVariableW` / `ws_ensure_dirs` /
     * `ws_open_file_raw` / `GetFileAttributesW` / `RegLoadAppKeyW` / `CloseHandle`，
     * 每一个都会覆写调用线程的 last error；而本函数的结果由**返回值 + g_t3.lastStatus**
     * 表达 ⇒ 入口保存、七条出口全部还原，对调用方透明。
     * 注意 `:306` 的 `g_t3.lastStatus = GetLastError()` 必须在**还原之前**取值。 */
    DWORD ws_saved_last_error = GetLastError();
    wchar_t sessionDir[WS_PATH_MAX];
    if (stageRoot && stageRoot[0]) {
        ws_strlcpy_w(sessionDir, stageRoot, WS_PATH_MAX);
    } else {
        sessionDir[0] = 0;
        DWORD n = GetEnvironmentVariableW(L"DSH_REGSTAGE_ROOT", sessionDir, WS_PATH_MAX);
        if (n == 0 || n >= WS_PATH_MAX) {
            g_t3.lastStatus = ERROR_BAD_CONFIGURATION;
            SetLastError(ws_saved_last_error);
            return g_t3.lastStatus;
        }
    }
    if (sessionId) {
        ws_strlcpy_w(g_t3.sessionId, sessionId, 256);
    }

    if (g_t3.attached) {
        /* Idempotent: same session directory means nothing to do. REG_PROCESS_APPKEY
         * makes a second RegLoadAppKey on the same file fail with
         * ERROR_SHARING_VIOLATION, so re-attaching must never reload. */
        if (ws_wcscmp_ci(g_t3.sessionDir, sessionDir) == 0) {
            SetLastError(ws_saved_last_error);
            return ERROR_SUCCESS;
        }
        DshRegStageDetach();
    }

    if (!t3_build_paths(sessionDir)) {
        g_t3.lastStatus = ERROR_INVALID_PARAMETER;
        SetLastError(ws_saved_last_error);
        return g_t3.lastStatus;
    }
    if (!ws_ensure_dirs(g_t3.regRoot, 1)) {
        g_t3.lastStatus = ERROR_PATH_NOT_FOUND;
        SetLastError(ws_saved_last_error);
        return g_t3.lastStatus;
    }
    {
        /* ★ 卫生项：清掉已死进程留下的 per-process hive（见 t3_sweep_stale_hives 的说明）。
         * 放在"目录已确保存在"之后、加载 hive 之前。 */
        int swept = t3_sweep_stale_hives();
        if (swept > 0) {
            ws_log("DshRegStageAttach: swept %lu stale per-process hive(s)", (unsigned long)swept);
        }
    }

    g_t3.journal = ws_open_file_raw(g_t3.journalPath, GENERIC_WRITE | GENERIC_READ,
                                    FILE_SHARE_READ | FILE_SHARE_WRITE, OPEN_ALWAYS);
    if (g_t3.journal == INVALID_HANDLE_VALUE) {
        g_t3.journal = NULL;
        g_t3.lastStatus = GetLastError();
        SetLastError(ws_saved_last_error);
        return g_t3.lastStatus;
    }

    g_t3.root = NULL;
    /* The hive file inherits the parent directory's DACL. If that DACL does not
     * grant this process full control, RegLoadAppKeyW succeeds but every
     * RegCreateKeyExW inside the hive fails with ERROR_ACCESS_DENIED -- which is
     * exactly how "reg add" broke. Normalise the file's DACL first, and also ask
     * RegLoadAppKeyW to use the current security context. */
    if (GetFileAttributesW(g_t3.hivePath) != INVALID_FILE_ATTRIBUTES) {
        t3_grant_full_control(g_t3.hivePath);
    }
    g_t3.hiveIsFallback = 0;
    LSTATUS st = RegLoadAppKeyW(g_t3.hivePath, &g_t3.root, KEY_ALL_ACCESS,
                                DSH_REG_PROCESS_APPKEY, 0);
    if (st != ERROR_SUCCESS) {
        /* Contended (or otherwise unusable) shared hive ⇒ fall back to THIS
         * process's own hive and keep the shared journal. Rationale and the
         * reproduced defect are documented in t3_build_paths(). */
        LSTATUS primaryStatus = st;
        if (GetFileAttributesW(g_t3.hiveFallbackPath) != INVALID_FILE_ATTRIBUTES) {
            t3_grant_full_control(g_t3.hiveFallbackPath);
        }
        g_t3.root = NULL;
        st = RegLoadAppKeyW(g_t3.hiveFallbackPath, &g_t3.root, KEY_ALL_ACCESS,
                            DSH_REG_PROCESS_APPKEY, 0);
        if (st == ERROR_SUCCESS) {
            g_t3.hiveIsFallback = 1;
            ws_log("DshRegStageAttach: shared hive unusable (%lu) -> per-process hive=%ls "
                   "(journal stays shared: %ls)",
                   (unsigned long)primaryStatus, g_t3.hiveFallbackPath, g_t3.journalPath);
        } else {
            CloseHandle(g_t3.journal);
            g_t3.journal = NULL;
            g_t3.root = NULL;
            g_t3.lastStatus = st;
            SetLastError(ws_saved_last_error);
            return st;
        }
    }
    g_t3.attached = 1;
    g_t3.lastStatus = ERROR_SUCCESS;
    ws_log("DshRegStageAttach: sessionDir=%ls hive=%ls journal=%ls (existing records=%lu)",
           g_t3.sessionDir, g_t3.hiveIsFallback ? g_t3.hiveFallbackPath : g_t3.hivePath,
           g_t3.journalPath, (unsigned long)g_t3.recordsAppended);
    SetLastError(ws_saved_last_error);
    return ERROR_SUCCESS;
}

LSTATUS __cdecl DshRegStageDetach(void)
{
    /* ★ WP13（A9）：`RegCloseKey`（g_orig）/ `CloseHandle` / `DeleteFileW` 都会改
     * 调用线程的 last error；本函数结果由返回值表达（且刻意"best effort"）⇒ 出口还原。 */
    DWORD ws_saved_last_error = GetLastError();
    if (g_t3.root) {
        g_orig.RegCloseKey(g_t3.root);
        g_t3.root = NULL;
    }
    if (g_t3.journal) {
        CloseHandle(g_t3.journal);
        g_t3.journal = NULL;
    }
    /* Drop this process's private hive: it is derived state (the journal is the
     * durable artifact) and leaving one file per pid behind would leak without
     * bound across a long session. Best effort only — a failure to delete must
     * never turn into a spurious error. */
    if (g_t3.hiveIsFallback && g_t3.hiveFallbackPath[0]) {
        if (DeleteFileW(g_t3.hiveFallbackPath)) {
            ws_log("DshRegStageDetach: removed per-process hive=%ls", g_t3.hiveFallbackPath);
        } else {
            ws_log("DshRegStageDetach: could not remove per-process hive=%ls (err=%lu)",
                   g_t3.hiveFallbackPath, (unsigned long)GetLastError());
        }
        g_t3.hiveIsFallback = 0;
    }
    g_t3.attached = 0;
    SetLastError(ws_saved_last_error);
    return ERROR_SUCCESS;
}

static LSTATUS t3_journal_append_inner(const void *recordRaw, const wchar_t *path,
                                       const wchar_t *valueName, const void *data,
                                       UINT32 *outBytesWritten);

/* ★ WP13（A10）：本函数有 **10 条校验出口**，每条都在 `g_t3.lastStatus`/
 * `GetLastError()` 形态下返回；与其在每条出口插一行还原，这里用**薄包装**做
 * 一次"入口保存 / 出口还原"，语义等价且只改一处（内部实现改名 `*_inner`）。
 * 理由：`LockFileEx`/`SetFilePointer`/`WriteFile`/`FlushFileBuffers` 都会覆写
 * 调用线程的 last error，而本函数的结果由**返回值 + outBytesWritten** 表达。 */
LSTATUS __cdecl DshRegStageJournalAppend(const void *recordRaw, const wchar_t *path,
                                         const wchar_t *valueName, const void *data,
                                         UINT32 *outBytesWritten)
{
    DWORD ws_saved_last_error = GetLastError();
    LSTATUS rc = t3_journal_append_inner(recordRaw, path, valueName, data, outBytesWritten);
    SetLastError(ws_saved_last_error);
    return rc;
}

static LSTATUS t3_journal_append_inner(const void *recordRaw, const wchar_t *path,
                                       const wchar_t *valueName, const void *data,
                                       UINT32 *outBytesWritten)
{
    const DSH_REG_STAGE_RECORD *record = (const DSH_REG_STAGE_RECORD *)recordRaw;
    if (outBytesWritten) {
        *outBytesWritten = 0;
    }
    if (!g_t3.attached || !g_t3.journal || !record) {
        g_t3.lastStatus = ERROR_INVALID_HANDLE;
        return g_t3.lastStatus;
    }
    if (record->magic != DSH_WAL_MAGIC || record->version != DSH_WAL_VERSION ||
        record->reserved != 0 || record->kind < 1 || record->kind > DSH_KIND_UNSTAGED) {
        g_t3.lastStatus = ERROR_INVALID_PARAMETER;
        return g_t3.lastStatus;
    }
    /* kind/flag combinations are part of the contract, so a wrong record is
     * rejected here instead of being written and discovered by the host:
     *   HARD_DENY must carry the real non-zero LSTATUS we hand back;
     *   UNSTAGED must carry a reason code, must NOT carry a value, and its
     *   status must stay 0 (nothing was denied -- it was passed to the real API). */
    if (record->kind == DSH_KIND_HARD_DENY) {
        if ((record->flags & DSH_FLAG_HARD_DENY) == 0 || record->status == 0) {
            g_t3.lastStatus = ERROR_INVALID_PARAMETER;
            return g_t3.lastStatus;
        }
    }
    if (record->kind == DSH_KIND_UNSTAGED) {
        if ((record->flags & DSH_FLAG_UNSTAGED) == 0 ||
            record->type < DSH_UNSTAGED_WOW64_32KEY || record->type > DSH_UNSTAGED_BARE_HIVE_ROOT ||
            record->status != 0 || record->nameChars != 0 || record->dataBytes != 0) {
            g_t3.lastStatus = ERROR_INVALID_PARAMETER;
            return g_t3.lastStatus;
        }
    }
    /* The header's counts must match the buffers -- re-validated here so a
     * caller bug cannot produce a journal the host would mis-parse. */
    if (!path && record->pathChars != 0) {
        g_t3.lastStatus = ERROR_INVALID_PARAMETER;
        return g_t3.lastStatus;
    }
    if (record->pathChars) {
        size_t actual = wcslen(path ? path : L"");
        if (actual != record->pathChars || actual > 0x4000) {
            g_t3.lastStatus = ERROR_INVALID_PARAMETER;
            return g_t3.lastStatus;
        }
    }
    if (record->nameChars) {
        size_t actual = wcslen(valueName ? valueName : L"");
        if (actual != record->nameChars || actual > 0x4000) {
            g_t3.lastStatus = ERROR_INVALID_PARAMETER;
            return g_t3.lastStatus;
        }
    }
    if (record->dataBytes && !data) {
        g_t3.lastStatus = ERROR_INVALID_PARAMETER;
        return g_t3.lastStatus;
    }
    if (record->dataBytes > 16u * 1024u * 1024u) {
        g_t3.lastStatus = ERROR_INVALID_PARAMETER;
        return g_t3.lastStatus;
    }

    ws_lock_enter(&g_t3.lock);
    LSTATUS st = ERROR_SUCCESS;
    OVERLAPPED ov;
    memset(&ov, 0, sizeof(ov));
    /* Serialize across processes: the WAL is shared by every sandboxed process of
     * the session (T3 ?3: two processes load the same app hive). */
    if (!LockFileEx(g_t3.journal, LOCKFILE_EXCLUSIVE_LOCK, 0, MAXDWORD, MAXDWORD, &ov)) {
        st = GetLastError();
    } else {
        if (SetFilePointer(g_t3.journal, 0, NULL, FILE_END) == INVALID_SET_FILE_POINTER &&
            GetLastError() != NO_ERROR) {
            st = GetLastError();
        }
        DWORD wrote = 0;
        if (st == ERROR_SUCCESS) {
            if (!WriteFile(g_t3.journal, record, (DWORD)sizeof(DSH_REG_STAGE_RECORD), &wrote, NULL) ||
                wrote != (DWORD)sizeof(DSH_REG_STAGE_RECORD)) {
                st = GetLastError() ? GetLastError() : ERROR_WRITE_FAULT;
            }
        }
        if (st == ERROR_SUCCESS && record->pathChars) {
            DWORD bytes = record->pathChars * (DWORD)sizeof(wchar_t);
            if (!WriteFile(g_t3.journal, path, bytes, &wrote, NULL) || wrote != bytes) {
                st = GetLastError() ? GetLastError() : ERROR_WRITE_FAULT;
            }
        }
        if (st == ERROR_SUCCESS && record->nameChars) {
            DWORD bytes = record->nameChars * (DWORD)sizeof(wchar_t);
            if (!WriteFile(g_t3.journal, valueName, bytes, &wrote, NULL) || wrote != bytes) {
                st = GetLastError() ? GetLastError() : ERROR_WRITE_FAULT;
            }
        }
        if (st == ERROR_SUCCESS && record->dataBytes) {
            if (!WriteFile(g_t3.journal, data, record->dataBytes, &wrote, NULL) ||
                wrote != record->dataBytes) {
                st = GetLastError() ? GetLastError() : ERROR_WRITE_FAULT;
            }
        }
        if (st == ERROR_SUCCESS && !FlushFileBuffers(g_t3.journal)) {
            st = GetLastError();
        }
        OVERLAPPED uov;
        memset(&uov, 0, sizeof(uov));
        UnlockFileEx(g_t3.journal, 0, MAXDWORD, MAXDWORD, &uov);
    }
    ws_lock_leave(&g_t3.lock);

    if (st == ERROR_SUCCESS) {
        g_t3.recordsAppended++;
        if (outBytesWritten) {
            *outBytesWritten = (UINT32)sizeof(DSH_REG_STAGE_RECORD) +
                               record->pathChars * 2u + record->nameChars * 2u + record->dataBytes;
        }
    } else {
        ws_log("DshRegStageJournalAppend failed: %lu (path=%ls)", (unsigned long)st, path);
    }
    g_t3.lastStatus = st;
    return st;
}

LSTATUS __cdecl DshRegStageAttachState(void *outRaw)
{
    DSH_REG_STAGE_STATE *out = (DSH_REG_STAGE_STATE *)outRaw;
    if (!out || out->size < sizeof(DSH_REG_STAGE_STATE)) {
        return ERROR_INVALID_PARAMETER;
    }
    out->abiVersion = 1;
    out->hiveLoaded = g_t3.root ? 1 : 0;
    out->journalOpen = g_t3.journal ? 1 : 0;
    out->rootKey = (UINT64)(ULONG_PTR)g_t3.root;
    out->recordsAppended = g_t3.recordsAppended;
    out->lastStatus = g_t3.lastStatus;
    return ERROR_SUCCESS;
}

/* -------------------------------------------------- record-building helpers */

static LSTATUS t3_append(UINT16 kind, UINT16 type, UINT16 flags, const wchar_t *canonical,
                         const wchar_t *valueName, const void *data, UINT32 dataBytes, UINT32 status)
{
    DSH_REG_STAGE_RECORD rec;
    memset(&rec, 0, sizeof(rec));
    rec.magic = DSH_WAL_MAGIC;
    rec.version = DSH_WAL_VERSION;
    rec.kind = kind;
    rec.type = type;
    rec.flags = flags;
    rec.pathChars = canonical ? (UINT32)wcslen(canonical) : 0;
    rec.nameChars = valueName ? (UINT32)wcslen(valueName) : 0;
    rec.dataBytes = dataBytes;
    rec.status = status;
    rec.reserved = 0;
    return DshRegStageJournalAppend(&rec, canonical, valueName, data, NULL);
}

/* Public helpers used by the registry provider (ws_regstore.c). */
LSTATUS ws_t3_record_create_key(const wchar_t *canonical)
{
    return t3_append(DSH_KIND_CREATE_KEY, 0, 0, canonical, NULL, NULL, 0, 0);
}

LSTATUS ws_t3_record_delete_key(const wchar_t *canonical)
{
    return t3_append(DSH_KIND_DELETE_KEY, 0, 0, canonical, NULL, NULL, 0, 0);
}

LSTATUS ws_t3_record_set_value(const wchar_t *canonical, const wchar_t *name, UINT16 type,
                               const void *data, UINT32 dataBytes, int isVolatile)
{
    UINT16 flags = DSH_FLAG_HAS_VALUE_NAME;
    if (dataBytes || data) {
        flags |= DSH_FLAG_HAS_DATA;
    }
    if (isVolatile) {
        flags |= DSH_FLAG_VOLATILE;
    }
    return t3_append(DSH_KIND_SET_VALUE, type, flags, canonical, name, data, dataBytes, 0);
}

LSTATUS ws_t3_record_delete_value(const wchar_t *canonical, const wchar_t *name, int isVolatile)
{
    UINT16 flags = DSH_FLAG_HAS_VALUE_NAME | (isVolatile ? DSH_FLAG_VOLATILE : 0);
    return t3_append(DSH_KIND_DELETE_VALUE, 0, flags, canonical, name, NULL, 0, 0);
}

/* A refused call is audit data, not a silent no-op (T3 ?8): record the exact
 * LSTATUS we hand back to the caller. */
LSTATUS ws_t3_record_hard_deny(const wchar_t *pathOrPlaceholder, UINT32 status)
{
    if (!ws_t3_is_attached()) {
        return (LSTATUS)status;
    }
    t3_append(DSH_KIND_HARD_DENY, 0, DSH_FLAG_HARD_DENY, pathOrPlaceholder, NULL, NULL, 0, status);
    return (LSTATUS)status;
}

/* A call the overlay genuinely cannot represent is NOT a permission error: the
 * real API is called instead and only this audit record is left behind
 * (T3 contract v1.4). `pathOrPlaceholder` should be the canonical key path when
 * it is known (the audit must answer "which key went to the real hive") and a
 * `<unstaged:ApiName>` placeholder when it is not; either way it is only a
 * label, never a replayable operation -- hence nameChars/dataBytes == 0 and
 * status == 0 ("we did not deny you"). */
LSTATUS ws_t3_record_unstaged(const wchar_t *pathOrPlaceholder, UINT16 reason)
{
    if (!ws_t3_is_attached()) {
        return ERROR_INVALID_HANDLE;
    }
    if (reason < DSH_UNSTAGED_WOW64_32KEY || reason > DSH_UNSTAGED_BARE_HIVE_ROOT) {
        return ERROR_INVALID_PARAMETER;
    }
    return t3_append(DSH_KIND_UNSTAGED, reason, DSH_FLAG_UNSTAGED,
                     pathOrPlaceholder ? pathOrPlaceholder : L"<unstaged>", NULL, NULL, 0, 0);
}

/* ------------------------------------------------------- app hive key access */

/* canonical is "HKLM\Software\X" (short hive name, no leading separator). */
LSTATUS ws_t3_open_key(const wchar_t *canonical, int create, REGSAM sam, HKEY *out)
{
    *out = NULL;
    if (!ws_t3_is_attached()) {
        return ERROR_ACCESS_DENIED;
    }
    if (!canonical || !canonical[0]) {
        return ERROR_INVALID_PARAMETER;
    }
    if (create) {
        DWORD disposition = 0;
        return g_orig.RegCreateKeyExW(g_t3.root, canonical, 0, NULL, 0, sam, NULL, out, &disposition);
    }
    return g_orig.RegOpenKeyExW(g_t3.root, canonical, 0, sam, out);
}

LSTATUS ws_t3_key_exists(const wchar_t *canonical, int *exists)
{
    *exists = 0;
    HKEY h = NULL;
    LSTATUS st = ws_t3_open_key(canonical, 0, KEY_READ, &h);
    if (st == ERROR_SUCCESS) {
        *exists = 1;
        g_orig.RegCloseKey(h);
        return ERROR_SUCCESS;
    }
    if (st == ERROR_FILE_NOT_FOUND || st == ERROR_PATH_NOT_FOUND) {
        return ERROR_SUCCESS;
    }
    return st;
}
