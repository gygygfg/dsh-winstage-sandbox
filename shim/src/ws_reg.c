/* WinStageSandbox -- T4 shim: registry API hooks.
 *
 * Key handles handed to callers for keys that only exist in the overlay are
 * *pseudo handles*, held in an explicit live table and recognised by table
 * lookup only (never by guessing from the numeric value: the predefined HKEY
 * constants 0x80000000..0x80000008 are numerically larger than any small-pointer
 * threshold and dereferencing them was a real 0xC0000005).
 *
 * Pass-through policy (this is what keeps PowerShell and the cert stores
 * working): a key that already exists in the real hive is opened through the
 * REAL API and its real handle is returned. Nothing is staged, so reads behave
 * exactly like the real system. Staging starts only when something is written.
 *
 * Three outcomes, not two (T3 contract v1.4). A write that cannot be staged is
 * NOT automatically a permission error:
 *   · STAGE          -- the write goes into the app hive (+ WAL record);
 *   · PASSTHROUGH    -- the overlay genuinely cannot represent the call (a 32-bit
 *                       hive view, a handle whose path cannot be derived, a value
 *                       written straight onto a hive root): the ORIGINAL call is
 *                       handed to the real API and the fact is journalled as an
 *                       UNSTAGED record (kind 6). Fabricating ERROR_ACCESS_DENIED
 *                       here is what broke the CLR (0x80070005) and node's
 *                       Winsock startup;
 *   · FAIL_CLOSED    -- staging is possible and failing it would leak or desync
 *                       (no overlay attached at all, a disallowed value type or
 *                       option, HKEY_PERFORMANCE_DATA, an app-hive/WAL error).
 * Refusals from the hard-deny list are journalled as HARD_DENY records, so
 * "what is still refused" stays auditable data rather than a promise in a doc.
 */
#include "winstage_internal.h"

#include <winreg.h>

/* UNSTAGED reason codes: they travel in the WAL record's `type` field and must
 * equal REG_STAGE_UNSTAGED_REASON in src/registry-stage.mjs (and DSH_UNSTAGED_*
 * in ws_t3reg.c). The shared header is not ours to extend, so the provider entry
 * point is declared locally. */
#define WS_UNSTAGED_WOW64_32KEY              1u
#define WS_UNSTAGED_WOW64_VIEW_IN_WOW64_PROC 2u
#define WS_UNSTAGED_UNRESOLVABLE_BASE_HANDLE 3u
#define WS_UNSTAGED_BARE_HIVE_ROOT           4u

extern LSTATUS ws_rstore_unstaged(const wchar_t *pathOrPlaceholder, UINT16 reason);

#define WS_HKEY_MAGIC 0x57534B48u /* 'WSKH' */

/* Verbose per-operation tracing, off unless WINSTAGE_SHIM_VERBOSE=1. */
#define WS_TRACE(...) do { if (g_ws.verbose) ws_log(__VA_ARGS__); } while (0)

/* Structured audit: render a registry operation as one JSONL record with a
 * canonical "HIVE\\subkey" name. Best-effort: an unresolvable handle logs
 * "(unresolved)" rather than dropping the event. */
static void ws_audit_reg(const char *op, HKEY hKey, LPCWSTR subKey, LPCWSTR value)
{
    if (!g_ws.auditPath[0]) {
        return;
    }
    wchar_t full[WS_PATH_MAX];
    size_t pos = 0;
    full[0] = 0;
    int have = 0;
    wchar_t hive[64];
    if (subKey) {
        wchar_t sub[WS_PATH_MAX];
        if (ws_key_path_of_handle(hKey, subKey, hive, 64, sub, WS_PATH_MAX)) {
            ws_append_w(full, WS_PATH_MAX, &pos, hive);
            if (sub[0]) {
                ws_append_w(full, WS_PATH_MAX, &pos, L"\\");
                ws_append_w(full, WS_PATH_MAX, &pos, sub);
            }
            have = 1;
        }
    }
    if (!have) {
        wchar_t canon[WS_PATH_MAX];
        if (ws_handle_reg_path(hKey, hive, 64, canon, WS_PATH_MAX) ||
            ws_pseudo_key_path(hKey, hive, 64, canon, WS_PATH_MAX, NULL)) {
            ws_strlcpy_w(full, canon, WS_PATH_MAX);
            if (subKey && subKey[0]) {
                pos = wcslen(full);
                ws_append_w(full, WS_PATH_MAX, &pos, L"\\");
                ws_append_w(full, WS_PATH_MAX, &pos, subKey);
            }
            have = 1;
        }
    }
    if (!have) {
        ws_strlcpy_w(full, L"(unresolved)", WS_PATH_MAX);
    }
    char esc[WS_PATH_MAX * 3];
    ws_audit_escape_w(full, esc, sizeof(esc));
    if (value) {
        char ev[1024];
        ws_audit_escape_w(value, ev, sizeof(ev));
        ws_audit("{\"op\":\"%s\",\"key\":\"%s\",\"value\":\"%s\"}", op, esc, ev);
    } else {
        ws_audit("{\"op\":\"%s\",\"key\":\"%s\"}", op, esc);
    }
}

/* bumped on every registry mutation; invalidates the merged-enumeration cache */
static void ws_reg_bump_generation(void);
static HKEY ws_reg_open_real(const wchar_t *hive, const wchar_t *rel, REGSAM sam);
static const wchar_t *ws_reg_rel_of(const wchar_t *hive, const wchar_t *canonical);
static HKEY ws_reg_real_root(const wchar_t *hive);
static int ws_reg_overlay_has_key(const wchar_t *canonical);

#define WS_MAX_PSEUDO_KEYS 256

typedef struct WsPseudoKey {
    DWORD magic;
    wchar_t *hive;     /* short name, e.g. "HKCU" */
    wchar_t *canonical;
} WsPseudoKey;

static WsPseudoKey *g_pseudoKeys[WS_MAX_PSEUDO_KEYS];

static int ws_pseudo_index_of(HKEY h)
{
    for (int i = 0; i < WS_MAX_PSEUDO_KEYS; i++) {
        if (g_pseudoKeys[i] && (HKEY)g_pseudoKeys[i] == h) {
            return i;
        }
    }
    return -1;
}

int ws_pseudo_key_is(HKEY h)
{
    return ws_pseudo_index_of(h) >= 0;
}

int ws_pseudo_key_live_count(void)
{
    int n = 0;
    for (int i = 0; i < WS_MAX_PSEUDO_KEYS; i++) {
        if (g_pseudoKeys[i]) {
            n++;
        }
    }
    return n;
}

/* Copy the stored path of a pseudo handle. Returns 1 when hKey is ours. */
int ws_pseudo_key_path(HKEY hKey, wchar_t *hiveOut, DWORD hiveCch,
                       wchar_t *canonicalOut, DWORD canonicalCch, int *isPseudo)
{
    if (isPseudo) {
        *isPseudo = 0;
    }
    int i = ws_pseudo_index_of(hKey);
    if (i < 0) {
        return 0;
    }
    if (isPseudo) {
        *isPseudo = 1;
    }
    if (hiveOut && hiveCch) {
        ws_strlcpy_w(hiveOut, g_pseudoKeys[i]->hive, hiveCch);
    }
    if (canonicalOut && canonicalCch) {
        ws_strlcpy_w(canonicalOut, g_pseudoKeys[i]->canonical, canonicalCch);
    }
    return 1;
}

HKEY ws_pseudo_key_make(const wchar_t *hive, const wchar_t *canonical)
{
    int slot = -1;
    for (int i = 0; i < WS_MAX_PSEUDO_KEYS; i++) {
        if (!g_pseudoKeys[i]) {
            slot = i;
            break;
        }
    }
    if (slot < 0) {
        return NULL; /* table exhausted: caller fails closed */
    }
    WsPseudoKey *pk = (WsPseudoKey *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(WsPseudoKey));
    if (!pk) {
        return NULL;
    }
    pk->magic = WS_HKEY_MAGIC;
    pk->hive = ws_strdup_w(hive ? hive : L"");
    pk->canonical = ws_strdup_w(canonical ? canonical : L"");
    if (!pk->hive || !pk->canonical) {
        ws_free(pk->hive);
        ws_free(pk->canonical);
        ws_free(pk);
        return NULL;
    }
    g_pseudoKeys[slot] = pk;
    return (HKEY)pk;
}

void ws_pseudo_key_free(HKEY hKey)
{
    int i = ws_pseudo_index_of(hKey);
    if (i < 0) {
        return;
    }
    WsPseudoKey *pk = g_pseudoKeys[i];
    g_pseudoKeys[i] = NULL;
    pk->magic = 0;
    ws_free(pk->hive);
    ws_free(pk->canonical);
    ws_free(pk);
}

/* --------------------------------------------------------------- helpers */

/* WOW64 masks. On a 64-bit process (this DLL is x64) KEY_WOW64_64KEY is
 * documented as having no effect, and every 64-bit runtime passes it routinely
 * (the CLR and reg.exe do). Treating it as a hard-deny made "create my own key"
 * fail with ERROR_ACCESS_DENIED -- which the CLR turned into
 * "Starting the CLR failed with HRESULT 80070005" and node into a Winsock
 * startup failure. Only a WOW64 process (32-bit process on 64-bit Windows) can
 * give KEY_WOW64_64KEY real meaning, and only KEY_WOW64_32KEY is meaningful
 * here in the normal case. */
#define WS_SAM_WOW64_MASK (KEY_WOW64_64KEY | KEY_WOW64_32KEY)

static int g_wow64Process = -1; /* -1 unknown, 0 = 64-bit process, 1 = WOW64 */

/* Does `samDesired` ask for a hive view the app hive cannot represent?
 *
 * This is a REPRESENTATION question, not a permission one, and the two callers
 * must now agree on the answer:
 *   · reads  -> pass the ORIGINAL call to the real API;
 *   · writes -> pass the ORIGINAL call to the real API + UNSTAGED record.
 * The old code kept a second, different rule inside ws_create_key() (it tested
 * the raw mask, so KEY_WOW64_64KEY -- a no-op here -- took the refusal path and a
 * brand-new key could not be created). One predicate, one meaning. */
static int ws_reg_wow64_unrepresentable(REGSAM samDesired)
{
    if (g_wow64Process < 0) {
        BOOL isWow = FALSE;
        if (!IsWow64Process(GetCurrentProcess(), &isWow)) {
            isWow = FALSE;
        }
        g_wow64Process = isWow ? 1 : 0;
    }
    if (g_wow64Process == 0) {
        /* 64-bit process: KEY_WOW64_64KEY is a documented no-op, so only the
         * 32-bit view is a request we cannot serve. */
        return (samDesired & KEY_WOW64_32KEY) != 0;
    }
    /* WOW64 process: either flag names a view this app hive does not have. */
    return (samDesired & WS_SAM_WOW64_MASK) != 0;
}

static const wchar_t *ws_reg_unstaged_slug(UINT16 reason)
{
    switch (reason) {
    case WS_UNSTAGED_WOW64_32KEY: return L"wow64-32key";
    case WS_UNSTAGED_WOW64_VIEW_IN_WOW64_PROC: return L"wow64-view-in-wow64-process";
    case WS_UNSTAGED_UNRESOLVABLE_BASE_HANDLE: return L"unresolvable-base-handle";
    case WS_UNSTAGED_BARE_HIVE_ROOT: return L"bare-hive-root";
    default: return L"unstaged";
    }
}

/* Audit label for an UNSTAGED record: the canonical path when we know it (the
 * audit must answer "which key went to the real hive"), otherwise a placeholder
 * -- never a guess. */
static void ws_reg_unstaged_label(const wchar_t *api, UINT16 reason, const wchar_t *canonical,
                                  wchar_t *out, DWORD cch)
{
    if (!out || !cch) {
        return;
    }
    if (canonical && canonical[0]) {
        ws_strlcpy_w(out, canonical, cch);
        return;
    }
    size_t pos = 0;
    out[0] = 0;
    ws_appendf_w(out, cch, &pos, L"<unstaged:%ls:%ls>", api ? api : L"unknown",
                 ws_reg_unstaged_slug(reason));
}

static void ws_reg_journal_unstaged(const wchar_t *api, UINT16 reason, const wchar_t *canonical)
{
    wchar_t label[WS_PATH_MAX + 64];
    label[0] = 0;
    ws_reg_unstaged_label(api, reason, canonical, label, WS_PATH_MAX + 64);
    ws_rstore_unstaged(label, reason);
}

static int ws_reg_disallowed_value_type(DWORD type)
{
    switch (type) {
    case REG_LINK:
    case REG_RESOURCE_LIST:
    case REG_FULL_RESOURCE_DESCRIPTOR:
    case REG_RESOURCE_REQUIREMENTS_LIST:
        return 1;
    default:
        return 0;
    }
}

/* Resolve (handle, subkey) to a canonical path and short hive name.
 * Returns 1 on success; on failure the caller must fail closed with `denyStatus`. */
/* Resolve (handle, subkey) to a canonical path and short hive name.
 *
 * Two policies, because a read is not a write:
 *   ws_reg_read_ctx  : returns 0 when the overlay cannot serve the request; the
 *                      caller then passes the ORIGINAL call through to the real
 *                      API. Denying reads breaks every runtime that uses
 *                      KEY_WOW64_64KEY (the CLR does) or HKEY_PERFORMANCE_DATA,
 *                      and restricted tokens may read (T3 ?4.4.4).
 *   ws_reg_write_ctx : returns a three-way verdict (STAGE / PASSTHROUGH /
 *                      FAIL_CLOSED). Only FAIL_CLOSED becomes
 *                      ERROR_ACCESS_DENIED + a HARD_DENY record; PASSTHROUGH
 *                      hands the original call to the real API and journals an
 *                      UNSTAGED record. Never collapse the two.
 */
static int ws_reg_read_ctx(HKEY hKey, LPCWSTR lpSubKey, REGSAM samDesired,
                           wchar_t *hive, DWORD hiveCch, wchar_t *canonical, DWORD canonicalCch,
                           int *isPseudo, int *isBareHiveRoot)
{
    if (!ws_t3_is_attached()) {
        return 0;
    }
    if (!ws_rstore_canonical(hKey, lpSubKey, hive, hiveCch, canonical, canonicalCch,
                             isPseudo, isBareHiveRoot)) {
        return 0;
    }
    if (ws_wcscmp_ci(hive, L"HKPD") == 0) {
        return 0; /* HKEY_PERFORMANCE_DATA has no backing hive */
    }
    if (ws_reg_wow64_unrepresentable(samDesired)) {
        return 0; /* no WOW64 view in the app hive: the real API stays authoritative */
    }
    return 1;
}

/**
 * Decide what a *write* hook must do (see the file header: STAGE / PASSTHROUGH /
 * FAIL_CLOSED). The caller MUST honour all three: treating PASSTHROUGH as a
 * denial is the very defect this returns a verdict for.
 */
typedef enum WsWriteVerdict {
    WS_WRITE_STAGE = 0,       /* stage it in the app hive */
    WS_WRITE_PASSTHROUGH = 1, /* hand the ORIGINAL call to the real API (UNSTAGED journalled) */
    WS_WRITE_FAIL_CLOSED = 2, /* refuse: staging is possible and failing it would leak/desync */
} WsWriteVerdict;

static WsWriteVerdict ws_reg_write_ctx(HKEY hKey, LPCWSTR lpSubKey, REGSAM samDesired, const wchar_t *api,
                                       wchar_t *hive, DWORD hiveCch, wchar_t *canonical, DWORD canonicalCch,
                                       int *isPseudo, int *isBareHiveRoot)
{
    if (!ws_t3_is_attached()) {
        /* No overlay AND no journal: this call can neither be staged nor recorded
         * as "it went to the real hive", so failure is the only honest answer
         * (ws_entry.c's documented posture: an unattached shim makes registry
         * writes fail closed rather than silently write through). */
        ws_rstore_hard_deny(L"<write:no-overlay-attached>", ERROR_ACCESS_DENIED);
        return WS_WRITE_FAIL_CLOSED;
    }
    if (!ws_rstore_canonical(hKey, lpSubKey, hive, hiveCch, canonical, canonicalCch, isPseudo, isBareHiveRoot)) {
        /* The base handle is not one we can map (native API handle, remote hive,
         * a handle from another process). We must not GUESS the path -- but we
         * must not pretend the caller lacks permission either: the real API knows
         * this handle. */
        ws_reg_journal_unstaged(api, WS_UNSTAGED_UNRESOLVABLE_BASE_HANDLE, NULL);
        return WS_WRITE_PASSTHROUGH;
    }
    if (ws_wcscmp_ci(hive, L"HKPD") == 0) {
        /* HKEY_PERFORMANCE_DATA has no backing hive file: there is no overlay
         * location to write to (documented hard deny, T3 8.1). Reads pass
         * through; a write to a performance counter hive is a caller bug. */
        ws_rstore_hard_deny(canonical[0] ? canonical : L"<HKPD>", ERROR_ACCESS_DENIED);
        return WS_WRITE_FAIL_CLOSED;
    }
    if (ws_reg_wow64_unrepresentable(samDesired)) {
        UINT16 reason = (UINT16)((samDesired & KEY_WOW64_32KEY) ? WS_UNSTAGED_WOW64_32KEY
                                                               : WS_UNSTAGED_WOW64_VIEW_IN_WOW64_PROC);
        ws_reg_journal_unstaged(api, reason, canonical);
        return WS_WRITE_PASSTHROUGH;
    }
    if (isBareHiveRoot && *isBareHiveRoot) {
        /* A value written straight onto a predefined root (`RegSetValueExW(HKCU,
         * ...)`) is legal in the real API, but "HKCU" is not a writable path
         * inside the app hive. Pass it through instead of inventing a denial.
         * NOTE: `isBareHiveRoot` is a **pointer** -- testing the pointer (not the
         * value) made EVERY value write take this branch, i.e. every staged write
         * leaked to the real hive. The real-artifact gate
         * (tests/registry-unstaged-wow64.mjs) is what caught it. */
        ws_reg_journal_unstaged(api, WS_UNSTAGED_BARE_HIVE_ROOT, canonical);
        return WS_WRITE_PASSTHROUGH;
    }
    return WS_WRITE_STAGE;
}

/* Forward a write whose base handle is OUR pseudo handle to the real API: a
 * pseudo handle is not a kernel handle, so it must never reach advapi32. */
static LONG ws_reg_forward_set_value(const wchar_t *hive, const wchar_t *canonical, LPCWSTR nameW, LPCSTR nameA,
                                     DWORD Reserved, DWORD dwType, const BYTE *lpData, DWORD cbData, int isAnsi)
{
    HKEY real = ws_reg_open_real(hive, ws_reg_rel_of(hive, canonical), KEY_SET_VALUE | KEY_QUERY_VALUE);
    if (!real) {
        return ERROR_FILE_NOT_FOUND;
    }
    LONG rc = isAnsi ? g_orig.RegSetValueExA(real, nameA, Reserved, dwType, lpData, cbData)
                     : g_orig.RegSetValueExW(real, nameW, Reserved, dwType, lpData, cbData);
    g_orig.RegCloseKey(real);
    return rc;
}

static LONG ws_reg_forward_delete_value(const wchar_t *hive, const wchar_t *canonical, LPCWSTR nameW, LPCSTR nameA,
                                        int isAnsi)
{
    HKEY real = ws_reg_open_real(hive, ws_reg_rel_of(hive, canonical), KEY_SET_VALUE | KEY_QUERY_VALUE);
    if (!real) {
        return ERROR_FILE_NOT_FOUND;
    }
    LONG rc = isAnsi ? g_orig.RegDeleteValueA(real, nameA) : g_orig.RegDeleteValueW(real, nameW);
    g_orig.RegCloseKey(real);
    return rc;
}
/* Map a short hive name to the real predefined root (NULL if unknown). */
static HKEY ws_reg_real_root(const wchar_t *hive)
{
    if (ws_wcscmp_ci(hive, L"HKCU") == 0) return HKEY_CURRENT_USER;
    if (ws_wcscmp_ci(hive, L"HKLM") == 0) return HKEY_LOCAL_MACHINE;
    if (ws_wcscmp_ci(hive, L"HKCR") == 0) return HKEY_CLASSES_ROOT;
    if (ws_wcscmp_ci(hive, L"HKU") == 0) return HKEY_USERS;
    if (ws_wcscmp_ci(hive, L"HKCC") == 0) return HKEY_CURRENT_CONFIG;
    return NULL;
}

static const wchar_t *ws_reg_rel_of(const wchar_t *hive, const wchar_t *canonical)
{
    size_t hl = wcslen(hive);
    if (wcsncmp(canonical, hive, hl) != 0) {
        return canonical;
    }
    if (canonical[hl] == L'\\') {
        return canonical + hl + 1;
    }
    return canonical + hl;
}

/* The only create that may proceed when it cannot be staged: a PURE OPEN.
 * Probe read-only first (by real path when we have one, else through the
 * caller's own handle) so the caller's create call can never create the real
 * key, and forward the ORIGINAL call only when the key really exists.
 * `ws_create_key_open_only` is used for exactly two states: no overlay attached
 * at all, and HKEY_PERFORMANCE_DATA (no backing hive file). */
static LONG ws_create_key_open_only(HKEY hKey, LPCWSTR lpSubKey, DWORD Reserved, LPWSTR lpClass, DWORD dwOptions,
                                    REGSAM samDesired, LPSECURITY_ATTRIBUTES sa, PHKEY phkResult,
                                    LPDWORD lpdwDisposition, int resolvable, const wchar_t *hive,
                                    const wchar_t *canonical)
{
    int found = 0;
    if (resolvable && hive && canonical && ws_reg_real_root(hive)) {
        HKEY byPath = ws_reg_open_real(hive, ws_reg_rel_of(hive, canonical),
                                       samDesired & ~(REGSAM)WS_SAM_WOW64_MASK);
        if (byPath) {
            found = 1;
            g_orig.RegCloseKey(byPath);
        }
    }
    if (!found) {
        HKEY probe = NULL;
        if (g_orig.RegOpenKeyExW(hKey, lpSubKey, 0, KEY_READ, &probe) == ERROR_SUCCESS) {
            found = 1;
            g_orig.RegCloseKey(probe);
        }
    }
    if (found) {
        return g_orig.RegCreateKeyExW(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired,
                                      sa, phkResult, lpdwDisposition);
    }
    ws_rstore_hard_deny(canonical && canonical[0] ? canonical : L"<RegCreateKeyExW:unresolvable>",
                        ERROR_ACCESS_DENIED);
    return ERROR_ACCESS_DENIED;
}

/* RegCreateKeyExW: an existing key must stay a pure open (no overlay entry, no
 * candidate). A key that exists nowhere is staged *immediately* through
 * ws_rstore_key_materialize() -- the WAL record is written at create time, not
 * deferred to the first value write, so that later path-based opens resolve to
 * the overlay in every process (see the comment at that call site). */
static LONG ws_create_key_inner(HKEY hKey, LPCWSTR lpSubKey, DWORD Reserved, LPWSTR lpClass, DWORD dwOptions,
                                REGSAM samDesired, LPSECURITY_ATTRIBUTES sa, PHKEY phkResult, LPDWORD lpdwDisposition);

/* ★ round-3c：创建键族的**透明化薄包装**（覆盖 `RegCreateKeyExW`/`RegCreateKeyW` 与两个 A 变体的转发；
 * A 变体自身的 `MultiByteToWideChar` 另在钩子层处理）。理由同 `ws_open_key`：
 * `Reg*` 不设 last error，但本文件内部会改它，而钩子对调用方必须在线程状态上透明。 */
static LONG ws_create_key(HKEY hKey, LPCWSTR lpSubKey, DWORD Reserved, LPWSTR lpClass, DWORD dwOptions,
                          REGSAM samDesired, LPSECURITY_ATTRIBUTES sa, PHKEY phkResult, LPDWORD lpdwDisposition)
{
    DWORD ws_saved_last_error = GetLastError();
    LONG rc = ws_create_key_inner(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired, sa, phkResult,
                                  lpdwDisposition);
    SetLastError(ws_saved_last_error);
    return rc;
}

static LONG ws_create_key_inner(HKEY hKey, LPCWSTR lpSubKey, DWORD Reserved, LPWSTR lpClass, DWORD dwOptions,
                                REGSAM samDesired, LPSECURITY_ATTRIBUTES sa, PHKEY phkResult, LPDWORD lpdwDisposition)
{
    (void)Reserved;
    (void)lpClass;
    (void)sa;
    if (dwOptions & (REG_OPTION_CREATE_LINK | REG_OPTION_BACKUP_RESTORE | REG_OPTION_OPEN_LINK)) {
        ws_rstore_hard_deny(L"<RegCreateKeyExW:unsupported-option>", ERROR_ACCESS_DENIED);
        return ERROR_ACCESS_DENIED;
    }
    wchar_t hive[64], canonical[WS_PATH_MAX];
    canonical[0] = 0;
    int isPseudo = 0, isBareRoot = 0;
    int resolvable = ws_rstore_canonical(hKey, lpSubKey, hive, 64, canonical, WS_PATH_MAX,
                                         &isPseudo, &isBareRoot);
    if (isBareRoot) {
        /* The hive root always exists: opening it is a no-op, never a WAL record. */
        return g_orig.RegCreateKeyExW(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired,
                                      sa, phkResult, lpdwDisposition);
    }
    if (!ws_t3_is_attached()) {
        /* No overlay and no journal: a create cannot be staged and cannot be
         * recorded, so only a PURE OPEN may proceed (never create the real key). */
        return ws_create_key_open_only(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired, sa,
                                       phkResult, lpdwDisposition, resolvable, hive, canonical);
    }
    if (!resolvable || ws_reg_wow64_unrepresentable(samDesired)) {
        /* ── The two defects this branch exists to kill (contract v1.4) ──────────
         * 1. `KEY_WOW64_64KEY` is a **documented no-op in a 64-bit process**. The
         *    old code tested the RAW mask here, so a `RegCreateKeyExW` with that
         *    flag on a key that did not exist yet took the refusal path and
         *    returned ERROR_ACCESS_DENIED(5). That is the "cannot create my own
         *    key" failure (CLR 0x80070005 / node WSAStartup 10107).
         * 2. "The overlay cannot represent this" is NOT "you lack permission".
         *    When the path is underivable (a foreign/native handle) the real API
         *    is the only thing that can judge the call; when it is the 32-bit
         *    hive view the app hive has no equivalent location at all. Both go to
         *    the real API with an UNSTAGED journal record instead of a fabricated
         *    denial. */
        UINT16 reason;
        if (!resolvable) {
            reason = WS_UNSTAGED_UNRESOLVABLE_BASE_HANDLE;
        } else if (samDesired & KEY_WOW64_32KEY) {
            reason = WS_UNSTAGED_WOW64_32KEY;
        } else {
            reason = WS_UNSTAGED_WOW64_VIEW_IN_WOW64_PROC;
        }
        ws_reg_journal_unstaged(L"RegCreateKeyExW", reason, resolvable ? canonical : NULL);
        return g_orig.RegCreateKeyExW(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired,
                                      sa, phkResult, lpdwDisposition);
    }
    if (ws_wcscmp_ci(hive, L"HKPD") == 0) {
        /* HKEY_PERFORMANCE_DATA has no backing hive file (documented hard deny):
         * a create can never be staged. A pure open of an existing subkey must
         * still work -- that is the only thing callers actually do with it. */
        return ws_create_key_open_only(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired, sa,
                                       phkResult, lpdwDisposition, resolvable, hive, canonical);
    }

    int inOverlay = 0;
    if (ws_t3_key_exists(canonical, &inOverlay) != ERROR_SUCCESS) {
        WS_TRACE("RegCreateKeyExW: key_exists probe failed for %ls", canonical);
        return ERROR_ACCESS_DENIED;
    }
    if (inOverlay) {
        WS_TRACE("RegCreateKeyExW: overlay hit %ls -> pseudo handle", canonical);
        HKEY h = ws_pseudo_key_make(hive, canonical);
        if (!h) {
            return ERROR_NOT_ENOUGH_MEMORY;
        }
        if (phkResult) *phkResult = h;
        if (lpdwDisposition) *lpdwDisposition = REG_OPENED_EXISTING_KEY;
        return ERROR_SUCCESS;
    }
    /* Real hive already has the key -> pure open through the real API. */
    const wchar_t *rel = ws_reg_rel_of(hive, canonical);
    HKEY realProbe = ws_reg_open_real(hive, rel, KEY_READ);
    if (realProbe) {
        g_orig.RegCloseKey(realProbe);
        WS_TRACE("RegCreateKeyExW: real key exists %ls -> passthrough (no staging)", canonical);
        HKEY root = ws_reg_real_root(hive);
        DWORD disp = REG_OPENED_EXISTING_KEY;
        LONG rc = g_orig.RegCreateKeyExW(root, rel, Reserved, lpClass, dwOptions, samDesired, sa,
                                         phkResult, lpdwDisposition ? lpdwDisposition : &disp);
        return rc;
    }
    /* Neither the overlay nor the real hive has it: the caller is creating it.
     * A create must be visible to **path-based** lookups right away, in every
     * process, so materialize it in the overlay now (WAL-first; the record/level
     * rules live in materialize_chain). Deferring this to the first value write
     * was the bug fixed 2026-09-30: `create -> close -> New-ItemProperty` got
     * FILE_NOT_FOUND because the re-open fell through to the real hive. */
    WS_TRACE("RegCreateKeyExW: creating (staged) %ls -> overlay key + CREATE_KEY", canonical);
    LSTATUS stCreate = ws_rstore_key_materialize(hive, rel);
    if (stCreate != ERROR_SUCCESS) {
        WS_TRACE("RegCreateKeyExW: materialize(%ls) failed %lu", canonical, (unsigned long)stCreate);
        return stCreate;
    }
    HKEY h = ws_pseudo_key_make(hive, canonical);
    if (!h) {
        return ERROR_NOT_ENOUGH_MEMORY;
    }
    if (phkResult) *phkResult = h;
    if (lpdwDisposition) *lpdwDisposition = REG_CREATED_NEW_KEY;
    return ERROR_SUCCESS;
}

LONG WINAPI ws_RegCreateKeyExW(HKEY hKey, LPCWSTR lpSubKey, DWORD Reserved, LPWSTR lpClass, DWORD dwOptions,
                               REGSAM samDesired, LPSECURITY_ATTRIBUTES lpSecurityAttributes,
                               PHKEY phkResult, LPDWORD lpdwDisposition)
{
    WS_STUCK("RegCreateKeyExW");
    ws_stuck_path(lpSubKey);
    ws_audit_reg("reg.create", hKey, lpSubKey, NULL);
    return ws_create_key(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired,
                         lpSecurityAttributes, phkResult, lpdwDisposition);
}

LONG WINAPI ws_RegCreateKeyExA(HKEY hKey, LPCSTR lpSubKey, DWORD Reserved, LPSTR lpClass, DWORD dwOptions,
                               REGSAM samDesired, LPSECURITY_ATTRIBUTES lpSecurityAttributes,
                               PHKEY phkResult, LPDWORD lpdwDisposition)
{
    /* ★ round-3c：A 变体自己在钩子体内做 `MultiByteToWideChar`（会改 last error）⇒ 钩子层透明化。 */
    DWORD ws_saved_last_error = GetLastError();
    wchar_t sub[WS_PATH_MAX];
    sub[0] = 0;
    if (lpSubKey) {
        MultiByteToWideChar(CP_ACP, 0, lpSubKey, -1, sub, WS_PATH_MAX);
    }
    LONG rc = ws_create_key(hKey, sub[0] ? sub : NULL, Reserved, NULL, dwOptions, samDesired,
                            lpSecurityAttributes, phkResult, lpdwDisposition);
    SetLastError(ws_saved_last_error);
    return rc;
}

LONG WINAPI ws_RegCreateKeyW(HKEY hKey, LPCWSTR lpSubKey, PHKEY phkResult)
{
    return ws_create_key(hKey, lpSubKey, 0, NULL, 0, KEY_ALL_ACCESS, NULL, phkResult, NULL);
}

LONG WINAPI ws_RegCreateKeyA(HKEY hKey, LPCSTR lpSubKey, PHKEY phkResult)
{
    DWORD ws_saved_last_error = GetLastError();
    wchar_t sub[WS_PATH_MAX];
    sub[0] = 0;
    if (lpSubKey) {
        MultiByteToWideChar(CP_ACP, 0, lpSubKey, -1, sub, WS_PATH_MAX);
    }
    LONG rc = ws_create_key(hKey, sub[0] ? sub : NULL, 0, NULL, 0, KEY_ALL_ACCESS, NULL, phkResult, NULL);
    SetLastError(ws_saved_last_error);
    return rc;
}

static LONG ws_open_key_inner(HKEY hKey, LPCWSTR lpSubKey, DWORD ulOptions, REGSAM samDesired, PHKEY phkResult);

/* ★ WP13/round-3：注册表钩子的**透明化薄包装**。
 * 为什么需要：`Reg*` 按文档**不设** last error，但本文件内部的
 * `MultiByteToWideChar` / `HeapAlloc` / `HeapFree` / `CreateFileW` /
 * `GetFileAttributesW` / `ws_ensure_dirs` 等**会**改它。载体的 CLR 初始化期会大量
 * 读注册表（CLR 配置、程序集绑定、策略探针），于是钩子留下的 last error 会被
 * CLR 的 `Marshal.ThrowExceptionForHR` 读成"内部错误"——实测签名 A
 * （`System.Data.dll` / `0x8007054F`，本机 ~1-2%）。
 * 因为 `Reg*` 不定义 last error，这里**总是**还原入口值（不需要"失败透传"分支）。
 * 用薄包装而不是在每条出口插一行：覆盖全部出口、只改一处。 */
LONG ws_open_key(HKEY hKey, LPCWSTR lpSubKey, DWORD ulOptions, REGSAM samDesired, PHKEY phkResult)
{
    DWORD ws_saved_last_error = GetLastError();
    LONG rc = ws_open_key_inner(hKey, lpSubKey, ulOptions, samDesired, phkResult);
    SetLastError(ws_saved_last_error);
    return rc;
}

static LONG ws_open_key_inner(HKEY hKey, LPCWSTR lpSubKey, DWORD ulOptions, REGSAM samDesired, PHKEY phkResult)
{
    wchar_t hive[64], canonical[WS_PATH_MAX];
    canonical[0] = 0;
    int isPseudo = 0, isBareRoot = 0;
    if (!ws_reg_read_ctx(hKey, lpSubKey, samDesired, hive, 64, canonical, WS_PATH_MAX,
                         &isPseudo, &isBareRoot) || isBareRoot) {
        WS_TRACE("RegOpenKeyExW: passthrough (unresolvable/bare-root/wow64)");
        return g_orig.RegOpenKeyExW(hKey, lpSubKey, ulOptions, samDesired, phkResult);
    }
    int inOverlay = 0;
    if (ws_t3_key_exists(canonical, &inOverlay) == ERROR_SUCCESS && inOverlay) {
        WS_TRACE("RegOpenKeyExW: overlay hit %ls -> pseudo handle", canonical);
        HKEY h = ws_pseudo_key_make(hive, canonical);
        if (!h) {
            return ERROR_NOT_ENOUGH_MEMORY;
        }
        if (phkResult) *phkResult = h;
        return ERROR_SUCCESS;
    }
    if (isPseudo) {
        /* base handle is ours: forward the call by PATH, never with the pseudo handle */
        HKEY real = ws_reg_open_real(hive, ws_reg_rel_of(hive, canonical), samDesired);
        if (!real) {
            WS_TRACE("RegOpenKeyExW: overlay miss under pseudo base %ls -> FILE_NOT_FOUND", canonical);
            return ERROR_FILE_NOT_FOUND;
        }
        if (phkResult) *phkResult = real;
        return ERROR_SUCCESS;
    }
    WS_TRACE("RegOpenKeyExW: real hive %ls", canonical);
    return g_orig.RegOpenKeyExW(hKey, lpSubKey, ulOptions, samDesired, phkResult);
}

LONG WINAPI ws_RegOpenKeyExW(HKEY hKey, LPCWSTR lpSubKey, DWORD ulOptions, REGSAM samDesired, PHKEY phkResult)
{
    WS_STUCK("RegOpenKeyExW");
    ws_stuck_path(lpSubKey);
    ws_audit_reg("reg.open", hKey, lpSubKey, NULL);
    return ws_open_key(hKey, lpSubKey, ulOptions, samDesired, phkResult);
}

LONG WINAPI ws_RegOpenKeyExA(HKEY hKey, LPCSTR lpSubKey, DWORD ulOptions, REGSAM samDesired, PHKEY phkResult)
{
    /* ★ round-3：A 变体自己在钩子体内做 `MultiByteToWideChar`（会改 last error），
     * 因此必须在**钩子层**做保存/还原（不能只靠 `ws_open_key` 的包装）。 */
    DWORD ws_saved_last_error = GetLastError();
    wchar_t sub[WS_PATH_MAX];
    sub[0] = 0;
    if (lpSubKey) {
        MultiByteToWideChar(CP_ACP, 0, lpSubKey, -1, sub, WS_PATH_MAX);
    }
    LONG rc = ws_open_key(hKey, sub[0] ? sub : NULL, ulOptions, samDesired, phkResult);
        ws_log("REGDBG open api=W pid=%lu hKey=%p ret=%ld", (unsigned long)GetCurrentProcessId(), (void *)hKey, (long)rc);
    ws_log("REGDBG open api=A pid=%lu hKey=%p ret=%ld", (unsigned long)GetCurrentProcessId(), (void *)hKey, (long)rc);
SetLastError(ws_saved_last_error);
    return rc;
}

LONG WINAPI ws_RegOpenKeyW(HKEY hKey, LPCWSTR lpSubKey, PHKEY phkResult)
{
    return ws_open_key(hKey, lpSubKey, 0, KEY_ALL_ACCESS, phkResult);
}

LONG WINAPI ws_RegOpenKeyA(HKEY hKey, LPCSTR lpSubKey, PHKEY phkResult)
{
    DWORD ws_saved_last_error = GetLastError();
    wchar_t sub[WS_PATH_MAX];
    sub[0] = 0;
    if (lpSubKey) {
        MultiByteToWideChar(CP_ACP, 0, lpSubKey, -1, sub, WS_PATH_MAX);
    }
    LONG rc = ws_open_key(hKey, sub[0] ? sub : NULL, 0, KEY_ALL_ACCESS, phkResult);
    SetLastError(ws_saved_last_error);
    return rc;
}

/* -------------------------------------------------------------- set value */

/* The A variants are NOT just name conversions: for REG_SZ / REG_EXPAND_SZ /
 * REG_MULTI_SZ the *data* is ANSI in the A API and UTF-16 in the W API, and
 * lpcbData differs accordingly. Forwarding A to W (the original bug) made
 * Winsock's catalog read fail with ERROR_MORE_DATA(234) -> WSAStartup 10107 and
 * broke the CLR's registry reads the same way. */
static BYTE *ws_ansi_to_wide_data(DWORD dwType, const BYTE *data, DWORD cbData, DWORD *outBytes)
{
    *outBytes = cbData;
    if (!data || !cbData) {
        return NULL;
    }
    if (dwType == REG_SZ || dwType == REG_EXPAND_SZ) {
        int chars = MultiByteToWideChar(CP_ACP, 0, (const char *)data, (int)cbData, NULL, 0);
        if (chars <= 0) {
            return NULL;
        }
        BYTE *out = (BYTE *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)chars * sizeof(wchar_t));
        if (!out) {
            return NULL;
        }
        MultiByteToWideChar(CP_ACP, 0, (const char *)data, (int)cbData, (LPWSTR)out, chars);
        *outBytes = (DWORD)chars * sizeof(wchar_t);
        return out;
    }
    if (dwType == REG_MULTI_SZ) {
        /* convert string by string so the double-NUL terminator survives */
        const char *p = (const char *)data;
        const char *end = p + cbData;
        size_t cap = (size_t)cbData * 2 + 4;
        BYTE *out = (BYTE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, cap);
        if (!out) {
            return NULL;
        }
        wchar_t *w = (wchar_t *)out;
        size_t used = 0;
        while (p < end && *p) {
            int chars = MultiByteToWideChar(CP_ACP, 0, p, -1, w + used, (int)(cap / 2 - used));
            if (chars <= 0) {
                break;
            }
            used += (size_t)chars; /* includes the NUL */
            p += strlen(p) + 1;
        }
        w[used] = 0; /* final terminator */
        *outBytes = (DWORD)((used + 1) * sizeof(wchar_t));
        return out;
    }
    return NULL; /* binary/other: bytes are identical in both APIs */
}

static BYTE *ws_wide_to_ansi_data(DWORD dwType, const BYTE *data, DWORD cbData, DWORD *outBytes)
{
    *outBytes = cbData;
    if (!data || !cbData) {
        return NULL;
    }
    if (dwType == REG_SZ || dwType == REG_EXPAND_SZ) {
        int bytes = WideCharToMultiByte(CP_ACP, 0, (LPCWSTR)data, (int)(cbData / sizeof(wchar_t)),
                                        NULL, 0, NULL, NULL);
        if (bytes <= 0) {
            return NULL;
        }
        BYTE *out = (BYTE *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)bytes + 1);
        if (!out) {
            return NULL;
        }
        bytes = WideCharToMultiByte(CP_ACP, 0, (LPCWSTR)data, (int)(cbData / sizeof(wchar_t)),
                                    (char *)out, bytes, NULL, NULL);
        out[bytes] = 0;
        *outBytes = (DWORD)bytes + 1;
        return out;
    }
    if (dwType == REG_MULTI_SZ) {
        const wchar_t *w = (const wchar_t *)data;
        const wchar_t *end = w + cbData / sizeof(wchar_t);
        DWORD cap = cbData + 4;
        BYTE *out = (BYTE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, cap);
        if (!out) {
            return NULL;
        }
        DWORD used = 0;
        while (w < end && *w) {
            int bytes = WideCharToMultiByte(CP_ACP, 0, w, -1, (char *)out + used, (int)(cap - used), NULL, NULL);
            if (bytes <= 0) {
                break;
            }
            used += (DWORD)bytes;
            w += wcslen(w) + 1;
        }
        out[used] = 0;
        *outBytes = used + 1;
        return out;
    }
    return NULL;
}

static LONG ws_set_value_ex_inner(HKEY hKey, LPCWSTR nameW, LPCSTR nameA, DWORD Reserved, DWORD dwType,
                                  const BYTE *lpData, DWORD cbData, int isAnsi);

/* ★ round-3c：写值族的透明化薄包装（覆盖 `RegSetValueExW` 与 `RegSetValueExA` 的转发；
 * A 变体的数据/名称转换在本 helper 内部完成，所以包装它一次就覆盖两者）。 */
static LONG ws_set_value_ex(HKEY hKey, LPCWSTR nameW, LPCSTR nameA, DWORD Reserved, DWORD dwType,
                            const BYTE *lpData, DWORD cbData, int isAnsi)
{
    DWORD ws_saved_last_error = GetLastError();
    LONG rc = ws_set_value_ex_inner(hKey, nameW, nameA, Reserved, dwType, lpData, cbData, isAnsi);
    SetLastError(ws_saved_last_error);
    return rc;
}

static LONG ws_set_value_ex_inner(HKEY hKey, LPCWSTR nameW, LPCSTR nameA, DWORD Reserved, DWORD dwType,
                                  const BYTE *lpData, DWORD cbData, int isAnsi)
{
    (void)Reserved;
    if (ws_reg_disallowed_value_type(dwType)) {
        ws_rstore_hard_deny(L"<RegSetValueEx:unsupported-value-type>", ERROR_ACCESS_DENIED);
        return ERROR_ACCESS_DENIED;
    }
    wchar_t nameFromA[WS_PATH_MAX];
    nameFromA[0] = 0;
    if (isAnsi && nameA) {
        MultiByteToWideChar(CP_ACP, 0, nameA, -1, nameFromA, WS_PATH_MAX);
    }
    const wchar_t *name = isAnsi ? nameFromA : nameW;

    wchar_t hive[64], canonical[WS_PATH_MAX];
    canonical[0] = 0;
    int isPseudo = 0, isBareRoot = 0;
    WsWriteVerdict verdict = ws_reg_write_ctx(hKey, NULL, 0, L"RegSetValueExW", hive, 64, canonical,
                                              WS_PATH_MAX, &isPseudo, &isBareRoot);
    if (verdict != WS_WRITE_STAGE) {
        if (verdict == WS_WRITE_PASSTHROUGH) {
            /* Cannot be represented in the overlay -> the real API decides (the
             * UNSTAGED record is already in the WAL). A pseudo base handle is not
             * a kernel handle, so it must be forwarded by PATH. */
            WS_TRACE("RegSetValueEx%s: unstaged passthrough %ls", isAnsi ? "A" : "W", canonical);
            if (isPseudo) {
                return ws_reg_forward_set_value(hive, canonical, nameW, nameA, Reserved, dwType, lpData, cbData, isAnsi);
            }
            return isAnsi ? g_orig.RegSetValueExA(hKey, nameA, Reserved, dwType, lpData, cbData)
                          : g_orig.RegSetValueExW(hKey, nameW, Reserved, dwType, lpData, cbData);
        }
        return ERROR_ACCESS_DENIED;
    }

    /* ANSI string payloads must reach the overlay as UTF-16, because the app hive
     * (and the WAL) are W-semantics. */
    BYTE *converted = NULL;
    DWORD convertedBytes = cbData;
    const BYTE *payload = lpData;
    DWORD payloadBytes = cbData;
    if (isAnsi && lpData) {
        converted = ws_ansi_to_wide_data(dwType, lpData, cbData, &convertedBytes);
        if (converted) {
            payload = converted;
            payloadBytes = convertedBytes;
        }
    }
    WS_TRACE("RegSetValueEx%s: staging %ls (type=%lu, %lu bytes)", isAnsi ? "A" : "W", canonical,
             (unsigned long)dwType, (unsigned long)payloadBytes);
    LSTATUS st = ws_rstore_value_set(hive, ws_reg_rel_of(hive, canonical), name ? name : L"",
                                     dwType, payload, payloadBytes);
    if (converted) {
        HeapFree(GetProcessHeap(), 0, converted);
    }
    if (st == ERROR_SUCCESS) {
        ws_reg_bump_generation();
    } else {
        ws_log("fail-closed RegSetValueEx%s: %lu (%ls)", isAnsi ? "A" : "W", (unsigned long)st, canonical);
    }
    return st;
}

LONG WINAPI ws_RegSetValueExW(HKEY hKey, LPCWSTR lpValueName, DWORD Reserved, DWORD dwType,
                              const BYTE *lpData, DWORD cbData)
{
    WS_STUCK("RegSetValueExW");
    ws_stuck_path(lpValueName);
    ws_audit_reg("reg.set", hKey, NULL, lpValueName);
    return ws_set_value_ex(hKey, lpValueName, NULL, Reserved, dwType, lpData, cbData, 0);
}

LONG WINAPI ws_RegSetValueExA(HKEY hKey, LPCSTR lpValueName, DWORD Reserved, DWORD dwType,
                              const BYTE *lpData, DWORD cbData)
{
    return ws_set_value_ex(hKey, NULL, lpValueName, Reserved, dwType, lpData, cbData, 1);
}
/* ------------------------------------------------------------ query value */

/* Wide/ANSI-aware query. The A variant MUST NOT be forwarded to the W API: for
 * string types the data is ANSI and lpcbData counts bytes of ANSI, so a W call
 * either returns UTF-16 where the caller expects ANSI or fails with
 * ERROR_MORE_DATA(234) -- the exact cause of node's WSAStartup 10107. */
static LONG ws_query_value_ex(HKEY hKey, LPCWSTR nameW, LPCSTR nameA, LPDWORD lpReserved,
                              LPDWORD lpType, LPBYTE lpData, LPDWORD lpcbData, int isAnsi)
{
    (void)lpReserved;
    wchar_t nameFromA[WS_PATH_MAX];
    nameFromA[0] = 0;
    if (isAnsi && nameA) {
        MultiByteToWideChar(CP_ACP, 0, nameA, -1, nameFromA, WS_PATH_MAX);
    }
    const wchar_t *name = isAnsi ? nameFromA : nameW;

    wchar_t hive[64], canonical[WS_PATH_MAX];
    canonical[0] = 0;
    int isPseudo = 0, isBareRoot = 0;
    /* task-17 插桩（只日志、不改语义）：D-R1 端到端仍报 ERROR_INVALID_HANDLE(6)，需判定
     * reg.exe 的读路径走"取回 ctx / fail-closed / 直通 advapi32"哪一条（Lead 的首要假设：
     * 失败那次 hKey 根本没被识别为 isPseudo ⇒ 直通假句柄）。 */
    int ctxOk = ws_reg_read_ctx(hKey, NULL, 0, hive, 64, canonical, WS_PATH_MAX, &isPseudo, &isBareRoot);
    int canServe = ctxOk && !isBareRoot;
    ws_log("REGDBG query%s pid=%lu hKey=%p ctxOk=%d isPseudo=%d isBareRoot=%d canServe=%d canonical=%ls",
           isAnsi ? "A" : "W", (unsigned long)GetCurrentProcessId(), (void *)hKey, ctxOk, isPseudo,
           isBareRoot, canServe, canonical[0] ? canonical : L"(none)");
    /* ★ task-17（D-R1 读回缺失的正因）：伪句柄不是内核句柄，`ws_reg_read_ctx` 在它上面
     * 可能返回 0（此时 `isPseudo` 已由 `ws_rstore_canonical` 置 1），于是本函数会落到下面的
     * `!canServe` 分支、把**伪句柄**直通 advapi32 ⇒ 必然 `ERROR_INVALID_HANDLE(6)`：
     * 这正是"覆盖层里键/值都在（`flags=STAGED|EXISTS`）却 `query-value-exit=1`"的成因。
     * 伪句柄的 hive/canonical 本来就存在伪句柄表里（`ws_pseudo_key_path`），取回来即可由
     * 覆盖层直接服务 —— 既不直通假句柄，也不丢值。 */
    if (!canServe && isPseudo) {
        int pseudo = 0;
        int rec = ws_pseudo_key_path(hKey, hive, 64, canonical, WS_PATH_MAX, &pseudo);
        ws_log("REGDBG recover pid=%lu hKey=%p rec=%d pseudo=%d canonical=%ls",
               (unsigned long)GetCurrentProcessId(), (void *)hKey, rec, pseudo,
               canonical[0] ? canonical : L"(none)");
        if (rec && pseudo) {
            isPseudo = 1;
            canServe = 1;
        }
    }
    if (canServe && !isPseudo && !ws_reg_overlay_has_key(canonical)) {
        canServe = 0; /* nothing staged under this key: the real API is authoritative */
    }
    /* A pseudo handle must NEVER reach a real API: it is not a kernel handle, so
     * the call would fail with ERROR_INVALID_HANDLE(6) -- which is exactly how
     * "reg add" broke (the key is materialized lazily, so the overlay may not
     * have it yet at query time). */
    if (!canServe) {
        if (isPseudo) {
            ws_log("REGDBG branch=fail-closed pid=%lu hKey=%p", (unsigned long)GetCurrentProcessId(),
                   (void *)hKey);
            /* fail closed: never hand a pseudo handle to advapi32 (task-17) */
            return ERROR_FILE_NOT_FOUND;
        }
        ws_log("REGDBG branch=PASSTHROUGH pid=%lu hKey=%p isPseudo=%d canonical=%ls",
               (unsigned long)GetCurrentProcessId(), (void *)hKey, isPseudo,
               canonical[0] ? canonical : L"(none)");
        return isAnsi ? g_orig.RegQueryValueExA(hKey, nameA, lpReserved, lpType, lpData, lpcbData)
                      : g_orig.RegQueryValueExW(hKey, nameW, lpReserved, lpType, lpData, lpcbData);
    }
    ws_log("REGDBG branch=ctx-recovered pid=%lu hKey=%p isPseudo=%d canonical=%ls",
           (unsigned long)GetCurrentProcessId(), (void *)hKey, isPseudo,
           canonical[0] ? canonical : L"(none)");
    WS_TRACE("RegQueryValueEx%s: overlay query %ls", isAnsi ? "A" : "W", canonical);
    const wchar_t *rel = ws_reg_rel_of(hive, canonical);

    const DWORD kMaxValue = 1u << 20;
    BYTE *buf = (BYTE *)HeapAlloc(GetProcessHeap(), 0, kMaxValue);
    if (!buf) {
        return ERROR_NOT_ENOUGH_MEMORY;
    }
    uint32_t type = 0, len = kMaxValue, flags = 0;
    int rc = ws_rstore_value_get(hive, rel, name ? name : L"", &type, buf, &len, &flags);
    if (rc != 0) {
        HeapFree(GetProcessHeap(), 0, buf);
        if (rc < 0 && isPseudo) {
            return ERROR_FILE_NOT_FOUND;
        }
        if (isPseudo) {
            /* overlay-only key: a pseudo handle must never reach advapi32 */
            HKEY realRoot = ws_reg_real_root(hive);
            if (!realRoot || !rel[0]) {
                return ERROR_FILE_NOT_FOUND;
            }
            HKEY realKey = NULL;
            LSTATUS st = g_orig.RegOpenKeyExW(realRoot, rel, 0, KEY_READ, &realKey);
            if (st != ERROR_SUCCESS) {
                return st;
            }
            if (isAnsi) {
                st = g_orig.RegQueryValueExA(realKey, nameA, lpReserved, lpType, lpData, lpcbData);
            } else {
                st = g_orig.RegQueryValueExW(realKey, nameW, lpReserved, lpType, lpData, lpcbData);
            }
            g_orig.RegCloseKey(realKey);
            return st;
        }
        return isAnsi ? g_orig.RegQueryValueExA(hKey, nameA, lpReserved, lpType, lpData, lpcbData)
                      : g_orig.RegQueryValueExW(hKey, nameW, lpReserved, lpType, lpData, lpcbData);
    }
    if (flags & WINSTAGE_RES_WHITEOUT) {
        HeapFree(GetProcessHeap(), 0, buf);
        return ERROR_FILE_NOT_FOUND;
    }
    /* Convert the overlay's W-semantics payload back to ANSI when needed. */
    BYTE *ansi = NULL;
    DWORD ansiBytes = 0;
    const BYTE *payload = buf;
    DWORD payloadBytes = len;
    if (isAnsi && len) {
        ansi = ws_wide_to_ansi_data(type, buf, len, &ansiBytes);
        if (ansi) {
            payload = ansi;
            payloadBytes = ansiBytes;
        }
    }
    if (lpType) {
        *lpType = type;
    }
    LONG result = ERROR_SUCCESS;
    if (!lpData) {
        if (lpcbData) {
            *lpcbData = payloadBytes;
        }
    } else {
        DWORD cap = lpcbData ? *lpcbData : 0;
        if (lpcbData) {
            *lpcbData = payloadBytes;
        }
        if (cap < payloadBytes) {
            result = ERROR_MORE_DATA;
        } else if (payloadBytes) {
            memcpy(lpData, payload, payloadBytes);
        }
    }
    if (ansi) {
        HeapFree(GetProcessHeap(), 0, ansi);
    }
    HeapFree(GetProcessHeap(), 0, buf);
    return result;
}
/* ============================================================================
 * task-18 (option 2, minimal surface): ntdll!NtQueryValueKey
 *
 * reg.exe reads registry values through ntdll, not advapi32. A handle we
 * synthesised for an overlay-only key is not a kernel handle, so the real
 * NtQueryValueKey fails with STATUS_INVALID_HANDLE, which surfaces as
 * ERROR_INVALID_HANDLE(6) -- exactly the observed D-R1 read-back failure.
 *
 * Policy: real handles are forwarded untouched; pseudo handles are resolved via
 * ws_pseudo_key_path and served from the overlay (same ctx path as
 * ws_query_value_ex); an unresolvable pseudo handle fails closed with
 * STATUS_INVALID_HANDLE and is NEVER passed through.
 *
 * Layouts are written at explicit fixed offsets (no struct padding assumptions):
 *   KeyValuePartialInformation (0): TitleIndex@0 Type@4 DataLength@8 Data@12
 *   KeyValueFullInformation    (1): TitleIndex@0 Type@4 DataOffset@8 DataLength@12 NameLength@16 Name@20
 * ==========================================================================*/
#define WS_KV_PARTIAL 2u  /* real enum: Basic=0 Full=1 Partial=2 */
#define WS_KV_FULL 1u     /* KeyValueFullInformation */
#define WS_KV_PARTIAL_FIXED 12u
#define WS_KV_FULL_FIXED 20u
#define WS_ST_SUCCESS ((NTSTATUS)0x00000000L)
#define WS_ST_NOT_IMPLEMENTED ((NTSTATUS)0xC0000002L)
#define WS_ST_INVALID_HANDLE ((NTSTATUS)0xC0000008L)
#define WS_ST_NO_MEMORY ((NTSTATUS)0xC0000017L)
#define WS_ST_BUFFER_TOO_SMALL ((NTSTATUS)0xC0000023L)
#define WS_ST_OBJECT_NAME_NOT_FOUND ((NTSTATUS)0xC0000034L)
#define WS_ST_BUFFER_OVERFLOW ((NTSTATUS)0x80000005L)

static _Thread_local int t_wsRegBusy;

static void ws_kv_put32(void *base, ULONG off, ULONG v)
{
    memcpy((BYTE *)base + off, &v, sizeof(v));
}

NTSTATUS NTAPI ws_NtQueryValueKey(HANDLE KeyHandle, const void *ValueName,
                                  ULONG KeyValueInformationClass, PVOID KeyValueInformation,
                                  ULONG Length, PULONG ResultLength)
{
    if (!g_orig.NtQueryValueKey) {
        return WS_ST_NOT_IMPLEMENTED;
    }
    /* Reentrancy guard: the overlay machinery below may itself touch the registry. */
    if (t_wsRegBusy) {
        return g_orig.NtQueryValueKey(KeyHandle, ValueName, KeyValueInformationClass,
                                      KeyValueInformation, Length, ResultLength);
    }
    if (ResultLength) {
        *ResultLength = 0;
    }
    /* Real (kernel) handle -> untouched. Only synthesised handles get served here. */
    if (ws_pseudo_index_of((HKEY)KeyHandle) < 0) {
        return g_orig.NtQueryValueKey(KeyHandle, ValueName, KeyValueInformationClass,
                                      KeyValueInformation, Length, ResultLength);
    }
    wchar_t hive[64], canonical[WS_PATH_MAX];
    canonical[0] = 0;
    int isPseudo = 0;
    if (!ws_pseudo_key_path((HKEY)KeyHandle, hive, 64, canonical, WS_PATH_MAX, &isPseudo) ||
        !isPseudo) {
        return WS_ST_INVALID_HANDLE; /* never hand a synthetic handle to ntdll */
    }
    const wchar_t *name = L"";
    if (ValueName) {
        const UNICODE_STRING *us = (const UNICODE_STRING *)ValueName;
        if (us->Buffer && us->Length) {
            name = us->Buffer;
        }
    }
    const wchar_t *rel = ws_reg_rel_of(hive, canonical);
    const DWORD kMaxValue = 1u << 20;
    BYTE *buf = (BYTE *)HeapAlloc(GetProcessHeap(), 0, kMaxValue);
    if (!buf) {
        return WS_ST_NO_MEMORY;
    }
    uint32_t type = 0, len = kMaxValue, flags = 0;
    t_wsRegBusy++;
    int rc = ws_rstore_value_get(hive, rel, name, &type, buf, &len, &flags);
    t_wsRegBusy--;
    if (rc != 0 || (flags & WINSTAGE_RES_WHITEOUT)) {
        HeapFree(GetProcessHeap(), 0, buf);
        return WS_ST_OBJECT_NAME_NOT_FOUND;
    }
    ULONG nameBytes = 0;
    ULONG fixedPart = 0;
    ULONG dataOff = 0;
    if (KeyValueInformationClass == WS_KV_PARTIAL) {
        fixedPart = WS_KV_PARTIAL_FIXED;
        dataOff = fixedPart;
    } else if (KeyValueInformationClass == WS_KV_FULL) {
        nameBytes = (ULONG)(wcslen(name) * sizeof(wchar_t));
        fixedPart = WS_KV_FULL_FIXED;
        dataOff = fixedPart + nameBytes;
    } else {
        HeapFree(GetProcessHeap(), 0, buf);
        return WS_ST_NOT_IMPLEMENTED; /* only the two classes reg.exe uses */
    }
    ULONG need = dataOff + len;
    if (ResultLength) {
        *ResultLength = need;
    }
    if (!KeyValueInformation) {
        HeapFree(GetProcessHeap(), 0, buf);
        return WS_ST_BUFFER_TOO_SMALL;
    }
    if (Length < fixedPart) {
        HeapFree(GetProcessHeap(), 0, buf);
        return WS_ST_BUFFER_TOO_SMALL; /* cannot even write the fixed fields */
    }
    ws_kv_put32(KeyValueInformation, 0, 0u);       /* TitleIndex */
    ws_kv_put32(KeyValueInformation, 4, type);     /* Type */
    if (KeyValueInformationClass == WS_KV_PARTIAL) {
        ws_kv_put32(KeyValueInformation, 8, len);  /* DataLength */
    } else {
        ws_kv_put32(KeyValueInformation, 8, dataOff);   /* DataOffset */
        ws_kv_put32(KeyValueInformation, 12, len);      /* DataLength */
        ws_kv_put32(KeyValueInformation, 16, nameBytes);/* NameLength */
        if (nameBytes) {
            memcpy((BYTE *)KeyValueInformation + fixedPart, name, nameBytes);
        }
    }
    NTSTATUS st = WS_ST_SUCCESS;
    if (Length < need) {
        ULONG copy = (Length > fixedPart) ? (Length - fixedPart) : 0;
        if (copy > len) {
            copy = len;
        }
        if (copy) {
            memcpy((BYTE *)KeyValueInformation + dataOff, buf, copy);
        }
        st = WS_ST_BUFFER_OVERFLOW;
    } else if (len) {
        memcpy((BYTE *)KeyValueInformation + dataOff, buf, len);
    }
    HeapFree(GetProcessHeap(), 0, buf);
    return st;
}

/* ============================================================================
 * task-18c: ntdll!NtEnumerateValueKey + ntdll!NtQueryKey
 * Same proven policy as ws_NtQueryValueKey:
 *   real handle -> forward untouched; pseudo handle -> resolve + serve from the overlay;
 *   unresolvable pseudo handle -> STATUS_INVALID_HANDLE; unresolved ORIGINAL -> the
 *   distinguishable STATUS_NOT_IMPLEMENTED sentinel (never a fail-closed behaviour change).
 *   KEY_VALUE_INFORMATION_CLASS: Basic=0 Full=1 Partial=2
 *   KEY_INFORMATION_CLASS:       Basic=0 Node=1 Full=2 Name=3
 * ==========================================================================*/
NTSTATUS NTAPI ws_NtEnumerateValueKey(HANDLE KeyHandle, ULONG Index, ULONG KeyValueInformationClass,
                                      PVOID KeyValueInformation, ULONG Length, PULONG ResultLength)
{
    if (!g_orig.NtEnumerateValueKey) {
        return WS_ST_NOT_IMPLEMENTED;
    }
    if (t_wsRegBusy) {
        return g_orig.NtEnumerateValueKey(KeyHandle, Index, KeyValueInformationClass, KeyValueInformation,
                                          Length, ResultLength);
    }
    if (ResultLength) {
        *ResultLength = 0;
    }
    if (ws_pseudo_index_of((HKEY)KeyHandle) < 0) {
        return g_orig.NtEnumerateValueKey(KeyHandle, Index, KeyValueInformationClass, KeyValueInformation,
                                         Length, ResultLength);
    }
    wchar_t hive[64], canonical[WS_PATH_MAX];
    canonical[0] = 0;
    int isPseudo = 0;
    if (!ws_pseudo_key_path((HKEY)KeyHandle, hive, 64, canonical, WS_PATH_MAX, &isPseudo) || !isPseudo) {
        return WS_ST_INVALID_HANDLE;
    }
    const wchar_t *rel = ws_reg_rel_of(hive, canonical);
    wchar_t name[256];
    name[0] = 0;
    uint32_t type = 0, vlen = 0, vflags = 0;
    t_wsRegBusy++;
    int erc = ws_rstore_value_enum(hive, rel, Index, name, 256, &type, NULL, &vlen, &vflags);
    t_wsRegBusy--;
    if (erc != 0) {
        return (NTSTATUS)0x8000001AL; /* STATUS_NO_MORE_ENTRIES */
    }
    BYTE *buf = NULL;
    uint32_t dataLen = 0;
    if (vlen) {
        buf = (BYTE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, vlen);
        if (!buf) {
            return WS_ST_NO_MEMORY;
        }
        uint32_t cap = vlen;
        t_wsRegBusy++;
        int grc = ws_rstore_value_get(hive, rel, name, &type, buf, &cap, &vflags);
        t_wsRegBusy--;
        if (grc != 0 || (vflags & WINSTAGE_RES_WHITEOUT)) {
            HeapFree(GetProcessHeap(), 0, buf);
            return WS_ST_OBJECT_NAME_NOT_FOUND;
        }
        dataLen = cap;
    }
    ULONG nameBytes = (ULONG)(wcslen(name) * sizeof(wchar_t));
    ULONG fixedPart, dataOff, need;
    if (KeyValueInformationClass == 1u) {          /* KeyValueFullInformation */
        fixedPart = 20u;
        dataOff = fixedPart + nameBytes;
        need = dataOff + dataLen;
    } else if (KeyValueInformationClass == 2u) {   /* KeyValuePartialInformation */
        fixedPart = 12u;
        dataOff = fixedPart;
        need = dataOff + dataLen;
    } else {                                        /* KeyValueBasicInformation */
        fixedPart = 12u;                            /* TitleIndex/Type/NameLength */
        dataOff = fixedPart + nameBytes;
        need = dataOff;
    }
    if (ResultLength) {
        *ResultLength = need;
    }
    if (!KeyValueInformation) {
        if (buf) HeapFree(GetProcessHeap(), 0, buf);
        return WS_ST_BUFFER_TOO_SMALL;
    }
    if (Length < fixedPart) {
        if (buf) HeapFree(GetProcessHeap(), 0, buf);
        return WS_ST_BUFFER_TOO_SMALL;
    }
    ws_kv_put32(KeyValueInformation, 0, 0u);
    ws_kv_put32(KeyValueInformation, 4, type);
    if (KeyValueInformationClass == 1u) {
        ws_kv_put32(KeyValueInformation, 8, dataOff);
        ws_kv_put32(KeyValueInformation, 12, dataLen);
        ws_kv_put32(KeyValueInformation, 16, nameBytes);
        if (nameBytes) memcpy((BYTE *)KeyValueInformation + fixedPart, name, nameBytes);
        if (dataLen && Length >= need) memcpy((BYTE *)KeyValueInformation + dataOff, buf, dataLen);
    } else if (KeyValueInformationClass == 2u) {
        ws_kv_put32(KeyValueInformation, 8, dataLen);
        if (dataLen && Length >= need) memcpy((BYTE *)KeyValueInformation + dataOff, buf, dataLen);
    } else {
        ws_kv_put32(KeyValueInformation, 8, nameBytes);
        if (nameBytes) memcpy((BYTE *)KeyValueInformation + fixedPart, name, nameBytes);
    }
    if (buf) HeapFree(GetProcessHeap(), 0, buf);
    return (Length < need) ? WS_ST_BUFFER_OVERFLOW : WS_ST_SUCCESS;
}

NTSTATUS NTAPI ws_NtQueryKey(HANDLE KeyHandle, ULONG KeyInformationClass, PVOID KeyInformation,
                             ULONG Length, PULONG ResultLength)
{
    if (!g_orig.NtQueryKey) {
        return WS_ST_NOT_IMPLEMENTED;
    }
    if (t_wsRegBusy) {
        return g_orig.NtQueryKey(KeyHandle, KeyInformationClass, KeyInformation, Length, ResultLength);
    }
    if (ResultLength) {
        *ResultLength = 0;
    }
    if (ws_pseudo_index_of((HKEY)KeyHandle) < 0) {
        return g_orig.NtQueryKey(KeyHandle, KeyInformationClass, KeyInformation, Length, ResultLength);
    }
    wchar_t hive[64], canonical[WS_PATH_MAX];
    canonical[0] = 0;
    int isPseudo = 0;
    if (!ws_pseudo_key_path((HKEY)KeyHandle, hive, 64, canonical, WS_PATH_MAX, &isPseudo) || !isPseudo) {
        return WS_ST_INVALID_HANDLE;
    }
    const wchar_t *name = canonical[0] ? canonical : L"";
    ULONG nameBytes = (ULONG)(wcslen(name) * sizeof(wchar_t));
    ULONG fixedPart, dataOff, need;
    if (KeyInformationClass == 3u) {        /* KeyNameInformation: {NameLength; WCHAR Name[];} */
        fixedPart = 4u;
        dataOff = fixedPart;
        need = dataOff + nameBytes;
    } else if (KeyInformationClass == 2u) { /* KeyFullInformation */
        fixedPart = 48u;
        dataOff = fixedPart;
        need = dataOff;
    } else {                                 /* KeyBasicInformation */
        fixedPart = 16u;                     /* LastWriteTime(8) TitleIndex(4) NameLength(4) */
        dataOff = fixedPart;
        need = dataOff + nameBytes;
    }
    if (ResultLength) {
        *ResultLength = need;
    }
    if (!KeyInformation) {
        return WS_ST_BUFFER_TOO_SMALL;
    }
    if (Length < fixedPart) {
        return WS_ST_BUFFER_TOO_SMALL;
    }
    if (KeyInformationClass == 3u) {
        ws_kv_put32(KeyInformation, 0, nameBytes);
        if (nameBytes) memcpy((BYTE *)KeyInformation + dataOff, name, nameBytes);
    } else if (KeyInformationClass == 2u) {
        /* SubKeys/MaxNameLen/Values/MaxValueNameLen/MaxValueDataLen/SecurityDescriptor/LastWriteTime */
        for (ULONG off = 0; off < 40u; off += 4u) ws_kv_put32(KeyInformation, off, 0u);
        memset((BYTE *)KeyInformation + 40u, 0, 8u);
    } else {
        memset((BYTE *)KeyInformation, 0, 8u);       /* LastWriteTime = 0 */
        ws_kv_put32(KeyInformation, 8, 0u);          /* TitleIndex */
        ws_kv_put32(KeyInformation, 12, nameBytes);  /* NameLength */
        if (nameBytes) memcpy((BYTE *)KeyInformation + dataOff, name, nameBytes);
    }
    return (Length < need) ? WS_ST_BUFFER_OVERFLOW : WS_ST_SUCCESS;
}

LONG WINAPI ws_RegQueryValueExW(HKEY hKey, LPCWSTR lpValueName, LPDWORD lpReserved, LPDWORD lpType,
                                LPBYTE lpData, LPDWORD lpcbData)
{
    WS_STUCK("RegQueryValueExW");
    ws_stuck_path(lpValueName);
    ws_audit_reg("reg.query", hKey, NULL, lpValueName);
    /* ★ round-3：`Reg*` 按文档不设 last error，但本函数的调用链里有
     * `MultiByteToWideChar`/`HeapAlloc`/`HeapFree` 等**会**改它的 API；
     * 载体的 CLR 初始化期大量读注册表，被污染的 last error 会被
     * `Marshal.ThrowExceptionForHR` 读成"内部错误"（签名 A）。
     * 因此入口保存、出口还原。 */
    DWORD ws_saved_last_error = GetLastError();
    LONG rc = ws_query_value_ex(hKey, lpValueName, NULL, lpReserved, lpType, lpData, lpcbData, 0);
    SetLastError(ws_saved_last_error);
    return rc;
}

LONG WINAPI ws_RegQueryValueExA(HKEY hKey, LPCSTR lpValueName, LPDWORD lpReserved, LPDWORD lpType,
                                LPBYTE lpData, LPDWORD lpcbData)
{
    DWORD ws_saved_last_error = GetLastError();
    LONG rc = ws_query_value_ex(hKey, NULL, lpValueName, lpReserved, lpType, lpData, lpcbData, 1);
    SetLastError(ws_saved_last_error);
    return rc;
}

/* --------------------------------------------------------------- deletion */

static LONG ws_delete_key_inner(HKEY hKey, LPCWSTR lpSubKey, REGSAM samDesired);

/* ★ round-3c：删除键族的透明化薄包装（覆盖 `RegDeleteKeyExW`/`RegDeleteKeyW` 与两个 A 变体的转发）。 */
static LONG ws_delete_key(HKEY hKey, LPCWSTR lpSubKey, REGSAM samDesired)
{
    DWORD ws_saved_last_error = GetLastError();
    LONG rc = ws_delete_key_inner(hKey, lpSubKey, samDesired);
    SetLastError(ws_saved_last_error);
    return rc;
}

static LONG ws_delete_key_inner(HKEY hKey, LPCWSTR lpSubKey, REGSAM samDesired)
{
    wchar_t hive[64], canonical[WS_PATH_MAX];
    canonical[0] = 0;
    int isPseudo = 0, isBareRoot = 0;
    WsWriteVerdict verdict = ws_reg_write_ctx(hKey, lpSubKey, samDesired, L"RegDeleteKeyExW", hive, 64,
                                              canonical, WS_PATH_MAX, &isPseudo, &isBareRoot);
    if (verdict != WS_WRITE_STAGE) {
        if (verdict == WS_WRITE_PASSTHROUGH) {
            /* Unrepresentable in the overlay (32-bit view / foreign handle / value
             * on a hive root): the real API is the arbiter, and the UNSTAGED record
             * is already appended. */
            WS_TRACE("RegDeleteKeyExW: unstaged passthrough %ls", canonical);
            if (isPseudo) {
                HKEY root = ws_reg_real_root(hive);
                if (!root) {
                    return ERROR_FILE_NOT_FOUND;
                }
                return g_orig.RegDeleteKeyExW(root, ws_reg_rel_of(hive, canonical), samDesired, 0);
            }
            return g_orig.RegDeleteKeyExW(hKey, lpSubKey, samDesired, 0);
        }
        return ERROR_ACCESS_DENIED;
    }
    LSTATUS st = ws_rstore_key_delete(hive, ws_reg_rel_of(hive, canonical));
    if (st == ERROR_SUCCESS) {
        ws_reg_bump_generation();
    } else {
        ws_log("RegDeleteKeyExW refused: %lu (%ls)", (unsigned long)st, canonical);
    }
    return st;
}

LONG WINAPI ws_RegDeleteKeyExW(HKEY hKey, LPCWSTR lpSubKey, REGSAM samDesired, DWORD Reserved)
{
    WS_STUCK("RegDeleteKeyExW");
    ws_stuck_path(lpSubKey);
    ws_audit_reg("reg.deleteKey", hKey, lpSubKey, NULL);
    (void)Reserved;
    return ws_delete_key(hKey, lpSubKey, samDesired);
}

LONG WINAPI ws_RegDeleteKeyExA(HKEY hKey, LPCSTR lpSubKey, REGSAM samDesired, DWORD Reserved)
{
    /* ★ round-3c：A 变体自身的 `MultiByteToWideChar` 在钩子体内 ⇒ 钩子层透明化。 */
    DWORD ws_saved_last_error = GetLastError();
    wchar_t sub[WS_PATH_MAX];
    sub[0] = 0;
    if (lpSubKey) MultiByteToWideChar(CP_ACP, 0, lpSubKey, -1, sub, WS_PATH_MAX);
    (void)Reserved;
    LONG rc = ws_delete_key(hKey, sub[0] ? sub : NULL, samDesired);
    SetLastError(ws_saved_last_error);
    return rc;
}

LONG WINAPI ws_RegDeleteKeyW(HKEY hKey, LPCWSTR lpSubKey)
{
    return ws_delete_key(hKey, lpSubKey, 0);
}

LONG WINAPI ws_RegDeleteKeyA(HKEY hKey, LPCSTR lpSubKey)
{
    DWORD ws_saved_last_error = GetLastError();
    wchar_t sub[WS_PATH_MAX];
    sub[0] = 0;
    if (lpSubKey) MultiByteToWideChar(CP_ACP, 0, lpSubKey, -1, sub, WS_PATH_MAX);
    LONG rc = ws_delete_key(hKey, sub[0] ? sub : NULL, 0);
    SetLastError(ws_saved_last_error);
    return rc;
}

static LONG ws_delete_value_inner(HKEY hKey, LPCWSTR lpValueName);

/* ★ round-3c：删除值族的透明化薄包装（覆盖 `RegDeleteValueW` 与 `RegDeleteValueA` 的转发）。 */
static LONG ws_delete_value(HKEY hKey, LPCWSTR lpValueName)
{
    DWORD ws_saved_last_error = GetLastError();
    LONG rc = ws_delete_value_inner(hKey, lpValueName);
    SetLastError(ws_saved_last_error);
    return rc;
}

static LONG ws_delete_value_inner(HKEY hKey, LPCWSTR lpValueName)
{
    wchar_t hive[64], canonical[WS_PATH_MAX];
    canonical[0] = 0;
    int isPseudo = 0, isBareRoot = 0;
    WsWriteVerdict verdict = ws_reg_write_ctx(hKey, NULL, 0, L"RegDeleteValueW", hive, 64, canonical,
                                              WS_PATH_MAX, &isPseudo, &isBareRoot);
    if (verdict != WS_WRITE_STAGE) {
        if (verdict == WS_WRITE_PASSTHROUGH) {
            WS_TRACE("RegDeleteValueW: unstaged passthrough %ls", canonical);
            if (isPseudo) {
                return ws_reg_forward_delete_value(hive, canonical, lpValueName, NULL, 0);
            }
            return g_orig.RegDeleteValueW(hKey, lpValueName);
        }
        return ERROR_ACCESS_DENIED;
    }
    LSTATUS st = ws_rstore_value_delete(hive, ws_reg_rel_of(hive, canonical),
                                        lpValueName ? lpValueName : L"");
    if (st == ERROR_SUCCESS) {
        ws_reg_bump_generation();
    } else {
        ws_log("RegDeleteValueW refused: %lu (%ls)", (unsigned long)st, canonical);
    }
    return st;
}

LONG WINAPI ws_RegDeleteValueW(HKEY hKey, LPCWSTR lpValueName)
{
    WS_STUCK("RegDeleteValueW");
    ws_stuck_path(lpValueName);
    ws_audit_reg("reg.deleteValue", hKey, NULL, lpValueName);
    return ws_delete_value(hKey, lpValueName);
}

LONG WINAPI ws_RegDeleteValueA(HKEY hKey, LPCSTR lpValueName)
{
    DWORD ws_saved_last_error = GetLastError();
    wchar_t name[WS_PATH_MAX];
    name[0] = 0;
    if (lpValueName) MultiByteToWideChar(CP_ACP, 0, lpValueName, -1, name, WS_PATH_MAX);
    LONG rc = ws_delete_value(hKey, name);
    SetLastError(ws_saved_last_error);
    return rc;
}

/* ---------------------------------------------------- merged enumeration
 *
 * Enumeration MUST be the union of the overlay and the real hive. Returning the
 * overlay view alone is fatal for real workloads: .NET's certificate-store walk
 * opens keys like HKCU\Software\Microsoft\SystemCertificates\CA and would then
 * enumerate an empty overlay shell ("this store has no certificates"), which
 * kills PowerShell's InitialSessionState type initializer. Tombstoned names are
 * removed from the union.
 *
 * One-entry cache: PowerShell enumerates large keys sequentially, so rebuilding
 * the union per call is quadratic. The cache is invalidated by a generation
 * counter bumped on every registry mutation.
 */
#define WS_ENUM_MAX_NAMES 4096
#define WS_ENUM_NAME_CCH 256

typedef struct WsEnumName {
    wchar_t name[WS_ENUM_NAME_CCH];
} WsEnumName;

typedef struct WsEnumUnion {
    wchar_t canonical[WS_PATH_MAX];
    int kind; /* 0 = subkeys, 1 = values */
    int valid;
    int count;
    LONG gen;
    WsEnumName *names;
} WsEnumUnion;

static WsEnumUnion g_enumCache;
static volatile LONG g_regGen = 1;

static void ws_reg_bump_generation(void)
{
    InterlockedIncrement(&g_regGen);
}

static HKEY ws_reg_open_real(const wchar_t *hive, const wchar_t *rel, REGSAM sam)
{
    HKEY root = ws_reg_real_root(hive);
    if (!root || !rel || !rel[0]) {
        return NULL;
    }
    HKEY h = NULL;
    if (g_orig.RegOpenKeyExW(root, rel, 0, sam, &h) != ERROR_SUCCESS) {
        return NULL;
    }
    return h;
}

/* Does the overlay actually hold this key? If not, every read API is passed
 * through untouched: merging costs a full enumeration on every call and, worse,
 * a synthetic RegQueryInfoKey answer (e.g. a zero max-value length) makes callers
 * mis-size buffers -- that is what broke Winsock's catalog load (WSAStartup
 * 10107) and .NET's certificate store walk. */
static int ws_reg_overlay_has_key(const wchar_t *canonical)
{
    int exists = 0;
    if (!ws_t3_is_attached()) {
        return 0;
    }
    if (ws_t3_key_exists(canonical, &exists) != ERROR_SUCCESS) {
        return 0;
    }
    return exists;
}

HKEY ws_reg_open_real_pub(const wchar_t *hive, const wchar_t *rel, DWORD samDesired)
{
    return ws_reg_open_real(hive, rel, samDesired);
}

static int ws_reg_name_in_list(const WsEnumName *list, int count, const wchar_t *name)
{
    for (int i = 0; i < count; i++) {
        if (ws_wcscmp_ci(list[i].name, name) == 0) {
            return 1;
        }
    }
    return 0;
}

static void ws_reg_build_union(const wchar_t *hive, const wchar_t *rel, const wchar_t *canonical,
                               HKEY realHandle, int kind)
{
    LONG gen = g_regGen;
    if (g_enumCache.valid && g_enumCache.kind == kind && g_enumCache.gen == gen &&
        ws_wcscmp_ci(g_enumCache.canonical, canonical) == 0) {
        return;
    }
    if (!g_enumCache.names) {
        g_enumCache.names = (WsEnumName *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                                                    sizeof(WsEnumName) * WS_ENUM_MAX_NAMES);
        if (!g_enumCache.names) {
            g_enumCache.valid = 0;
            return;
        }
    }
    g_enumCache.valid = 0;
    ws_strlcpy_w(g_enumCache.canonical, canonical, WS_PATH_MAX);
    g_enumCache.kind = kind;
    g_enumCache.gen = gen;
    int count = 0;

    /* hard cap: a misbehaving value enum must never spin this loop forever */
    for (uint32_t i = 0; count < WS_ENUM_MAX_NAMES && i < (uint32_t)WS_ENUM_MAX_NAMES * 4u; i++) {
        wchar_t name[WS_ENUM_NAME_CCH];
        name[0] = 0;
        int rc;
        if (kind == 0) {
            rc = ws_rstore_key_enum(hive, rel, i, name, WS_ENUM_NAME_CCH);
        } else {
            uint32_t type = 0, len = 0, flags = 0;
            rc = ws_rstore_value_enum(hive, rel, i, name, WS_ENUM_NAME_CCH, &type, NULL, &len, &flags);
        }
        if (rc != 0) {
            break;
        }
        if (!name[0]) {
            /* EMPTY-DEFAULT-VALUE: index 0 of a value enum is the DEFAULT value and carries an
             * empty name; it is a real entry, not the end of the enumeration. Stopping here hid
             * every named value (step2a). Keys cannot have an empty name, so keys still stop. */
            if (kind == 0) {
                break;
            }
            continue;
        }
        ws_strlcpy_w(g_enumCache.names[count].name, name, WS_ENUM_NAME_CCH);
        count++;
    }

    HKEY owned = NULL;
    HKEY real = realHandle;
    if (!real) {
        real = owned = ws_reg_open_real(hive, rel, KEY_READ);
    }
    if (real) {
        for (DWORD i = 0; count < WS_ENUM_MAX_NAMES; i++) {
            wchar_t name[WS_ENUM_NAME_CCH];
            DWORD cch = WS_ENUM_NAME_CCH;
            LONG rc;
            name[0] = 0;
            if (kind == 0) {
                rc = g_orig.RegEnumKeyExW(real, i, name, &cch, NULL, NULL, NULL, NULL);
            } else {
                DWORD type = 0;
                rc = g_orig.RegEnumValueW(real, i, name, &cch, NULL, &type, NULL, NULL);
            }
            if (rc != ERROR_SUCCESS) {
                break;
            }
            if (!name[0] || ws_reg_name_in_list(g_enumCache.names, count, name)) {
                continue;
            }
            wchar_t childCanonical[WS_PATH_MAX];
            size_t pos = 0;
            childCanonical[0] = 0;
            if (ws_append_w(childCanonical, WS_PATH_MAX, &pos, canonical) &&
                ws_append_w(childCanonical, WS_PATH_MAX, &pos, L"\\") &&
                ws_append_w(childCanonical, WS_PATH_MAX, &pos, name) &&
                ws_rstore_is_tombstoned(childCanonical, L"", kind == 0)) {
                continue;
            }
            ws_strlcpy_w(g_enumCache.names[count].name, name, WS_ENUM_NAME_CCH);
            count++;
        }
        if (owned) {
            g_orig.RegCloseKey(owned);
        }
    }
    g_enumCache.count = count;
    g_enumCache.valid = 1;
}

static int ws_reg_union_lookup(const wchar_t *hive, const wchar_t *rel, const wchar_t *canonical,
                               HKEY realHandle, int kind, DWORD index, wchar_t *out, DWORD cch)
{
    ws_reg_build_union(hive, rel, canonical, realHandle, kind);
    /* task-21 instrumentation (log only): which source produced the union cache, and how many
     * entries it holds. kind=0 keys / kind=1 values; real=1 means the real-hive fallback. */
    if (index == 0) {
        ws_log("REGDBG union pid=%lu kind=%s hive=%ls rel=%ls canonical=%ls real=%d index=%lu valid=%d count=%d",
               (unsigned long)GetCurrentProcessId(), kind ? "values" : "keys",
               hive ? hive : L"(null)", rel ? rel : L"(null)",
               canonical ? canonical : L"(null)", realHandle ? 1 : 0,
               (unsigned long)index, g_enumCache.valid ? 1 : 0, (int)g_enumCache.count);
    }
    if (!g_enumCache.valid || index >= (DWORD)g_enumCache.count) {
        return 0;
    }
    ws_strlcpy_w(out, g_enumCache.names[index].name, cch);
    return 1;
}

/* ------------------------------------------------------------- misc / info */

LONG WINAPI ws_RegCloseKey(HKEY hKey)
{
    /* ★ round-3：最热的一对（每次注册表读都以 CloseKey 收尾）。 */
    DWORD ws_saved_last_error = GetLastError();
    if (ws_pseudo_key_is(hKey)) {
        ws_pseudo_key_free(hKey);
        ws_log("REGDBG api=RegCloseKey pid=%lu hKey=%p isPseudo=1 ret=0",
               (unsigned long)GetCurrentProcessId(), (void *)hKey);
        SetLastError(ws_saved_last_error);
        return ERROR_SUCCESS;
    }
    LONG rc = g_orig.RegCloseKey(hKey);
        ws_log("REGDBG api=RegCloseKey pid=%lu hKey=%p ret=%ld", (unsigned long)GetCurrentProcessId(), (void *)hKey, (long)rc);
SetLastError(ws_saved_last_error);
    return rc;
}

LONG WINAPI ws_RegFlushKey(HKEY hKey)
{
    DWORD ws_saved_last_error = GetLastError();
    if (ws_pseudo_key_is(hKey)) {
        /* staging writes are journalled and flushed synchronously */
        SetLastError(ws_saved_last_error);
        return ERROR_SUCCESS;
    }
    LONG rc = g_orig.RegFlushKey(hKey);
    SetLastError(ws_saved_last_error);
    return rc;
}

static LONG ws_query_info_key_inner(HKEY hKey, LPWSTR lpClass, LPDWORD lpcchClass, LPDWORD lpReserved,
                                    LPDWORD lpcSubKeys, LPDWORD lpcbMaxSubKeyLen, LPDWORD lpcbMaxClassLen,
                                    LPDWORD lpcValues, LPDWORD lpcbMaxValueNameLen, LPDWORD lpcbMaxValueLen,
                                    LPDWORD lpcbSecurityDescriptor, PFILETIME lpftLastWriteTime);

/* ★ round-3b：QueryInfoKey 族的透明化薄包装（枚举计数在 CLR/安装器路径上很热）。 */
LONG WINAPI ws_RegQueryInfoKeyW(HKEY hKey, LPWSTR lpClass, LPDWORD lpcchClass, LPDWORD lpReserved,
                                LPDWORD lpcSubKeys, LPDWORD lpcbMaxSubKeyLen, LPDWORD lpcbMaxClassLen,
                                LPDWORD lpcValues, LPDWORD lpcbMaxValueNameLen, LPDWORD lpcbMaxValueLen,
                                LPDWORD lpcbSecurityDescriptor, PFILETIME lpftLastWriteTime)
{
    DWORD ws_saved_last_error = GetLastError();
    LONG rc = ws_query_info_key_inner(hKey, lpClass, lpcchClass, lpReserved, lpcSubKeys,
                                      lpcbMaxSubKeyLen, lpcbMaxClassLen, lpcValues, lpcbMaxValueNameLen,
                                      lpcbMaxValueLen, lpcbSecurityDescriptor, lpftLastWriteTime);
        ws_log("REGDBG api=RegQueryInfoKeyW pid=%lu hKey=%p ret=%ld", (unsigned long)GetCurrentProcessId(), (void *)hKey, (long)rc);
SetLastError(ws_saved_last_error);
    return rc;
}

static LONG ws_query_info_key_inner(HKEY hKey, LPWSTR lpClass, LPDWORD lpcchClass, LPDWORD lpReserved,
                                    LPDWORD lpcSubKeys, LPDWORD lpcbMaxSubKeyLen, LPDWORD lpcbMaxClassLen,
                                    LPDWORD lpcValues, LPDWORD lpcbMaxValueNameLen, LPDWORD lpcbMaxValueLen,
                                    LPDWORD lpcbSecurityDescriptor, PFILETIME lpftLastWriteTime)
{
    wchar_t hive[64], canonical[WS_PATH_MAX];
    canonical[0] = 0;
    int isPseudo = 0, isBareRoot = 0;
    /* task-17 扩展（与 ws_query_value_ex 同源）：伪句柄**绝不**直通 advapi32（＝ERROR_INVALID_HANDLE(6)）：
     * 先用伪句柄表取回 ctx 交给覆盖层服务，取不回则 fail-closed。 */
    int ctxOk = ws_reg_read_ctx(hKey, NULL, 0, hive, 64, canonical, WS_PATH_MAX, &isPseudo, &isBareRoot);
    int canServe = ctxOk && !isBareRoot;
    int pRecovered = 0;
    if (!canServe && isPseudo &&
        ws_pseudo_key_path(hKey, hive, 64, canonical, WS_PATH_MAX, &pRecovered) && pRecovered) {
        canServe = 1;
    }
    if (!canServe) {
        if (isPseudo) {
            ws_log("REGDBG branch=fail-closed(enum/info) pid=%lu hKey=%p",
                   (unsigned long)GetCurrentProcessId(), (void *)hKey);
            return ERROR_FILE_NOT_FOUND;
        }
        return g_orig.RegQueryInfoKeyW(hKey, lpClass, lpcchClass, lpReserved, lpcSubKeys,
                                       lpcbMaxSubKeyLen, lpcbMaxClassLen, lpcValues,
                                       lpcbMaxValueNameLen, lpcbMaxValueLen, lpcbSecurityDescriptor,
                                       lpftLastWriteTime);
    }
    const wchar_t *rel = ws_reg_rel_of(hive, canonical);
    HKEY real = isPseudo ? NULL : hKey;
    if (!isPseudo && !ws_reg_overlay_has_key(canonical)) {
        return g_orig.RegQueryInfoKeyW(hKey, lpClass, lpcchClass, lpReserved, lpcSubKeys,
                                       lpcbMaxSubKeyLen, lpcbMaxClassLen, lpcValues,
                                       lpcbMaxValueNameLen, lpcbMaxValueLen, lpcbSecurityDescriptor,
                                       lpftLastWriteTime);
    }
    uint32_t keyCount = 0, valueCount = 0, maxNameLen = 0, maxSubKeyLen = 0, maxValueLen = 0;
    for (uint32_t i = 0;; i++) {
        wchar_t name[WS_ENUM_NAME_CCH];
        if (!ws_reg_union_lookup(hive, rel, canonical, real, 0, i, name, WS_ENUM_NAME_CCH)) break;
        uint32_t nl = (uint32_t)((wcslen(name) + 1) * sizeof(wchar_t));
        if (nl > maxSubKeyLen) maxSubKeyLen = nl;
        keyCount++;
    }
    for (uint32_t i = 0;; i++) {
        wchar_t name[WS_ENUM_NAME_CCH];
        if (!ws_reg_union_lookup(hive, rel, canonical, real, 1, i, name, WS_ENUM_NAME_CCH)) {
            ws_log("REGDBG qik-unionfail pid=%lu index=%lu hive=%ls rel=%ls canonical=%ls real=%d",
                   (unsigned long)GetCurrentProcessId(), (unsigned long)i, hive,
                   rel ? rel : L"(null)", canonical, real ? 1 : 0);
            break;
        }
        uint32_t nl = (uint32_t)((wcslen(name) + 1) * sizeof(wchar_t));
        if (nl > maxNameLen) maxNameLen = nl;
        /* Value length must be a real number: a caller that sizes a buffer from
         * this would otherwise under-allocate. Query the overlay, else the real
         * hive, else report what is already known. */
        uint32_t tv = 0, lv = 0, fv = 0;
        if (ws_rstore_value_get(hive, rel, name, &tv, NULL, &lv, &fv) == 0) {
            if (lv > maxValueLen) maxValueLen = lv;
        } else {
            HKEY owned = NULL;
            HKEY rk = real ? real : (owned = ws_reg_open_real(hive, rel, KEY_READ));
            if (rk) {
                DWORD cb = 0, t2 = 0;
                if (g_orig.RegQueryValueExW(rk, name, NULL, &t2, NULL, &cb) == ERROR_SUCCESS && cb > maxValueLen) {
                    maxValueLen = cb;
                }
                if (owned) g_orig.RegCloseKey(owned);
            }
        }
        valueCount++;
    }
    if (lpReserved) *lpReserved = 0;
    if (lpClass && lpcchClass && *lpcchClass) {
        lpClass[0] = 0;
        *lpcchClass = 0;
    }
    if (lpftLastWriteTime) memset(lpftLastWriteTime, 0, sizeof(*lpftLastWriteTime));
    if (lpcbSecurityDescriptor) *lpcbSecurityDescriptor = 0;
    if (lpcbMaxClassLen) *lpcbMaxClassLen = 0;
    if (lpcSubKeys) *lpcSubKeys = keyCount;
    if (lpcValues) *lpcValues = valueCount;
    if (lpcbMaxSubKeyLen) *lpcbMaxSubKeyLen = maxSubKeyLen;
    if (lpcbMaxValueNameLen) *lpcbMaxValueNameLen = maxNameLen;
    if (lpcbMaxValueLen) *lpcbMaxValueLen = maxValueLen;
    /* task-20 instrumentation (log only): the values actually written back to the caller.
     * lpcValues/maxNameLen are real; maxValueLenWritten is what :1865 publishes (0);
     * maxValueLenComputed is what the loops above derived. */
    ws_log("REGDBG qik pid=%lu hKey=%p isPseudo=%d ret=%ld lpcValues=%lu maxNameLen=%lu maxValueLenWritten=%lu maxValueLenComputed=%lu",
           (unsigned long)GetCurrentProcessId(), (void *)hKey, isPseudo, (long)ERROR_SUCCESS,
           (unsigned long)valueCount, (unsigned long)maxNameLen,
           (unsigned long)(lpcbMaxValueLen ? *lpcbMaxValueLen : 0ul),
           (unsigned long)maxValueLen);
    return ERROR_SUCCESS;
}

static LONG ws_enum_value_inner(HKEY hKey, DWORD dwIndex, LPWSTR lpValueName, LPDWORD lpcchValueName,
                                LPDWORD lpReserved, LPDWORD lpType, LPBYTE lpData, LPDWORD lpcbData);

/* ★ round-3b：枚举族钩子的**透明化薄包装**（同 open/query/close 族，见 ws_open_key 的说明）。
 * 枚举会在 CLR 初始化期被大量调用；`Reg*` 按文档不设 last error，但本函数内部的
 * `ws_reg_read_ctx` / `ws_reg_union_lookup` / `memcpy` 前的转换与分配都会改它。
 * 用薄包装覆盖全部出口，只改一处。 */
LONG WINAPI ws_RegEnumValueW(HKEY hKey, DWORD dwIndex, LPWSTR lpValueName, LPDWORD lpcchValueName,
                             LPDWORD lpReserved, LPDWORD lpType, LPBYTE lpData, LPDWORD lpcbData)
{
    DWORD ws_saved_last_error = GetLastError();
    LONG rc = ws_enum_value_inner(hKey, dwIndex, lpValueName, lpcchValueName, lpReserved, lpType,
                                  lpData, lpcbData);
        ws_log("REGDBG api=RegEnumValueW pid=%lu hKey=%p ret=%ld", (unsigned long)GetCurrentProcessId(), (void *)hKey, (long)rc);
SetLastError(ws_saved_last_error);
    return rc;
}

static LONG ws_enum_value_inner(HKEY hKey, DWORD dwIndex, LPWSTR lpValueName, LPDWORD lpcchValueName,
                                LPDWORD lpReserved, LPDWORD lpType, LPBYTE lpData, LPDWORD lpcbData)
{
    wchar_t hive[64], canonical[WS_PATH_MAX];
    canonical[0] = 0;
    int isPseudo = 0, isBareRoot = 0;
    /* task-17 扩展（与 ws_query_value_ex 同源）：伪句柄**绝不**直通 advapi32（＝ERROR_INVALID_HANDLE(6)）：
     * 先用伪句柄表取回 ctx 交给覆盖层服务，取不回则 fail-closed。 */
    int ctxOk = ws_reg_read_ctx(hKey, NULL, 0, hive, 64, canonical, WS_PATH_MAX, &isPseudo, &isBareRoot);
    int canServe = ctxOk && !isBareRoot;
    int pRecovered = 0;
    if (!canServe && isPseudo &&
        ws_pseudo_key_path(hKey, hive, 64, canonical, WS_PATH_MAX, &pRecovered) && pRecovered) {
        canServe = 1;
    }
    if (!canServe) {
        if (isPseudo) {
            ws_log("REGDBG branch=fail-closed(enum/info) pid=%lu hKey=%p",
                   (unsigned long)GetCurrentProcessId(), (void *)hKey);
            return ERROR_FILE_NOT_FOUND;
        }
        return g_orig.RegEnumValueW(hKey, dwIndex, lpValueName, lpcchValueName, lpReserved, lpType,
                                    lpData, lpcbData);
    }
    const wchar_t *rel = ws_reg_rel_of(hive, canonical);
    HKEY real = isPseudo ? NULL : hKey;
    if (!isPseudo && !ws_reg_overlay_has_key(canonical)) {
        return g_orig.RegEnumValueW(hKey, dwIndex, lpValueName, lpcchValueName, lpReserved, lpType,
                                    lpData, lpcbData);
    }
    if (lpReserved) *lpReserved = 0;

    wchar_t name[WS_ENUM_NAME_CCH];
    if (!ws_reg_union_lookup(hive, rel, canonical, real, 1, dwIndex, name, WS_ENUM_NAME_CCH)) {
        return ERROR_NO_MORE_ITEMS;
    }
    if (lpValueName && lpcchValueName) {
        DWORD need = (DWORD)(wcslen(name) + 1);
        if (*lpcchValueName < need) {
            *lpcchValueName = need;
            return ERROR_MORE_DATA;
        }
        memcpy(lpValueName, name, need * sizeof(wchar_t));
        *lpcchValueName = need - 1;
    }
    /* Prefer the overlay's value, otherwise read the same name from the real key. */
    uint32_t t2 = 0, l2 = lpcbData ? *lpcbData : 0, f2 = 0;
    if (ws_rstore_value_get(hive, rel, name, &t2, lpData, &l2, &f2) == 0) {
        if (lpType) *lpType = t2;
        if (lpcbData) *lpcbData = l2;
        return ERROR_SUCCESS;
    }
    HKEY owned = NULL;
    HKEY realKey = real;
    if (!realKey) {
        realKey = owned = ws_reg_open_real(hive, rel, KEY_READ);
    }
    if (realKey) {
        for (DWORD i = 0;; i++) {
            wchar_t realName[WS_ENUM_NAME_CCH];
            DWORD cch = WS_ENUM_NAME_CCH;
            DWORD t = 0;
            realName[0] = 0;
            if (g_orig.RegEnumValueW(realKey, i, realName, &cch, NULL, &t, NULL, NULL) != ERROR_SUCCESS) {
                break;
            }
            if (ws_wcscmp_ci(realName, name) == 0) {
                DWORD cb = lpcbData ? *lpcbData : 0;
                LONG st = g_orig.RegQueryValueExW(realKey, realName, NULL, &t, lpData, &cb);
                if (lpType) *lpType = t;
                if (lpcbData) *lpcbData = cb;
                if (owned) g_orig.RegCloseKey(owned);
                return (st == ERROR_SUCCESS || st == ERROR_MORE_DATA) ? st : ERROR_SUCCESS;
            }
        }
        if (owned) g_orig.RegCloseKey(owned);
    }
    if (lpType) *lpType = REG_NONE;
    if (lpcbData) *lpcbData = 0;
    return ERROR_SUCCESS;
}

static LONG ws_enum_key_ex_inner(HKEY hKey, DWORD dwIndex, LPWSTR lpName, LPDWORD lpcchName,
                                 LPDWORD lpReserved, LPWSTR lpClass, LPDWORD lpcchClass,
                                 PFILETIME lpftLastWriteTime);

/* ★ round-3b：同 ws_RegEnumValueW —— 枚举子键族的透明化薄包装。 */
LONG WINAPI ws_RegEnumKeyExW(HKEY hKey, DWORD dwIndex, LPWSTR lpName, LPDWORD lpcchName,
                             LPDWORD lpReserved, LPWSTR lpClass, LPDWORD lpcchClass, PFILETIME lpftLastWriteTime)
{
    DWORD ws_saved_last_error = GetLastError();
    LONG rc = ws_enum_key_ex_inner(hKey, dwIndex, lpName, lpcchName, lpReserved, lpClass, lpcchClass,
                                   lpftLastWriteTime);
        ws_log("REGDBG api=RegEnumKeyExW pid=%lu hKey=%p ret=%ld", (unsigned long)GetCurrentProcessId(), (void *)hKey, (long)rc);
SetLastError(ws_saved_last_error);
    return rc;
}

static LONG ws_enum_key_ex_inner(HKEY hKey, DWORD dwIndex, LPWSTR lpName, LPDWORD lpcchName,
                                 LPDWORD lpReserved, LPWSTR lpClass, LPDWORD lpcchClass,
                                 PFILETIME lpftLastWriteTime)
{
    wchar_t hive[64], canonical[WS_PATH_MAX];
    canonical[0] = 0;
    int isPseudo = 0, isBareRoot = 0;
    /* task-17 扩展（与 ws_query_value_ex 同源）：伪句柄**绝不**直通 advapi32（＝ERROR_INVALID_HANDLE(6)）：
     * 先用伪句柄表取回 ctx 交给覆盖层服务，取不回则 fail-closed。 */
    int ctxOk = ws_reg_read_ctx(hKey, NULL, 0, hive, 64, canonical, WS_PATH_MAX, &isPseudo, &isBareRoot);
    int canServe = ctxOk && !isBareRoot;
    int pRecovered = 0;
    if (!canServe && isPseudo &&
        ws_pseudo_key_path(hKey, hive, 64, canonical, WS_PATH_MAX, &pRecovered) && pRecovered) {
        canServe = 1;
    }
    if (!canServe) {
        if (isPseudo) {
            ws_log("REGDBG branch=fail-closed(enum/info) pid=%lu hKey=%p",
                   (unsigned long)GetCurrentProcessId(), (void *)hKey);
            return ERROR_FILE_NOT_FOUND;
        }
        return g_orig.RegEnumKeyExW(hKey, dwIndex, lpName, lpcchName, lpReserved, lpClass, lpcchClass,
                                    lpftLastWriteTime);
    }
    const wchar_t *rel = ws_reg_rel_of(hive, canonical);
    HKEY real = isPseudo ? NULL : hKey;
    if (!isPseudo && !ws_reg_overlay_has_key(canonical)) {
        return g_orig.RegEnumKeyExW(hKey, dwIndex, lpName, lpcchName, lpReserved, lpClass, lpcchClass,
                                    lpftLastWriteTime);
    }
    wchar_t name[WS_ENUM_NAME_CCH];
    if (!ws_reg_union_lookup(hive, rel, canonical, real, 0, dwIndex, name, WS_ENUM_NAME_CCH)) {
        return ERROR_NO_MORE_ITEMS;
    }
    if (lpReserved) *lpReserved = 0;
    if (lpClass && lpcchClass) *lpcchClass = 0;
    if (lpftLastWriteTime) memset(lpftLastWriteTime, 0, sizeof(*lpftLastWriteTime));
    if (lpName && lpcchName) {
        DWORD need = (DWORD)(wcslen(name) + 1);
        if (*lpcchName < need) {
            *lpcchName = need;
            return ERROR_MORE_DATA;
        }
        memcpy(lpName, name, need * sizeof(wchar_t));
        *lpcchName = need - 1;
    }
    return ERROR_SUCCESS;
}