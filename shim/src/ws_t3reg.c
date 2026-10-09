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
    /* SESSION-scoped fallback hive (`overlay.local.hive`). See t3_build_paths():
     * REG_PROCESS_APPKEY makes ONE hive file loadable by ONE process at a time,
     * and every injected child calls DshRegStageAttach, so the fixed shared name
     * is unusable as soon as a command spawns a second process.
     *
     * This used to be `overlay.<pid>.hive` AND was deleted in Detach. That pair
     * is defect D-R1: process A (the one that actually wrote) exited, removed its
     * hive, and process B then loaded a brand new EMPTY one -- so "write in one
     * process, read in another" was a guaranteed miss (measured 12/12 failed
     * reads across 4 independent runs; docs/round10/registry/修复-D-R1.md).
     * A session-scoped name that survives Detach makes the fallback a real
     * shared object; the journal replay below then makes its CONTENT complete
     * regardless of which hive tier we won. */
    wchar_t hiveFallbackPath[WS_PATH_MAX];
    int hiveIsFallback;
    /* Last-resort UNIQUE hive, used only when BOTH shared names are contended. */
    wchar_t hivePidPath[WS_PATH_MAX];
    int tier3Used;
    /* Journal-replay state. The journal is the authoritative cross-process record
     * of the session's staged state, so the app hive is only ever a materialized
     * VIEW of it. If materializing that view fails we must not pretend the view
     * is complete: `viewIncomplete` makes every write path fail closed with a
     * HARD_DENY record carrying the real LSTATUS -- never a silent success on top
     * of a state we cannot see (that is defect D-R2's shape). */
    UINT64 replayedBytes;
    int viewIncomplete;
    LSTATUS viewIncompleteStatus;
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

/* Public read-only probe for the fail-closed guard in ws_regstore.c.
 *
 * Returns 1 when the overlay view is KNOWN to be incomplete (the journal replay
 * failed), and writes the underlying LSTATUS to *outStatus so the refusal can be
 * recorded as a HARD_DENY carrying a real code instead of a bare denial.
 *
 * Declared by its caller rather than in winstage_internal.h, which is outside this
 * task's write scope. */
int ws_t3_view_incomplete(LSTATUS *outStatus)
{
    if (outStatus) {
        *outStatus = g_t3.viewIncompleteStatus;
    }
    return g_t3.viewIncomplete ? 1 : 0;
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
    /* SESSION-scoped fallback hive — the SECOND tier.
     *
     * `REG_PROCESS_APPKEY` gives the hive per-process semantics, and Windows then
     * refuses a second RegLoadAppKeyW on the SAME file from another process with
     * ERROR_SHARING_VIOLATION (32). The shim self-injects every child, so a plain
     * command tree (`powershell.exe` -> `reg.exe`) has >= 2 attach attempts and the
     * child loses the shared file. Without a fallback the child's writes would be
     * hard-denied by this fail-closed layer.
     *
     * Why the name is SESSION-scoped and NOT pid-scoped (D-R1 fix, 2026-10-09):
     * a pid-scoped name is a DIFFERENT file for every process, so the write of one
     * process is invisible to the next one by construction -- `reg add` (process A)
     * then `reg query` (process B) was a guaranteed miss. Measured before the fix:
     * 12/12 reads failed over 4 independent runs while 8/8 writes reported success,
     * with the records provably present in overlay.journal. `overlay.local.hive`
     * is one file per session, so consecutive processes in a command tree share it.
     *
     * Detach must NOT delete it (it did before) -- otherwise the same loss returns
     * one process later. It is derived state, but it is derived state whose PURPOSE
     * is to be shared; the durable truth is still the append-only journal, and
     * `t3_replay_journal()` reseeds this hive from it on every attach so a hive
     * that was contended away or seeded late still ends up complete. */
    pos = 0;
    g_t3.hiveFallbackPath[0] = 0;
    if (!ws_append_w(g_t3.hiveFallbackPath, WS_PATH_MAX, &pos, g_t3.regRoot) ||
        !ws_append_w(g_t3.hiveFallbackPath, WS_PATH_MAX, &pos, L"\\overlay.local.hive")) {
        return 0;
    }
    /* THIRD tier: unique per process. Only reached when both shared names are
     * held by concurrent processes; it keeps the layer usable (writes still reach
     * the shared journal, which is what the host reads) instead of hard-denying. */
    pos = 0;
    g_t3.hivePidPath[0] = 0;
    if (!ws_append_w(g_t3.hivePidPath, WS_PATH_MAX, &pos, g_t3.regRoot) ||
        !ws_append_w(g_t3.hivePidPath, WS_PATH_MAX, &pos, L"\\overlay.")) {
        return 0;
    }
    {
        wchar_t pidText[24];
        t3_u32_to_dec((unsigned long)GetCurrentProcessId(), pidText, sizeof(pidText) / sizeof(pidText[0]));
        if (!ws_append_w(g_t3.hivePidPath, WS_PATH_MAX, &pos, pidText) ||
            !ws_append_w(g_t3.hivePidPath, WS_PATH_MAX, &pos, L".hive")) {
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

/* ============================================================================
 * JOURNAL REPLAY  (D-R1 fix, 2026-10-09)
 *
 * D-R1 in one line: the app hive is per-process, but the WRITES are not -- they
 * live in the shared append-only `overlay.journal`. Treating the per-process hive
 * as the read-back view therefore lost every write that happened in another
 * process (measured: 12/12 failed reads, 4 independent runs).
 *
 * The fix is to stop treating the app hive as the source of truth. The journal
 * IS the session's staged state; the app hive is a materialization of it. So on
 * every attach we replay the journal into whichever hive we managed to load.
 * Replay is idempotent (CREATE is a no-op if the key exists, SET overwrites with
 * the same bytes, DELETE re-marks the same tombstone), which is what lets it run
 * unconditionally on a hive that may already hold part of the state.
 *
 * Contract discipline (T3 ?8.5.1): HARD_DENY and UNSTAGED records are AUDIT ONLY
 * and must never be replayed -- UNSTAGED in particular already reached the real
 * system, so replaying it would be a double write.
 * ========================================================================== */

/* Provider-side tombstone registration; defined in ws_regstore.c (the tombs are
 * file-static there, so replay must ask through this one accessor rather than
 * touching them directly). Declared here because winstage_internal.h is outside
 * this task's write scope. */
extern void ws_rstore_tomb_add(const wchar_t *canonical, const wchar_t *name, int isKey);

/* Same access mask the provider uses for the app hive (proven recipe; see the
 * WS_APPKEY_SAM note in ws_regstore.c). */
#define WS_REPLAY_SAM (KEY_READ | KEY_WRITE)

/* ---------------------------------------------------------------------------
 * ★★ REPLAY MUST NOT USE g_orig.* — measured defect (2026-10-09) ★★
 *
 * `ws_entry.c` calls `DshRegStageAttach()` at :157 and only THEN calls
 * `ws_hook_init()` at :165 to capture the original API pointers. During replay
 * `g_orig.Reg*` is therefore **still NULL**, and calling it is a NULL call that
 * faults DllMain. The loader turns that into `LoadLibraryW() == NULL` with
 * `ERROR_DLL_INIT_FAILED (1114)`, i.e. the transparent shim cannot be injected
 * into any child process at all.
 *
 * It stayed hidden until now because it only triggers when the journal is
 * NON-EMPTY -- precisely the READ-AFTER-WRITE case this task is about:
 *   empty journal  -> replay returns before the loop, no g_orig call, loads fine
 *   non-empty      -> first CREATE_KEY/SET_VALUE calls g_orig.RegCreateKeyExW -> fault
 * Offline proof (`harness/loadtest.c`, seeded 170 B journal):
 *   stock DLL                     seeded -> LoadLibraryW=OK
 *   this change, unguarded        seeded -> LoadLibraryW=NULL err=1114
 *   replay disabled (bisect V1)   seeded -> LoadLibraryW=OK
 *
 * Fix: call the plain Win32 entry points when the captured original is not there
 * yet. That is safe here because the shim installs its own IAT hooks even later
 * (ws_entry.c:170), so a direct call cannot re-enter this DLL's hooks. Once
 * `ws_hook_init()` has run, `g_orig.*` is preferred, so a later re-attach (the
 * exported ABI can be called any time) still goes through the captured originals.
 * ------------------------------------------------------------------------- */
static LSTATUS t3_reg_create(HKEY root, const wchar_t *sub, REGSAM sam, HKEY *out, DWORD *disp)
{
    if (g_orig.RegCreateKeyExW) {
        return g_orig.RegCreateKeyExW(root, sub, 0, NULL, 0, sam, NULL, out, disp);
    }
    return RegCreateKeyExW(root, sub, 0, NULL, 0, sam, NULL, out, disp);
}

static LSTATUS t3_reg_open(HKEY root, const wchar_t *sub, REGSAM sam, HKEY *out)
{
    if (g_orig.RegOpenKeyExW) {
        return g_orig.RegOpenKeyExW(root, sub, 0, sam, out);
    }
    return RegOpenKeyExW(root, sub, 0, sam, out);
}

static LSTATUS t3_reg_set_value(HKEY k, const wchar_t *name, DWORD type, const BYTE *data, DWORD cb)
{
    if (g_orig.RegSetValueExW) {
        return g_orig.RegSetValueExW(k, name, 0, type, data, cb);
    }
    return RegSetValueExW(k, name, 0, type, data, cb);
}

static LSTATUS t3_reg_delete_key(HKEY root, const wchar_t *sub)
{
    if (g_orig.RegDeleteKeyW) {
        return g_orig.RegDeleteKeyW(root, sub);
    }
    return RegDeleteKeyW(root, sub);
}

static LSTATUS t3_reg_delete_value(HKEY k, const wchar_t *name)
{
    if (g_orig.RegDeleteValueW) {
        return g_orig.RegDeleteValueW(k, name);
    }
    return RegDeleteValueW(k, name);
}

static LSTATUS t3_reg_close(HKEY k)
{
    if (g_orig.RegCloseKey) {
        return g_orig.RegCloseKey(k);
    }
    return RegCloseKey(k);
}

/* Create `canonical` in the app hive, including every intermediate level. */
static LSTATUS t3_replay_create_key(const wchar_t *canonical)
{
    HKEY h = NULL;
    DWORD disposition = 0;
    LSTATUS st = t3_reg_create(g_t3.root, canonical, WS_REPLAY_SAM, &h, &disposition);
    if (st == ERROR_SUCCESS && h) {
        t3_reg_close(h);
    }
    return st;
}

/* Open a materialized overlay key (RegSetValueExW / RegDeleteValueW need a real
 * key handle -- they are (hKey, lpValueName), not (root, fullPath, name)). */
static LSTATUS t3_replay_open_key(const wchar_t *canonical, REGSAM sam, HKEY *out)
{
    *out = NULL;
    LSTATUS st = t3_reg_open(g_t3.root, canonical, sam, out);
    if (st == ERROR_FILE_NOT_FOUND || st == ERROR_PATH_NOT_FOUND) {
        /* A value record can arrive before its container levels in a journal that
         * was written by an older build; materialize then retry once. */
        st = t3_replay_create_key(canonical);
        if (st == ERROR_SUCCESS) {
            st = t3_reg_open(g_t3.root, canonical, sam, out);
        }
    }
    return st;
}

/* Read the whole journal. Returns a HeapAlloc'd buffer (caller frees) or NULL.
 * A torn trailing record is normal (another process may be mid-append); it is
 * handled by the parser, not here. */
static BYTE *t3_read_journal_all(DWORD *outLen)
{
    *outLen = 0;
    if (!g_t3.journalPath[0]) {
        return NULL;
    }
    /* A SEPARATE read handle: the append handle's file pointer is owned by the
     * WAL writer and must not be disturbed by a reader. */
    HANDLE h = ws_open_file_raw(g_t3.journalPath, GENERIC_READ,
                                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                OPEN_EXISTING);
    if (h == INVALID_HANDLE_VALUE) {
        return NULL;
    }
    LARGE_INTEGER size;
    memset(&size, 0, sizeof(size));
    if (!GetFileSizeEx(h, &size) || size.QuadPart <= 0 || size.QuadPart > (LONGLONG)(64u * 1024u * 1024u)) {
        CloseHandle(h);
        return NULL;
    }
    DWORD len = (DWORD)size.QuadPart;
    BYTE *buf = (BYTE *)HeapAlloc(GetProcessHeap(), 0, len);
    if (!buf) {
        CloseHandle(h);
        return NULL;
    }
    DWORD got = 0;
    BOOL ok = ReadFile(h, buf, len, &got, NULL);
    CloseHandle(h);
    if (!ok) {
        HeapFree(GetProcessHeap(), 0, buf);
        return NULL;
    }
    *outLen = got;
    return buf;
}

static LSTATUS t3_replay_one(const DSH_REG_STAGE_RECORD *rec,
                             const wchar_t *path, const wchar_t *name,
                             const BYTE *data)
{
    switch (rec->kind) {
    case DSH_KIND_CREATE_KEY:
        return t3_replay_create_key(path);
    case DSH_KIND_DELETE_KEY:
        /* A deleted key must stay hidden from the real hive, so the tombstone is
         * part of the replay (it is what makes reads fall through to "gone"). */
        ws_rstore_tomb_add(path, L"", 1);
        t3_reg_delete_key(g_t3.root, path); /* best effort: absent is fine */
        return ERROR_SUCCESS;
    case DSH_KIND_SET_VALUE: {
        LSTATUS st = t3_replay_create_key(path);
        if (st != ERROR_SUCCESS) {
            return st;
        }
        HKEY h = NULL;
        st = t3_replay_open_key(path, WS_REPLAY_SAM, &h);
        if (st != ERROR_SUCCESS) {
            return st;
        }
        st = t3_reg_set_value(h, name ? name : L"", rec->type, data, rec->dataBytes);
        t3_reg_close(h);
        return st;
    }
    case DSH_KIND_DELETE_VALUE: {
        ws_rstore_tomb_add(path, name ? name : L"", 0);
        /* best effort: the value may legitimately be absent */
        HKEY h = NULL;
        if (t3_replay_open_key(path, WS_REPLAY_SAM, &h) == ERROR_SUCCESS) {
            t3_reg_delete_value(h, name ? name : L"");
            t3_reg_close(h);
        }
        return ERROR_SUCCESS;
    }
    default:
        /* HARD_DENY (5) / UNSTAGED (6): audit only, never replayed. */
        return ERROR_SUCCESS;
    }
}

/* Parse + apply. Returns ERROR_SUCCESS when the app hive now reflects every
 * complete record in the journal. */
static LSTATUS t3_replay_journal(void)
{
    DWORD len = 0;
    BYTE *buf = t3_read_journal_all(&len);
    if (!buf) {
        /* No journal yet is not a failure: nothing has been staged. A journal we
         * cannot READ is a different matter and is reported by the caller. */
        return ERROR_SUCCESS;
    }
    DWORD off = 0;
    UINT32 applied = 0;
    UINT32 skippedAudit = 0;
    LSTATUS rc = ERROR_SUCCESS;
    while (off + (DWORD)sizeof(DSH_REG_STAGE_RECORD) <= len) {
        const DSH_REG_STAGE_RECORD *rec = (const DSH_REG_STAGE_RECORD *)(buf + off);
        if (rec->magic != DSH_WAL_MAGIC || rec->version != DSH_WAL_VERSION) {
            rc = ERROR_INVALID_DATA;
            break;
        }
        UINT64 payload = (UINT64)sizeof(DSH_REG_STAGE_RECORD) +
                         (UINT64)rec->pathChars * 2u + (UINT64)rec->nameChars * 2u +
                         (UINT64)rec->dataBytes;
        if ((UINT64)off + payload > (UINT64)len) {
            /* Torn tail: another process is mid-append. Stop cleanly -- the rest
             * will be replayed by the next process that attaches. */
            break;
        }
        const wchar_t *path = (const wchar_t *)(buf + off + sizeof(DSH_REG_STAGE_RECORD));
        const wchar_t *name = (const wchar_t *)((const BYTE *)path + rec->pathChars * 2u);
        const BYTE *data = (const BYTE *)name + rec->nameChars * 2u;
        if (rec->kind == DSH_KIND_HARD_DENY || rec->kind == DSH_KIND_UNSTAGED) {
            skippedAudit++;
        } else {
            wchar_t pathBuf[WS_PATH_MAX];
            wchar_t nameBuf[512];
            if (rec->pathChars >= WS_PATH_MAX || rec->nameChars >= 512) {
                rc = ERROR_INVALID_DATA;
                break;
            }
            memcpy(pathBuf, path, (size_t)rec->pathChars * sizeof(wchar_t));
            pathBuf[rec->pathChars] = 0;
            memcpy(nameBuf, name, (size_t)rec->nameChars * sizeof(wchar_t));
            nameBuf[rec->nameChars] = 0;
            LSTATUS st = t3_replay_one(rec, pathBuf, nameBuf, data);
            if (st != ERROR_SUCCESS) {
                ws_log("t3_replay_journal: record %lu (kind=%u path=%ls) failed %lu",
                       (unsigned long)applied, (unsigned)rec->kind, pathBuf, (unsigned long)st);
                rc = st;
                break;
            }
            applied++;
        }
        off += (DWORD)payload;
    }
    HeapFree(GetProcessHeap(), 0, buf);
    g_t3.replayedBytes = off;
    ws_log("t3_replay_journal: applied=%lu auditSkipped=%lu bytes=%lu rc=%lu",
           (unsigned long)applied, (unsigned long)skippedAudit,
           (unsigned long)off, (unsigned long)rc);
    return rc;
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
    g_t3.replayedBytes = 0;
    g_t3.viewIncomplete = 0;
    g_t3.viewIncompleteStatus = ERROR_SUCCESS;

    /* TIER 1 -- the shared hive, with a BOUNDED retry. ERROR_SHARING_VIOLATION(32)
     * here is usually a sibling process that is just exiting, so waiting a few
     * milliseconds recovers the shared object instead of silently paying for a
     * private hive. The retry is deliberately short and bounded: a long-lived
     * holder would otherwise stall every child. */
    LSTATUS st = ERROR_SHARING_VIOLATION;
    int tier = 0;
    for (int attempt = 0; attempt < 5; attempt++) {
        g_t3.root = NULL;
        st = RegLoadAppKeyW(g_t3.hivePath, &g_t3.root, KEY_ALL_ACCESS,
                            DSH_REG_PROCESS_APPKEY, 0);
        if (st == ERROR_SUCCESS) {
            tier = 1;
            break;
        }
        g_t3.root = NULL;
        if (st != ERROR_SHARING_VIOLATION && st != ERROR_ACCESS_DENIED && st != ERROR_BUSY) {
            break; /* not contention -- more waiting cannot help */
        }
        if (attempt < 4) {
            Sleep(5u * (DWORD)(attempt + 1));
        }
    }
    LSTATUS sharedStatus = st;

    if (tier != 1) {
        /* TIER 2 -- the SESSION-scoped fallback (`overlay.local.hive`). One file
         * per session, so consecutive processes in a command tree share it; that
         * is what makes "write in one process, read in another" work. */
        if (GetFileAttributesW(g_t3.hiveFallbackPath) != INVALID_FILE_ATTRIBUTES) {
            t3_grant_full_control(g_t3.hiveFallbackPath);
        }
        g_t3.root = NULL;
        st = RegLoadAppKeyW(g_t3.hiveFallbackPath, &g_t3.root, KEY_ALL_ACCESS,
                            DSH_REG_PROCESS_APPKEY, 0);
        if (st == ERROR_SUCCESS) {
            tier = 2;
            g_t3.hiveIsFallback = 1;
            ws_log("DshRegStageAttach: shared hive unusable (%lu) -> SESSION hive=%ls "
                   "(journal stays shared: %ls)",
                   (unsigned long)sharedStatus, g_t3.hiveFallbackPath, g_t3.journalPath);
        }
    }
    if (tier == 0) {
        /* TIER 3 -- unique per process, only when both shared names are held by
         * CONCURRENT processes. Writes still reach the shared journal (the record
         * the host consumes), so this keeps the layer usable rather than denying. */
        if (GetFileAttributesW(g_t3.hivePidPath) != INVALID_FILE_ATTRIBUTES) {
            t3_grant_full_control(g_t3.hivePidPath);
        }
        g_t3.root = NULL;
        LSTATUS t2 = st;
        st = RegLoadAppKeyW(g_t3.hivePidPath, &g_t3.root, KEY_ALL_ACCESS,
                            DSH_REG_PROCESS_APPKEY, 0);
        if (st == ERROR_SUCCESS) {
            tier = 3;
            g_t3.hiveIsFallback = 1;
            g_t3.tier3Used = 1;
            ws_log("DshRegStageAttach: BOTH shared hives unusable (%lu/%lu) -> per-process "
                   "hive=%ls (journal stays shared: %ls)",
                   (unsigned long)sharedStatus, (unsigned long)t2, g_t3.hivePidPath,
                   g_t3.journalPath);
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

    /* THE FIX: the app hive is only a VIEW. Materialize the session's staged state
     * from the shared journal into whichever hive we won, so a process can always
     * read back what any earlier process staged. Runs on every tier, including the
     * shared one (idempotent), because a hive may already hold part of the state. */
    LSTATUS replayStatus = t3_replay_journal();
    if (replayStatus != ERROR_SUCCESS) {
        /* Fail CLOSED, not silent: we cannot see the session's staged state, so any
         * write now would report success on top of a view we know is incomplete
         * (exactly the D-R2 shape). Write paths consult `viewIncomplete` and record
         * a HARD_DENY carrying this LSTATUS. Reads stay as documented. */
        g_t3.viewIncomplete = 1;
        g_t3.viewIncompleteStatus = replayStatus;
        ws_log("DshRegStageAttach: JOURNAL REPLAY FAILED (%lu) -> registry writes will be "
               "denied until the view is complete", (unsigned long)replayStatus);
    }

    const wchar_t *hiveUsed = (tier == 1) ? g_t3.hivePath
                            : (tier == 2) ? g_t3.hiveFallbackPath
                                          : g_t3.hivePidPath;
    ws_log("DshRegStageAttach: sessionDir=%ls tier=%d hive=%ls journal=%ls "
           "(replayedBytes=%lu viewIncomplete=%d)",
           g_t3.sessionDir, tier, hiveUsed, g_t3.journalPath,
           (unsigned long)g_t3.replayedBytes, g_t3.viewIncomplete);
    SetLastError(ws_saved_last_error);
    return ERROR_SUCCESS;
}

LSTATUS __cdecl DshRegStageDetach(void)
{
    /* ★ WP13（A9）：`RegCloseKey`（g_orig）/ `CloseHandle` / `DeleteFileW` 都会改
     * 调用线程的 last error；本函数结果由返回值表达（且刻意"best effort"）⇒ 出口还原。 */
    DWORD ws_saved_last_error = GetLastError();
    if (g_t3.root) {
        /* Guarded: at attach-failure time this runs BEFORE ws_hook_init(), so
         * g_orig.RegCloseKey can still be NULL (same NULL-call class as the
         * replay fault documented above). */
        t3_reg_close(g_t3.root);
        g_t3.root = NULL;
    }
    if (g_t3.journal) {
        CloseHandle(g_t3.journal);
        g_t3.journal = NULL;
    }
    /* ★ D-R1 fix (2026-10-09): DO NOT delete the session hive.
     *
     * It used to be `overlay.<pid>.hive` and was removed here. That made the
     * fallback a per-process object that vanished with its writer, so the NEXT
     * process loaded a brand-new EMPTY hive and could not read anything the
     * previous one staged (measured 12/12 failed reads, 4 independent runs).
     * `overlay.local.hive` is deliberately session-scoped and must outlive the
     * process that created it; the durable truth is still the append-only
     * journal, and each attach reseeds this hive from it (t3_replay_journal).
     *
     * The TIER-3 unique hive (`overlay.<pid>.hive`) is still dropped on a clean
     * exit: nothing else ever reads it, so leaving it behind would only leak.
     * A killed process leaves it, and t3_sweep_stale_hives() reaps it later. */
    if (g_t3.hiveIsFallback && g_t3.hivePidPath[0] && g_t3.tier3Used) {
        if (!DeleteFileW(g_t3.hivePidPath)) {
            ws_log("DshRegStageDetach: could not remove tier-3 hive=%ls (err=%lu) "
                   "(a later attach will sweep it)", g_t3.hivePidPath,
                   (unsigned long)GetLastError());
        }
        g_t3.tier3Used = 0;
    }
    g_t3.hiveIsFallback = 0;
    g_t3.viewIncomplete = 0;
    g_t3.replayedBytes = 0;
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
