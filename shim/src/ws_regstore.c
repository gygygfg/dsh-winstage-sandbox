/* WinStageSandbox -- T4 shim: registry staging provider (T3-aligned).
 *
 * Model (docs/T3-??md ?4.4):
 *   - The overlay is the app hive (<sessionDir>\registry\overlay.hive) and the
 *     WAL is <sessionDir>\registry\overlay.journal. There is no second store.
 *   - LAZY MATERIALIZATION: opening/creating a key that already exists in the
 *     real hive is NOT a change. It is passed through to the real API and only
 *     recorded when something is actually written. This is what keeps pure reads
 *     (e.g. .NET walking the certificate stores) out of the candidate queue --
 *     without it the approval panel drowns in phantom changes, and reads through
 *     an empty overlay key would shadow the real hive's values (which is what
 *     broke PowerShell's InitialSessionState type initializer).
 *   - The bare hive root (HKEY_CURRENT_USER with an empty subkey) has no overlay
 *     representation: such handles are passed through, never replaced by a
 *     pseudo handle.
 *   - Paths use short hive names (HKCR/HKCU/HKLM/HKU/HKPD/HKCC) and map
 *     identically into the app hive: HKCU\Software\X -> "HKCU\Software\X".
 *   - WAL-first: every mutation appends + flushes a record before the app hive
 *     is touched; a failed append fails the call.
 */
#include "winstage_internal.h"

#include <winreg.h>

#define WS_RS_MAX_DENY 32

/* The app hive's security descriptor is inherited from the hive file. Measured
 * with shim/out/winstage-probe.exe `appkey` (run WITHOUT the shim): loading with
 * KEY_ALL_ACCESS and creating subkeys with KEY_ALL_ACCESS or KEY_READ|KEY_WRITE
 * both return ERROR_SUCCESS. Requesting the same here keeps the shim on the
 * proven recipe (an unusual extra right such as KEY_NOTIFY is not needed). */
#define WS_APPKEY_SAM (KEY_READ | KEY_WRITE)

/* in-process tombstones (see the limitation note in docs/T4-shim?.md) */
#define WS_RS_MAX_TOMB 128
typedef struct WsTomb {
    wchar_t canonical[WS_PATH_MAX];
    wchar_t name[256];
    int isKey;
} WsTomb;

static WsTomb g_tombs[WS_RS_MAX_TOMB];
static int g_tombCount;

static void tomb_add(const wchar_t *canonical, const wchar_t *name, int isKey)
{
    for (int i = 0; i < g_tombCount; i++) {
        if (ws_wcscmp_ci(g_tombs[i].canonical, canonical) == 0 &&
            ws_wcscmp_ci(g_tombs[i].name, name ? name : L"") == 0 && g_tombs[i].isKey == isKey) {
            return;
        }
    }
    if (g_tombCount >= WS_RS_MAX_TOMB) {
        return;
    }
    ws_strlcpy_w(g_tombs[g_tombCount].canonical, canonical, WS_PATH_MAX);
    ws_strlcpy_w(g_tombs[g_tombCount].name, name ? name : L"", 256);
    g_tombs[g_tombCount].isKey = isKey;
    g_tombCount++;
}

static void tomb_clear(const wchar_t *canonical, const wchar_t *name, int isKey)
{
    for (int i = 0; i < g_tombCount; i++) {
        if (g_tombs[i].isKey == isKey &&
            ws_wcscmp_ci(g_tombs[i].canonical, canonical) == 0 &&
            ws_wcscmp_ci(g_tombs[i].name, name ? name : L"") == 0) {
            g_tombs[i] = g_tombs[g_tombCount - 1];
            g_tombCount--;
            return;
        }
    }
}

static int tomb_has(const wchar_t *canonical, const wchar_t *name, int isKey)
{
    for (int i = 0; i < g_tombCount; i++) {
        if (g_tombs[i].isKey == isKey &&
            ws_wcscmp_ci(g_tombs[i].canonical, canonical) == 0 &&
            ws_wcscmp_ci(g_tombs[i].name, name ? name : L"") == 0) {
            return 1;
        }
    }
    return 0;
}

/* ------------------------------------------------------------------ paths */

const wchar_t *ws_short_hive_of(HKEY hive)
{
    if (hive == HKEY_CURRENT_USER) return L"HKCU";
    if (hive == HKEY_LOCAL_MACHINE) return L"HKLM";
    if (hive == HKEY_CLASSES_ROOT) return L"HKCR";
    if (hive == HKEY_USERS) return L"HKU";
    if (hive == HKEY_CURRENT_CONFIG) return L"HKCC";
    if (hive == HKEY_PERFORMANCE_DATA) return L"HKPD";
    return NULL;
}

/* Build the canonical registry path for (hKey, lpSubKey).
 * Returns 0 when the path cannot be derived (caller must fail closed).
 * *isBareHiveRoot is set when the result is just the hive root itself. */
int ws_rstore_canonical(HKEY hKey, LPCWSTR lpSubKey, wchar_t *hiveShort, DWORD hiveCch,
                        wchar_t *canonical, DWORD canonicalCch, int *isPseudo, int *isBareHiveRoot)
{
    if (isPseudo) *isPseudo = 0;
    if (isBareHiveRoot) *isBareHiveRoot = 0;
    wchar_t rel[WS_PATH_MAX];
    rel[0] = 0;
    if (lpSubKey && lpSubKey[0] && !ws_normalize_key_path(lpSubKey, rel, WS_PATH_MAX)) {
        return 0;
    }
    wchar_t hive[64];
    hive[0] = 0;
    if (ws_pseudo_key_path(hKey, hive, 64, canonical, canonicalCch, isPseudo)) {
        /* pseudo handle: its stored path is the base */
        if (rel[0]) {
            wchar_t combined[WS_PATH_MAX];
            size_t pos = 0;
            combined[0] = 0;
            if (!ws_append_w(combined, WS_PATH_MAX, &pos, canonical) ||
                !ws_append_w(combined, WS_PATH_MAX, &pos, L"\\") ||
                !ws_append_w(combined, WS_PATH_MAX, &pos, rel)) {
                return 0;
            }
            ws_strlcpy_w(canonical, combined, canonicalCch);
        }
        ws_strlcpy_w(hiveShort, hive, hiveCch);
        return canonical[0] != 0;
    }
    const wchar_t *shortName = ws_short_hive_of(hKey);
    if (shortName) {
        ws_strlcpy_w(hive, shortName, 64);
    } else {
        /* An already-open real handle: ask the kernel for its name. */
        if (!ws_handle_reg_path(hKey, hive, 64, canonical, canonicalCch)) {
            return 0;
        }
        if (rel[0]) {
            wchar_t combined[WS_PATH_MAX];
            size_t pos = 0;
            combined[0] = 0;
            if (canonical[0]) {
                if (!ws_append_w(combined, WS_PATH_MAX, &pos, canonical) ||
                    !ws_append_w(combined, WS_PATH_MAX, &pos, L"\\")) {
                    return 0;
                }
            }
            if (!ws_append_w(combined, WS_PATH_MAX, &pos, rel)) {
                return 0;
            }
            ws_strlcpy_w(canonical, combined, canonicalCch);
        }
        ws_strlcpy_w(hiveShort, hive, hiveCch);
        if (isBareHiveRoot && canonical[0] && !wcschr(canonical, L'\\')) {
            *isBareHiveRoot = 1;
        }
        return canonical[0] != 0;
    }
    /* predefined root + relative subkey */
    size_t pos = 0;
    canonical[0] = 0;
    if (!ws_append_w(canonical, canonicalCch, &pos, hive)) {
        return 0;
    }
    if (rel[0]) {
        if (!ws_append_w(canonical, canonicalCch, &pos, L"\\") ||
            !ws_append_w(canonical, canonicalCch, &pos, rel)) {
            return 0;
        }
    } else if (isBareHiveRoot) {
        *isBareHiveRoot = 1;
    }
    ws_strlcpy_w(hiveShort, hive, hiveCch);
    return 1;
}

/* container chain (excludes the bare hive root), appended to `out` as a
 * NULL-separated list of at most 24 levels; returns the level count. */
#define WS_RS_MAX_LEVELS 24

/* Container chain for a canonical path: every level strictly below the hive
 * root, ending with the path itself. T3 requires the bare hive root to be
 * excluded -- it always exists, so a CREATE_KEY record for it would be a
 * phantom change (and creating "HKCU" inside the app hive fails). */
static int build_chain(const wchar_t *canonical, wchar_t levels[WS_RS_MAX_LEVELS][WS_PATH_MAX])
{
    const wchar_t *first = wcschr(canonical, L'\\');
    if (!first || !first[1]) {
        return 0; /* bare hive root: no overlay representation */
    }
    int count = 0;
    for (const wchar_t *p = first + 1; *p; p++) {
        if (*p == L'\\' && count < WS_RS_MAX_LEVELS) {
            size_t n = (size_t)(p - canonical);
            memcpy(levels[count], canonical, n * sizeof(wchar_t));
            levels[count][n] = 0;
            count++;
        }
    }
    if (count < WS_RS_MAX_LEVELS) {
        ws_strlcpy_w(levels[count++], canonical, WS_PATH_MAX);
    }
    return count;
}
/* Materialize the overlay key chain for `canonical`, WAL-first, but only for the
 * levels that the overlay does not already have. CREATE_KEY records are emitted
 * here (on an actual mutation) and by ws_rstore_key_materialize() for a key the
 * caller is creating outright; both go through this function's level/record
 * rules, so there is exactly one place that decides what a CREATE_KEY means. */
static LSTATUS materialize_chain(const wchar_t *canonical, HKEY *keyOut)
{
    wchar_t levels[WS_RS_MAX_LEVELS][WS_PATH_MAX];
    int count = build_chain(canonical, levels);
    if (count <= 0) {
        /* The bare hive root has no container level inside the app hive. The
         * registry hooks classify that case as UNSTAGEABLE (passthrough to the
         * real root handle + UNSTAGED record) BEFORE reaching this provider, so
         * landing here means a caller bypassed the hook layer: refuse rather
         * than write to the wrong place. */
        ws_log_w(L"materialize_chain: no container level for", canonical);
        return ERROR_ACCESS_DENIED;
    }
    for (int i = 0; i < count; i++) {
        int exists = 0;
        LSTATUS st = ws_t3_key_exists(levels[i], &exists);
        if (st != ERROR_SUCCESS) {
            ws_log("materialize_chain: key_exists(%ls) failed %lu", levels[i], (unsigned long)st);
            return st;
        }
        if (exists) {
            continue;
        }
        /* Net-change rule (T3 v1.2 ?11.2): a container level that already exists
         * in the REAL hive is not a change, so it gets no WAL record -- it is
         * only created in the app hive to hold the child. */
        int realHas = 0;
        {
            const wchar_t *bs = wcschr(levels[i], L'\\');
            wchar_t levelHive[64];
            size_t hn = bs ? (size_t)(bs - levels[i]) : wcslen(levels[i]);
            if (hn < 64) {
                memcpy(levelHive, levels[i], hn * sizeof(wchar_t));
                levelHive[hn] = 0;
                HKEY realProbe = ws_reg_open_real_pub(levelHive, bs ? bs + 1 : L"", KEY_READ);
                if (realProbe) {
                    realHas = 1;
                    g_orig.RegCloseKey(realProbe);
                }
            }
        }
        if (!realHas) {
            /* DDL must be journalled before it happens (WAL-first). */
            st = ws_t3_record_create_key(levels[i]);
            if (st != ERROR_SUCCESS) {
                ws_log("materialize_chain: journal append(%ls) failed %lu", levels[i], (unsigned long)st);
                return st;
            }
        }
        HKEY h = NULL;
        st = ws_t3_open_key(levels[i], 1, WS_APPKEY_SAM, &h);
        if (st != ERROR_SUCCESS) {
            ws_log("materialize_chain: create app-hive key(%ls) failed %lu", levels[i], (unsigned long)st);
            return st;
        }
        if (i == count - 1) {
            *keyOut = h;
        } else {
            g_orig.RegCloseKey(h);
        }
    }
    if (*keyOut == NULL) {
        LSTATUS st = ws_t3_open_key(canonical, 0, WS_APPKEY_SAM, keyOut);
        if (st != ERROR_SUCCESS) {
            return st;
        }
    }
    return ERROR_SUCCESS;
}

/* ------------------------------------------------------ provider: key layer */

/**
 * Entry point for the "RegCreateKeyExW really is creating a new key" branch:
 * materialize the new key in the overlay IMMEDIATELY.
 *
 * Why immediately (fix, 2026-09-30): the common caller sequence is
 * create -> close -> open/write **by path** again -- PowerShell's `New-Item -Force`
 * followed by `New-ItemProperty` is exactly that. The old code returned a pseudo
 * handle from this branch and wrote nothing ("the WAL record is deferred to the
 * first actual write"), so the later path-based open missed the overlay, fell
 * through to the REAL hive and got FILE_NOT_FOUND (observed symptom:
 * `ItemNotFoundException` from PowerShell, and nothing in the real hive either).
 *
 * Record rules are reused from materialize_chain: CREATE_KEY is journaled
 * (WAL-first) only for levels that also do not exist in the real hive; container
 * levels the real hive already has are app-hive-only and get no record.
 * Creating a key is itself a net change, which is exactly why it belongs in the
 * candidate list.
 */
int ws_rstore_key_materialize(const wchar_t *hive, const wchar_t *subkey)
{
    if (!hive || !hive[0]) {
        return ERROR_INVALID_PARAMETER;
    }
    wchar_t canonical[WS_PATH_MAX];
    size_t pos = 0;
    canonical[0] = 0;
    if (!ws_append_w(canonical, WS_PATH_MAX, &pos, hive)) {
        return ERROR_INVALID_PARAMETER;
    }
    if (subkey && subkey[0]) {
        if (!ws_append_w(canonical, WS_PATH_MAX, &pos, L"\\") ||
            !ws_append_w(canonical, WS_PATH_MAX, &pos, subkey)) {
            return ERROR_INVALID_PARAMETER;
        }
    }
    if (!ws_t3_is_attached()) {
        return ERROR_ACCESS_DENIED;
    }
    HKEY key = NULL;
    LSTATUS st = materialize_chain(canonical, &key);
    if (st == ERROR_SUCCESS && key) {
        g_orig.RegCloseKey(key);
    }
    return st;
}

int ws_rstore_key_resolve(const wchar_t *hive, const wchar_t *subkey, uint32_t intent,
                          wchar_t *out_path, uint32_t out_cch, uint32_t *out_flags)
{
    if (!out_path || !out_flags || !hive) {
        return -1;
    }
    wchar_t canonical[WS_PATH_MAX];
    size_t pos = 0;
    canonical[0] = 0;
    if (!ws_append_w(canonical, WS_PATH_MAX, &pos, hive)) {
        return -1;
    }
    if (subkey && subkey[0]) {
        if (!ws_append_w(canonical, WS_PATH_MAX, &pos, L"\\") ||
            !ws_append_w(canonical, WS_PATH_MAX, &pos, subkey)) {
            return -1;
        }
    }
    ws_strlcpy_w(out_path, canonical, out_cch);
    *out_flags = 0;

    if (!ws_t3_is_attached()) {
        return -1;
    }
    if (tomb_has(canonical, L"", 1)) {
        *out_flags = WINSTAGE_RES_WHITEOUT;
        return 0;
    }
    int exists = 0;
    LSTATUS st = ws_t3_key_exists(canonical, &exists);
    if (st != ERROR_SUCCESS) {
        return -1;
    }
    if (intent == WINSTAGE_IO_READ) {
        *out_flags = exists ? (WINSTAGE_RES_STAGED | WINSTAGE_RES_EXISTS) : WINSTAGE_RES_REAL;
        return 0;
    }
    *out_flags = WINSTAGE_RES_STAGED;
    return 0;
}

int ws_rstore_key_delete(const wchar_t *hive, const wchar_t *subkey)
{
    wchar_t canonical[WS_PATH_MAX];
    size_t pos = 0;
    canonical[0] = 0;
    if (!ws_append_w(canonical, WS_PATH_MAX, &pos, hive)) {
        return ERROR_INVALID_PARAMETER;
    }
    if (subkey && subkey[0]) {
        if (!ws_append_w(canonical, WS_PATH_MAX, &pos, L"\\") ||
            !ws_append_w(canonical, WS_PATH_MAX, &pos, subkey)) {
            return ERROR_INVALID_PARAMETER;
        }
    }
    if (!canonical[0] || !wcschr(canonical, L'\\')) {
        return ERROR_ACCESS_DENIED; /* never delete a hive root */
    }
    if (!ws_t3_is_attached()) {
        return ERROR_ACCESS_DENIED;
    }

    int inOverlay = 0;
    if (ws_t3_key_exists(canonical, &inOverlay) != ERROR_SUCCESS) {
        return ERROR_ACCESS_DENIED;
    }
    int inReal = 0;
    if (!inOverlay) {
        HKEY realRoot = NULL;
        const wchar_t *shortName = NULL;
        wchar_t rel[WS_PATH_MAX];
        /* split canonical into hive + remainder */
        const wchar_t *bs = wcschr(canonical, L'\\');
        wchar_t hive[64];
        size_t n = bs ? (size_t)(bs - canonical) : wcslen(canonical);
        if (n >= 64) {
            return ERROR_ACCESS_DENIED;
        }
        memcpy(hive, canonical, n * sizeof(wchar_t));
        hive[n] = 0;
        ws_strlcpy_w(rel, bs ? bs + 1 : L"", WS_PATH_MAX);
        if (ws_wcscmp_ci(hive, L"HKCU") == 0) realRoot = HKEY_CURRENT_USER;
        else if (ws_wcscmp_ci(hive, L"HKLM") == 0) realRoot = HKEY_LOCAL_MACHINE;
        else if (ws_wcscmp_ci(hive, L"HKCR") == 0) realRoot = HKEY_CLASSES_ROOT;
        else if (ws_wcscmp_ci(hive, L"HKU") == 0) realRoot = HKEY_USERS;
        else if (ws_wcscmp_ci(hive, L"HKCC") == 0) realRoot = HKEY_CURRENT_CONFIG;
        (void)shortName;
        HKEY probe = NULL;
        if (!realRoot || g_orig.RegOpenKeyExW(realRoot, rel, 0, KEY_READ, &probe) != ERROR_SUCCESS) {
            /* neither the overlay nor the real hive has it: no net change */
            return ERROR_FILE_NOT_FOUND;
        }
        g_orig.RegCloseKey(probe);
        inReal = 1;
    }

    /* Children? The real API returns ERROR_KEY_HAS_CHILDREN and we must not
     * delete a subtree on the caller's behalf. */
    if (inOverlay) {
        HKEY h = NULL;
        if (ws_t3_open_key(canonical, 0, KEY_READ, &h) == ERROR_SUCCESS) {
            wchar_t child[512];
            DWORD cch = 512;
            LSTATUS stEnum = g_orig.RegEnumKeyExW(h, 0, child, &cch, NULL, NULL, NULL, NULL);
            g_orig.RegCloseKey(h);
            if (stEnum == ERROR_SUCCESS) {
                return ERROR_KEY_HAS_CHILDREN;
            }
        }
    }

    if (inReal && !inOverlay) {
        /* hide the real key: materialize it in the overlay, then mark deleted */
        HKEY h = NULL;
        LSTATUS st = materialize_chain(canonical, &h);
        if (st != ERROR_SUCCESS) {
            return st;
        }
        g_orig.RegCloseKey(h);
    }
    LSTATUS st = ws_t3_record_delete_key(canonical);
    if (st != ERROR_SUCCESS) {
        return st;
    }
    if (inOverlay) {
        HKEY root = ws_t3_hive_root();
        g_orig.RegDeleteKeyW(root, canonical);
    }
    tomb_clear(canonical, L"", 1);
    tomb_add(canonical, L"", 1);
    return ERROR_SUCCESS;
}

/* ---------------------------------------------------- provider: value layer */

int ws_rstore_value_set(const wchar_t *hive, const wchar_t *subkey, const wchar_t *name,
                        uint32_t type, const unsigned char *data, uint32_t len)
{
    wchar_t canonical[WS_PATH_MAX];
    size_t pos = 0;
    canonical[0] = 0;
    if (!ws_append_w(canonical, WS_PATH_MAX, &pos, hive)) {
        return ERROR_INVALID_PARAMETER;
    }
    if (subkey && subkey[0]) {
        if (!ws_append_w(canonical, WS_PATH_MAX, &pos, L"\\") ||
            !ws_append_w(canonical, WS_PATH_MAX, &pos, subkey)) {
            return ERROR_INVALID_PARAMETER;
        }
    }
    if (!ws_t3_is_attached()) {
        return ERROR_ACCESS_DENIED;
    }
    HKEY key = NULL;
    LSTATUS st = materialize_chain(canonical, &key);
    if (st != ERROR_SUCCESS) {
        return st;
    }
    /* WAL-first: journal, flush, and only then touch the overlay hive. */
    st = ws_t3_record_set_value(canonical, name ? name : L"", (UINT16)type, data, len, 0);
    if (st != ERROR_SUCCESS) {
        g_orig.RegCloseKey(key);
        return st;
    }
    st = g_orig.RegSetValueExW(key, name ? name : L"", 0, type, data, len);
    g_orig.RegCloseKey(key);
    if (st == ERROR_SUCCESS) {
        tomb_clear(canonical, name ? name : L"", 0);
    }
    return st;
}

int ws_rstore_value_get(const wchar_t *hive, const wchar_t *subkey, const wchar_t *name,
                        uint32_t *type_out, unsigned char *data_out, uint32_t *len_inout,
                        uint32_t *flags_out)
{
    wchar_t canonical[WS_PATH_MAX];
    size_t pos = 0;
    canonical[0] = 0;
    if (!ws_append_w(canonical, WS_PATH_MAX, &pos, hive)) {
        return -1;
    }
    if (subkey && subkey[0]) {
        if (!ws_append_w(canonical, WS_PATH_MAX, &pos, L"\\") ||
            !ws_append_w(canonical, WS_PATH_MAX, &pos, subkey)) {
            return -1;
        }
    }
    if (!ws_t3_is_attached()) {
        return -1;
    }
    if (tomb_has(canonical, name ? name : L"", 0)) {
        if (flags_out) {
            *flags_out = WINSTAGE_RES_WHITEOUT;
        }
        return 0;
    }
    HKEY key = NULL;
    LSTATUS st = ws_t3_open_key(canonical, 0, WS_APPKEY_SAM, &key);
    if (st != ERROR_SUCCESS) {
        return 1; /* not in the overlay -> caller may read through */
    }
    DWORD type = 0;
    DWORD cb = len_inout ? *len_inout : 0;
    st = g_orig.RegQueryValueExW(key, name ? name : L"", NULL, &type, (LPBYTE)data_out, &cb);
    g_orig.RegCloseKey(key);
    if (st == ERROR_FILE_NOT_FOUND) {
        return 1;
    }
    if (st != ERROR_SUCCESS) {
        return -1;
    }
    if (type_out) {
        *type_out = (uint32_t)type;
    }
    if (len_inout) {
        *len_inout = cb;
    }
    if (flags_out) {
        *flags_out = WINSTAGE_RES_STAGED | WINSTAGE_RES_EXISTS;
    }
    return 0;
}

int ws_rstore_value_delete(const wchar_t *hive, const wchar_t *subkey, const wchar_t *name)
{
    wchar_t canonical[WS_PATH_MAX];
    size_t pos = 0;
    canonical[0] = 0;
    if (!ws_append_w(canonical, WS_PATH_MAX, &pos, hive)) {
        return ERROR_INVALID_PARAMETER;
    }
    if (subkey && subkey[0]) {
        if (!ws_append_w(canonical, WS_PATH_MAX, &pos, L"\\") ||
            !ws_append_w(canonical, WS_PATH_MAX, &pos, subkey)) {
            return ERROR_INVALID_PARAMETER;
        }
    }
    if (!ws_t3_is_attached()) {
        return ERROR_ACCESS_DENIED;
    }
    /* The value must exist somewhere, otherwise RegDeleteValueW returns 2. */
    int existsSomewhere = 0;
    HKEY overlayKey = NULL;
    if (ws_t3_open_key(canonical, 0, WS_APPKEY_SAM, &overlayKey) == ERROR_SUCCESS) {
        DWORD type = 0;
        if (g_orig.RegQueryValueExW(overlayKey, name ? name : L"", NULL, &type, NULL, NULL) == ERROR_SUCCESS) {
            existsSomewhere = 1;
        }
    }
    if (!existsSomewhere) {
        /* look in the real hive by canonical path */
        const wchar_t *bs = wcschr(canonical, L'\\');
        wchar_t hiveName[64], rel[WS_PATH_MAX];
        size_t n = bs ? (size_t)(bs - canonical) : wcslen(canonical);
        if (n >= 64) {
            if (overlayKey) g_orig.RegCloseKey(overlayKey);
            return ERROR_ACCESS_DENIED;
        }
        memcpy(hiveName, canonical, n * sizeof(wchar_t));
        hiveName[n] = 0;
        ws_strlcpy_w(rel, bs ? bs + 1 : L"", WS_PATH_MAX);
        HKEY realRoot = NULL;
        if (ws_wcscmp_ci(hiveName, L"HKCU") == 0) realRoot = HKEY_CURRENT_USER;
        else if (ws_wcscmp_ci(hiveName, L"HKLM") == 0) realRoot = HKEY_LOCAL_MACHINE;
        else if (ws_wcscmp_ci(hiveName, L"HKCR") == 0) realRoot = HKEY_CLASSES_ROOT;
        else if (ws_wcscmp_ci(hiveName, L"HKU") == 0) realRoot = HKEY_USERS;
        else if (ws_wcscmp_ci(hiveName, L"HKCC") == 0) realRoot = HKEY_CURRENT_CONFIG;
        HKEY realKey = NULL;
        if (realRoot && g_orig.RegOpenKeyExW(realRoot, rel, 0, KEY_READ, &realKey) == ERROR_SUCCESS) {
            DWORD type = 0;
            if (g_orig.RegQueryValueExW(realKey, name ? name : L"", NULL, &type, NULL, NULL) == ERROR_SUCCESS) {
                existsSomewhere = 1;
            }
            g_orig.RegCloseKey(realKey);
        }
    }
    if (!existsSomewhere) {
        if (overlayKey) g_orig.RegCloseKey(overlayKey);
        return ERROR_FILE_NOT_FOUND;
    }
    LSTATUS st = ws_t3_record_delete_value(canonical, name ? name : L"", 0);
    if (st != ERROR_SUCCESS) {
        if (overlayKey) g_orig.RegCloseKey(overlayKey);
        return st;
    }
    if (overlayKey) {
        g_orig.RegDeleteValueW(overlayKey, name ? name : L"");
        g_orig.RegCloseKey(overlayKey);
    }
    tomb_add(canonical, name ? name : L"", 0);
    return ERROR_SUCCESS;
}

/* -------------------------------------------------------------- enumeration */

int ws_rstore_value_enum(const wchar_t *hive, const wchar_t *subkey, uint32_t index,
                         wchar_t *name_out, uint32_t name_cch, uint32_t *type_out,
                         unsigned char *data_out, uint32_t *len_inout, uint32_t *flags_out)
{
    wchar_t canonical[WS_PATH_MAX];
    size_t pos = 0;
    canonical[0] = 0;
    if (!ws_append_w(canonical, WS_PATH_MAX, &pos, hive)) {
        return -1;
    }
    if (subkey && subkey[0]) {
        if (!ws_append_w(canonical, WS_PATH_MAX, &pos, L"\\") ||
            !ws_append_w(canonical, WS_PATH_MAX, &pos, subkey)) {
            return -1;
        }
    }
    if (!ws_t3_is_attached()) {
        return -1;
    }
    HKEY key = NULL;
    if (ws_t3_open_key(canonical, 0, WS_APPKEY_SAM, &key) != ERROR_SUCCESS) {
        return 1;
    }
    DWORD cch = name_cch ? name_cch : 1;
    DWORD type = 0;
    DWORD cb = len_inout ? *len_inout : 0;
    LSTATUS st = g_orig.RegEnumValueW(key, index, name_out, &cch, NULL, &type, (LPBYTE)data_out, &cb);
    g_orig.RegCloseKey(key);
    if (st == ERROR_NO_MORE_ITEMS) {
        return 1;
    }
    if (st == ERROR_MORE_DATA) {
        if (len_inout) {
            *len_inout = cb;
        }
        return -1;
    }
    if (st != ERROR_SUCCESS) {
        return 1;
    }
    if (type_out) {
        *type_out = (uint32_t)type;
    }
    if (len_inout) {
        *len_inout = cb;
    }
    if (flags_out) {
        *flags_out = WINSTAGE_RES_STAGED | WINSTAGE_RES_EXISTS;
    }
    return 0;
}

int ws_rstore_key_enum(const wchar_t *hive, const wchar_t *subkey, uint32_t index,
                       wchar_t *name_out, uint32_t name_cch)
{
    wchar_t canonical[WS_PATH_MAX];
    size_t pos = 0;
    canonical[0] = 0;
    if (!ws_append_w(canonical, WS_PATH_MAX, &pos, hive)) {
        return -1;
    }
    if (subkey && subkey[0]) {
        if (!ws_append_w(canonical, WS_PATH_MAX, &pos, L"\\") ||
            !ws_append_w(canonical, WS_PATH_MAX, &pos, subkey)) {
            return -1;
        }
    }
    if (!ws_t3_is_attached()) {
        return -1;
    }
    HKEY key = NULL;
    if (ws_t3_open_key(canonical, 0, KEY_READ, &key) != ERROR_SUCCESS) {
        return 1;
    }
    DWORD cch = name_cch ? name_cch : 1;
    LSTATUS st = g_orig.RegEnumKeyExW(key, index, name_out, &cch, NULL, NULL, NULL, NULL);
    g_orig.RegCloseKey(key);
    if (st == ERROR_NO_MORE_ITEMS) {
        return 1;
    }
    if (st != ERROR_SUCCESS) {
        return st == ERROR_MORE_DATA ? -1 : 1;
    }
    return 0;
}

/* Tombstone query used by the merged enumerator: a deleted name must disappear
 * from the union even though the real hive still has it. */
int ws_rstore_is_tombstoned(const wchar_t *canonical, const wchar_t *name, int isKey)
{
    return tomb_has(canonical, name, isKey);
}

/* ------------------------------------------------------------- hard denials */
/* Record the refusal as audit data and return the LSTATUS the caller must see. */
LSTATUS ws_rstore_hard_deny(const wchar_t *pathOrPlaceholder, UINT32 status)
{
    ws_log("hard deny: %ls -> %lu", pathOrPlaceholder ? pathOrPlaceholder : L"<unknown>",
           (unsigned long)status);
    return ws_t3_record_hard_deny(pathOrPlaceholder ? pathOrPlaceholder : L"<unknown>", status);
}

/* ------------------------------------------------------------- passthroughs */
/* "The overlay cannot represent this call" is NOT "you are not allowed": the
 * caller passes the ORIGINAL call through to the real API and we leave an
 * UNSTAGED audit record (T3 contract v1.4, kind 6). Keeping this apart from
 * `ws_rstore_hard_deny` is the whole point: a hard deny fabricates a permission
 * error the caller can do nothing about, while a passthrough lets the real
 * system answer and makes the leak auditable.
 *
 * `ws_t3_record_unstaged` is declared in shim\include\winstage_internal.h's owner
 * file; this file declares it locally so the provider does not need a header
 * change (the header belongs to the shim core, not to the registry store). */
extern LSTATUS ws_t3_record_unstaged(const wchar_t *pathOrPlaceholder, UINT16 reason);

LSTATUS ws_rstore_unstaged(const wchar_t *pathOrPlaceholder, UINT16 reason)
{
    ws_log("unstaged passthrough: %ls (reason=%u) -> real API",
           pathOrPlaceholder ? pathOrPlaceholder : L"<unknown>", (unsigned)reason);
    return ws_t3_record_unstaged(pathOrPlaceholder ? pathOrPlaceholder : L"<unstaged>", reason);
}
