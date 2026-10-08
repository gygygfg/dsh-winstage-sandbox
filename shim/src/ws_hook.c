/* WinStageSandbox -- T4 shim: import-table (IAT) hook engine.
 *
 * Design (see docs/T4-shim?.md):
 *   - Every loaded module's import table is scanned; entries whose imported name
 *     matches a target API are repointed at our replacement. The shim's own
 *     module is skipped so that internal calls stay on the real APIs.
 *   - GetProcAddress (kernel32/kernelbase) and ntdll!LdrGetProcedureAddress are
 *     themselves targets, so *runtime* resolution -- including MSVC delay-load
 *     helpers, which resolve through one of those two -- returns our
 *     replacement. We deliberately do NOT pre-fill delay-import IAT slots: the
 *     delay-load helper overwrites the slot when it first runs, so pre-filling
 *     is both ineffective and would eagerly load every delay-loaded DLL.
 *   - Modules loaded later are covered because LoadLibrary* are targets too: our
 *     wrapper re-runs the scan after the real load returns. A scan can also be
 *     forced with WinstageShimRefreshHooks().
 *   - Limitations: code that reaches the kernel without going through an IAT
 *     slot (direct ntdll!Nt* calls, syscalls, other processes writing on our
 *     behalf) is NOT covered. See docs/T4-shim?.md "??API ??.
 */
#include "winstage_internal.h"

typedef struct WsHookTarget {
    const char *name;
    void *replacement;
    void **originalSlot;
} WsHookTarget;

#define WS_TARGET(name) { #name, (void *)ws_##name, (void **)&g_orig.name }

static const WsHookTarget g_targets[] = {
    WS_TARGET(CreateFileW),
    WS_TARGET(CreateFileA),
    WS_TARGET(CreateDirectoryW),
    WS_TARGET(CreateDirectoryA),
    WS_TARGET(DeleteFileW),
    WS_TARGET(DeleteFileA),
    WS_TARGET(MoveFileExW),
    WS_TARGET(MoveFileExA),
    WS_TARGET(MoveFileW),
    WS_TARGET(MoveFileA),
    WS_TARGET(RemoveDirectoryW),
    WS_TARGET(RemoveDirectoryA),
    WS_TARGET(CopyFileW),
    WS_TARGET(CopyFileA),
    WS_TARGET(SetFileAttributesW),
    /* Added by A1: existence/stat queries must consult the overlay, otherwise a
     * staged write is invisible to Test-Path / File.Exists / `if exist`. */
    WS_TARGET(GetFileAttributesW),
    WS_TARGET(GetFileAttributesA),
    WS_TARGET(GetFileAttributesExW),
    WS_TARGET(GetFileAttributesExA),
    /* Defect ① (TS-tier delete bypass): the deletion directives that never reach
     * DeleteFileW/RemoveDirectoryW. Callers measured on this host:
     *   - NtOpenFile(FILE_DELETE_ON_CLOSE): cmd.exe `del` / `erase`
     *   - NtSetInformationFile(FileDispositionInformation(Ex)): kernelbase
     *     SetFileInformationByHandle (libuv/.NET) and kernelbase-internal deletes
     *   - MoveFileWithProgressW: cmd.exe `ren`
     *   - CreateProcessW: cmd.exe spawning powershell.exe / node.exe (children are
     *     NOT covered by an IAT patch, so the shim injects itself into them) */
    WS_TARGET(NtOpenFile),
    WS_TARGET(NtSetInformationFile),
    WS_TARGET(MoveFileWithProgressW),
    WS_TARGET(CreateProcessW),
    WS_TARGET(CreateProcessAsUserW),
    WS_TARGET(RegCreateKeyExW),
    WS_TARGET(RegCreateKeyExA),
    WS_TARGET(RegCreateKeyW),
    WS_TARGET(RegCreateKeyA),
    WS_TARGET(RegOpenKeyExW),
    WS_TARGET(RegOpenKeyExA),
    WS_TARGET(RegOpenKeyW),
    WS_TARGET(RegOpenKeyA),
    WS_TARGET(RegSetValueExW),
    WS_TARGET(RegSetValueExA),
    WS_TARGET(RegQueryValueExW),
    WS_TARGET(RegQueryValueExA),
    WS_TARGET(RegDeleteKeyExW),
    WS_TARGET(RegDeleteKeyExA),
    WS_TARGET(RegDeleteKeyW),
    WS_TARGET(RegDeleteKeyA),
    WS_TARGET(RegDeleteValueW),
    WS_TARGET(RegDeleteValueA),
    WS_TARGET(RegCloseKey),
    WS_TARGET(RegFlushKey),
    WS_TARGET(RegQueryInfoKeyW),
    WS_TARGET(RegEnumValueW),
    WS_TARGET(RegEnumKeyExW),
    WS_TARGET(GetProcAddress),
    WS_TARGET(LoadLibraryW),
    WS_TARGET(LoadLibraryA),
    WS_TARGET(LoadLibraryExW),
    WS_TARGET(LoadLibraryExA),
};
#define WS_TARGET_COUNT (sizeof(g_targets) / sizeof(g_targets[0]))

static const char *const g_targetNames[] = {
    "CreateFileW", "CreateFileA", "CreateDirectoryW", "CreateDirectoryA",
    "DeleteFileW", "DeleteFileA", "MoveFileExW", "MoveFileExA", "MoveFileW", "MoveFileA",
    "RemoveDirectoryW", "RemoveDirectoryA", "CopyFileW", "CopyFileA", "SetFileAttributesW",
    "GetFileAttributesW", "GetFileAttributesA", "GetFileAttributesExW", "GetFileAttributesExA",
    /* defect ① targets (see the g_targets comment) */
    "NtOpenFile", "NtSetInformationFile", "MoveFileWithProgressW",
    "CreateProcessW", "CreateProcessAsUserW",
    "RegCreateKeyExW", "RegCreateKeyExA", "RegCreateKeyW", "RegCreateKeyA",
    "RegOpenKeyExW", "RegOpenKeyExA", "RegOpenKeyW", "RegOpenKeyA",
    "RegSetValueExW", "RegSetValueExA", "RegQueryValueExW", "RegQueryValueExA",
    "RegDeleteKeyExW", "RegDeleteKeyExA", "RegDeleteKeyW", "RegDeleteKeyA",
    "RegDeleteValueW", "RegDeleteValueA", "RegCloseKey", "RegFlushKey",
    "RegQueryInfoKeyW", "RegEnumValueW", "RegEnumKeyExW",
    "GetProcAddress", "LoadLibraryW", "LoadLibraryA", "LoadLibraryExW", "LoadLibraryExA",
    "LdrGetProcedureAddress",
};

#define WS_MAX_SITES 8192

typedef struct WsPatchedSite {
    void **slot;
    void *oldValue;
} WsPatchedSite;

static WsPatchedSite g_sites[WS_MAX_SITES];
static int g_targetHits[WS_TARGET_COUNT];
static int g_siteCount;
static int g_moduleCount;
static int g_delayDescriptors;
static HMODULE g_selfModule;
static int g_installed;
/* defect 4: was a non-reentrant `volatile LONG g_lock` spin. The IAT pass can
 * re-enter this module (e.g. a hook -> ws_log -> provider), so the lock must be
 * reentrant and bounded; see WsLock in winstage_internal.h. */
static WsLock g_hookLock = { 0, 0, 0, "hook" };

/* Modules the shim itself imports from are NEVER hooked.
 *
 * Our own calls resolve as: shim IAT slot -> provider export (a stub that jumps
 * through the provider's own IAT slot) -> provider IAT slot. Hijacking that slot
 * makes the shim re-enter its own hook: ws_log() -> CreateFileW ->
 * ws_CreateFileW -> (trace) ws_log() -> ... an immediate infinite recursion that
 * kills the injected process while the loader is still inside LoadLibraryW (seen
 * as "remote LoadLibraryW failed" with the shim log stopping at the first line).
 * Skipping the providers keeps every shim-internal call on the real API while
 * every other module -- including ucrtbase, so CRT file I/O ("fopen") is still
 * intercepted -- remains hooked. */
#define WS_MAX_PROVIDERS 24
static wchar_t g_providerNames[WS_MAX_PROVIDERS][64];
static int g_providerCount = -1; /* -1 = not collected yet */

/* LDR_DATA_TABLE_ENTRY prefix, so BaseDllName can be read without relying on the
 * toolchain's winternl.h layout (which omits it). */
typedef struct WsLdrEntry {
    LIST_ENTRY InLoadOrderLinks;
    LIST_ENTRY InMemoryOrderLinks;
    LIST_ENTRY InInitializationOrderLinks;
    PVOID DllBase;
    PVOID EntryPoint;
    ULONG SizeOfImage;
    UNICODE_STRING FullDllName;
    UNICODE_STRING BaseDllName;
} WsLdrEntry;

/* ---------------------------------------------------------------- helpers */

static PVOID ws_peb(void)
{
#if defined(_MSC_VER)
    return (PVOID)__readgsqword(0x60);
#else
    PVOID p;
    __asm__ __volatile__("movq %%gs:0x60, %0" : "=r"(p));
    return p;
#endif
}

static PPEB_LDR_DATA ws_ldr(void)
{
    PVOID peb = ws_peb();
    if (!peb) {
        return NULL;
    }
    /* x64 PEB->Ldr is at +0x18; do not depend on header field names here. */
    return *(PPEB_LDR_DATA *)((BYTE *)peb + 0x18);
}

static HMODULE ws_self_module(void)
{
    HMODULE self = NULL;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCWSTR)(const void *)&g_targets, &self);
    return self;
}

/* Triage families (see WINSTAGE_SHIM_DISABLE_FILE / _REG). Registry entry points
 * all start with "Reg"; the loader/resolver hooks are the control family; the
 * rest are the file family. Only used by the debug switches. */
#define WS_FAM_FILE 1
#define WS_FAM_REG  2
#define WS_FAM_CTL  3

static int ws_target_family(const char *name)
{
    if (strncmp(name, "Reg", 3) == 0) {
        return WS_FAM_REG;
    }
    if (strcmp(name, "GetProcAddress") == 0 || strncmp(name, "LoadLibrary", 11) == 0 ||
        strcmp(name, "LdrGetProcedureAddress") == 0) {
        return WS_FAM_CTL;
    }
    return WS_FAM_FILE;
}

/* WINSTAGE_SHIM_SKIP=a,b,c leaves the named entry points unhooked. This is the
 * bisection tool: it pins down which single API breaks a target without a
 * rebuild. (See docs/T4-shim?.md "?".) */
#define WS_SKIP_MAX 64
static const char *g_skipList[WS_SKIP_MAX];
static int g_skipCount;

static void ws_skip_list_load(void)
{
    static char buf[2048];
    DWORD n = GetEnvironmentVariableA("WINSTAGE_SHIM_SKIP", buf, sizeof(buf));
    if (n == 0 || n >= sizeof(buf)) {
        return;
    }
    g_skipCount = 0;
    char *p = buf;
    while (*p && g_skipCount < WS_SKIP_MAX) {
        while (*p == ' ' || *p == ',') p++;
        if (!*p) break;
        char *start = p;
        while (*p && *p != ',') p++;
        if (*p) { *p = 0; p++; }
        /* trim trailing spaces */
        char *end = start + strlen(start);
        while (end > start && (end[-1] == ' ' || end[-1] == '\r' || end[-1] == '\n')) *--end = 0;
        if (*start) g_skipList[g_skipCount++] = start;
    }
}

static int ws_family_enabled(const char *name)
{
    int fam = ws_target_family(name);
    if (fam == WS_FAM_FILE && g_ws.disableFileFamily) {
        return 0;
    }
    if (fam == WS_FAM_REG && g_ws.disableRegFamily) {
        return 0;
    }
    for (int i = 0; i < g_skipCount; i++) {
        if (strcmp(g_skipList[i], name) == 0) {
            return 0;
        }
    }
    return 1;
}

static const WsHookTarget *ws_find_target(const char *name)
{
    for (size_t i = 0; i < WS_TARGET_COUNT; i++) {
        if (strcmp(g_targets[i].name, name) == 0) {
            return ws_family_enabled(name) ? &g_targets[i] : NULL;
        }
    }
    return NULL;
}

static const WsHookTarget *ws_find_target_n(const char *name, size_t len)
{
    for (size_t i = 0; i < WS_TARGET_COUNT; i++) {
        if (strlen(g_targets[i].name) == len && memcmp(g_targets[i].name, name, len) == 0) {
            return ws_family_enabled(g_targets[i].name) ? &g_targets[i] : NULL;
        }
    }
    return NULL;
}

static void ws_record_site(void **slot, void *oldValue)
{
    if (g_siteCount >= WS_MAX_SITES) {
        return;
    }
    g_sites[g_siteCount].slot = slot;
    g_sites[g_siteCount].oldValue = oldValue;
    g_siteCount++;
}

/* ------------------------------------------------------------ init/originals */

int ws_hook_init(void)
{
    ws_skip_list_load();
    if (g_orig.hKernel32) {
        return 1;
    }
    g_selfModule = ws_self_module();
    g_orig.hKernel32 = GetModuleHandleW(L"kernel32.dll");
    g_orig.hKernelBase = GetModuleHandleW(L"kernelbase.dll");
    g_orig.hAdvapi32 = GetModuleHandleW(L"advapi32.dll");
    g_orig.hNtdll = GetModuleHandleW(L"ntdll.dll");

    struct { void **slot; const char *name; } map[] = {
        { (void **)&g_orig.CreateFileW, "CreateFileW" },
        { (void **)&g_orig.CreateFileA, "CreateFileA" },
        { (void **)&g_orig.CreateDirectoryW, "CreateDirectoryW" },
        { (void **)&g_orig.CreateDirectoryA, "CreateDirectoryA" },
        { (void **)&g_orig.DeleteFileW, "DeleteFileW" },
        { (void **)&g_orig.DeleteFileA, "DeleteFileA" },
        { (void **)&g_orig.MoveFileExW, "MoveFileExW" },
        { (void **)&g_orig.MoveFileExA, "MoveFileExA" },
        { (void **)&g_orig.MoveFileW, "MoveFileW" },
        { (void **)&g_orig.MoveFileA, "MoveFileA" },
        { (void **)&g_orig.RemoveDirectoryW, "RemoveDirectoryW" },
        { (void **)&g_orig.RemoveDirectoryA, "RemoveDirectoryA" },
        { (void **)&g_orig.CopyFileW, "CopyFileW" },
        { (void **)&g_orig.CopyFileA, "CopyFileA" },
        { (void **)&g_orig.SetFileAttributesW, "SetFileAttributesW" },
        /* A1 stat/existence hooks: without these capture entries the new
         * replacements would call a NULL original (observed as 0xC0000005 in
         * cmd.exe and powershell.exe). */
        { (void **)&g_orig.GetFileAttributesW, "GetFileAttributesW" },
        { (void **)&g_orig.GetFileAttributesA, "GetFileAttributesA" },
        { (void **)&g_orig.GetFileAttributesExW, "GetFileAttributesExW" },
        { (void **)&g_orig.GetFileAttributesExA, "GetFileAttributesExA" },
        /* defect ① targets (see the g_targets comment) */
        { (void **)&g_orig.NtOpenFile, "NtOpenFile" },
        { (void **)&g_orig.NtSetInformationFile, "NtSetInformationFile" },
        { (void **)&g_orig.MoveFileWithProgressW, "MoveFileWithProgressW" },
        { (void **)&g_orig.CreateProcessW, "CreateProcessW" },
        { (void **)&g_orig.CreateProcessAsUserW, "CreateProcessAsUserW" },
        { (void **)&g_orig.GetProcAddress, "GetProcAddress" },
        { (void **)&g_orig.LoadLibraryW, "LoadLibraryW" },
        { (void **)&g_orig.LoadLibraryA, "LoadLibraryA" },
        { (void **)&g_orig.LoadLibraryExW, "LoadLibraryExW" },
        { (void **)&g_orig.LoadLibraryExA, "LoadLibraryExA" },
        { (void **)&g_orig.RegCreateKeyExW, "RegCreateKeyExW" },
        { (void **)&g_orig.RegCreateKeyExA, "RegCreateKeyExA" },
        { (void **)&g_orig.RegCreateKeyW, "RegCreateKeyW" },
        { (void **)&g_orig.RegCreateKeyA, "RegCreateKeyA" },
        { (void **)&g_orig.RegOpenKeyExW, "RegOpenKeyExW" },
        { (void **)&g_orig.RegOpenKeyExA, "RegOpenKeyExA" },
        { (void **)&g_orig.RegOpenKeyW, "RegOpenKeyW" },
        { (void **)&g_orig.RegOpenKeyA, "RegOpenKeyA" },
        { (void **)&g_orig.RegSetValueExW, "RegSetValueExW" },
        { (void **)&g_orig.RegSetValueExA, "RegSetValueExA" },
        { (void **)&g_orig.RegQueryValueExW, "RegQueryValueExW" },
        { (void **)&g_orig.RegQueryValueExA, "RegQueryValueExA" },
        { (void **)&g_orig.RegDeleteKeyExW, "RegDeleteKeyExW" },
        { (void **)&g_orig.RegDeleteKeyExA, "RegDeleteKeyExA" },
        { (void **)&g_orig.RegDeleteKeyW, "RegDeleteKeyW" },
        { (void **)&g_orig.RegDeleteKeyA, "RegDeleteKeyA" },
        { (void **)&g_orig.RegDeleteValueW, "RegDeleteValueW" },
        { (void **)&g_orig.RegDeleteValueA, "RegDeleteValueA" },
        { (void **)&g_orig.RegCloseKey, "RegCloseKey" },
        { (void **)&g_orig.RegFlushKey, "RegFlushKey" },
        { (void **)&g_orig.RegQueryInfoKeyW, "RegQueryInfoKeyW" },
        { (void **)&g_orig.RegEnumValueW, "RegEnumValueW" },
        { (void **)&g_orig.RegEnumKeyExW, "RegEnumKeyExW" },
        { (void **)&g_orig.LdrGetProcedureAddress, "LdrGetProcedureAddress" },
    };
    for (size_t i = 0; i < sizeof(map) / sizeof(map[0]); i++) {
        HMODULE order[] = { g_orig.hKernelBase, g_orig.hKernel32, g_orig.hAdvapi32, g_orig.hNtdll };
        for (size_t k = 0; k < sizeof(order) / sizeof(order[0]) && !*map[i].slot; k++) {
            if (order[k]) {
                *map[i].slot = (void *)GetProcAddress(order[k], map[i].name);
            }
        }
        if (!*map[i].slot && g_ws.verbose) {
            ws_log("original not found: %s", map[i].name);
        }
    }
    if (g_orig.hNtdll) {
        g_NtQueryKey = (WsNtQueryKeyFn)(void *)GetProcAddress(g_orig.hNtdll, "NtQueryKey");
    }
    /* Arm child self-injection (ws_proc.c) with this module's own path. */
    ws_proc_set_self_module(g_selfModule);
    return 1;
}

/* ------------------------------------------------------------- patch passes */

/* Which DLLs does the shim itself import from? Read from our own import
 * directory once; these modules are skipped by ws_patch_all (see the comment at
 * the declaration of g_providerNames). */
static void ws_collect_self_providers(void)
{
    if (g_providerCount >= 0) {
        return;
    }
    g_providerCount = 0;
    if (!g_selfModule) {
        return;
    }
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)g_selfModule;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) {
        return;
    }
    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)((BYTE *)g_selfModule + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) {
        return;
    }
    IMAGE_DATA_DIRECTORY *impDir = &nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!impDir->VirtualAddress) {
        return;
    }
    IMAGE_IMPORT_DESCRIPTOR *desc =
        (IMAGE_IMPORT_DESCRIPTOR *)((BYTE *)g_selfModule + impDir->VirtualAddress);
    for (; desc->Name && g_providerCount < WS_MAX_PROVIDERS; desc++) {
        const char *name = (const char *)((BYTE *)g_selfModule + desc->Name);
        if (!MultiByteToWideChar(CP_ACP, 0, name, -1, g_providerNames[g_providerCount], 64)) {
            continue;
        }
        g_providerCount++;
    }
    for (int i = 0; i < g_providerCount; i++) {
        if (g_ws.verbose) {
            ws_log("self import provider: %ls", g_providerNames[i]);
        }
    }
}

static int ws_is_self_provider(const UNICODE_STRING *baseName)
{
    if (!baseName || !baseName->Buffer || baseName->Length == 0) {
        return 0;
    }
    wchar_t buf[64];
    int n = (int)(baseName->Length / sizeof(wchar_t));
    if (n < 0) {
        return 0;
    }
    if (n > 63) {
        n = 63;
    }
    for (int i = 0; i < n; i++) {
        buf[i] = baseName->Buffer[i];
    }
    buf[n] = 0;
    for (int i = 0; i < g_providerCount; i++) {
        if (ws_wcscmp_ci(buf, g_providerNames[i]) == 0) {
            return 1;
        }
    }
    return 0;
}

static int ws_patch_module(HMODULE base)
{
    if (!base || base == g_selfModule) {
        return 0;
    }
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) {
        return 0;
    }
    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)((BYTE *)base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) {
        return 0;
    }
    int patched = 0;
    IMAGE_DATA_DIRECTORY *impDir = &nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (impDir->VirtualAddress) {
        IMAGE_IMPORT_DESCRIPTOR *desc = (IMAGE_IMPORT_DESCRIPTOR *)((BYTE *)base + impDir->VirtualAddress);
        for (; desc->Name; desc++) {
            if (!desc->OriginalFirstThunk) {
                continue; /* no name table: cannot match by name */
            }
            IMAGE_THUNK_DATA *oft = (IMAGE_THUNK_DATA *)((BYTE *)base + desc->OriginalFirstThunk);
            IMAGE_THUNK_DATA *ft = (IMAGE_THUNK_DATA *)((BYTE *)base + desc->FirstThunk);
            for (; oft->u1.AddressOfData; oft++, ft++) {
                if (oft->u1.Ordinal & IMAGE_ORDINAL_FLAG) {
                    continue;
                }
                IMAGE_IMPORT_BY_NAME *ibn = (IMAGE_IMPORT_BY_NAME *)((BYTE *)base + oft->u1.AddressOfData);
                const char *fname = (const char *)ibn->Name;
                const WsHookTarget *t = ws_find_target(fname);
                if (!t) {
                    continue;
                }
                if (ft->u1.Function == (ULONG_PTR)t->replacement) {
                    continue; /* already ours */
                }
                DWORD old = 0;
                /* ★ round-4 竞态加固（两条，均针对实测形态）：
                 * ① 权限用 `PAGE_EXECUTE_READWRITE` 而**不是** `PAGE_READWRITE`：
                 *    某些模块（实测 Defender 的 `MpOav.dll`）把 IAT 与代码合并在同一页上，
                 *    原写法会在补丁窗口里**临时剥夺该页的执行权**，此刻任何正在该页执行的线程
                 *    都会立刻拿到 `0xC0000005`。实测该 AV 成簇、与外部负载相关，且失败 run 的
                 *    最后被追踪动作就落在给外部注入模块挂钩的窗口里。
                 * ② 槽位用 `InterlockedExchangePointer` 原子写入（原先是一条普通 store）；
                 *    `prev` 先取出再交给 `ws_record_site` 存档，detach 时仍可精确还原。
                 * 语义不变：仍是"记原值 → 换成本钩子 → 还原页权限"。 */
                if (VirtualProtect(&ft->u1.Function, sizeof(ULONG_PTR), PAGE_EXECUTE_READWRITE, &old)) {
                    void *prev = InterlockedExchangePointer((void *volatile *)&ft->u1.Function,
                                                            (void *)t->replacement);
                    ws_record_site((void **)&ft->u1.Function, prev);
                    VirtualProtect(&ft->u1.Function, sizeof(ULONG_PTR), old, &old);
                    if (g_ws.verbose) {
                        /* Which module's IAT slot is this? Needed to answer "why was
                         * API X not called?" (a module may import it and still never
                         * use the slot, e.g. cmd's `del`). */
                        wchar_t mp[WS_PATH_MAX];
                        mp[0] = 0;
                        GetModuleFileNameW(base, mp, WS_PATH_MAX);
                        const wchar_t *bn = wcsrchr(mp, L'\\');
                        ws_log("  iat %-24s <- %ls", fname, bn ? bn + 1 : mp);
                    }
                    for (size_t ti = 0; ti < WS_TARGET_COUNT; ti++) {
                        if (&g_targets[ti] == t) {
                            g_targetHits[ti]++;
                            break;
                        }
                    }
                    patched++;
                }
            }
        }
    }
    IMAGE_DATA_DIRECTORY *delayDir = &nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT];
    if (delayDir->VirtualAddress) {
        /* Count only: see the header comment -- pre-filling delay IAT slots is
         * ineffective and eagerly loads DLLs. Runtime resolution is caught by the
         * GetProcAddress / LdrGetProcedureAddress hooks instead. */
        typedef struct { DWORD Attributes, DllNameRVA, ModuleHandleRVA, IAT, INT, BoundIAT, UnloadIAT, TimeStamp; } DL;
        DL *d = (DL *)((BYTE *)base + delayDir->VirtualAddress);
        for (; d->DllNameRVA; d++) {
            g_delayDescriptors++;
        }
    }
    return patched;
}

static int ws_patch_all(void)
{
    PPEB_LDR_DATA ldr = ws_ldr();
    if (!ldr) {
        ws_log("cannot walk the PEB loader list; falling back to own process modules is not possible");
        return 0;
    }
    ws_collect_self_providers();
    int patched = 0, modules = 0;
    LIST_ENTRY *head = &ldr->InMemoryOrderModuleList;
    for (LIST_ENTRY *e = head->Flink; e && e != head; e = e->Flink) {
        LDR_DATA_TABLE_ENTRY *entry = CONTAINING_RECORD(e, LDR_DATA_TABLE_ENTRY, InMemoryOrderLinks);
        HMODULE base = (HMODULE)entry->DllBase;
        if (!base) {
            continue;
        }
        if (base != g_selfModule && ws_is_self_provider(&((WsLdrEntry *)entry)->BaseDllName)) {
            if (g_ws.verbose) {
                ws_log("skip provider module (the shim imports from it): %ls",
                       ((WsLdrEntry *)entry)->BaseDllName.Buffer);
            }
            continue;
        }
        modules++;
        patched += ws_patch_module(base);
    }
    g_moduleCount = modules;
    return patched;
}

const char *const *ws_hook_target_names(size_t *count)
{
    if (count) {
        *count = sizeof(g_targetNames) / sizeof(g_targetNames[0]);
    }
    return g_targetNames;
}

void *ws_hook_resolve(const char *apiName)
{
    if (!apiName || (ULONG_PTR)apiName <= 0xFFFF) {
        return NULL;
    }
    if (strcmp(apiName, "LdrGetProcedureAddress") == 0) {
        return (void *)ws_LdrGetProcedureAddress;
    }
    const WsHookTarget *t = ws_find_target(apiName);
    return t ? t->replacement : NULL;
}

void *ws_hook_resolve_n(const char *name, size_t len)
{
    if (!name || len == 0 || len > 128) {
        return NULL;
    }
    const WsHookTarget *t = ws_find_target_n(name, len);
    return t ? t->replacement : NULL;
}

int ws_hook_install(void)
{
    int patched = 0, modules = 0, didInstall = 0;
    ws_lock_enter(&g_hookLock);
    if (!g_installed) {
        g_siteCount = 0;
        g_delayDescriptors = 0;
        patched = ws_patch_all();
        modules = g_moduleCount;
        g_installed = 1;
        didInstall = 1;
    }
    ws_lock_leave(&g_hookLock);
    /* defect 4: the diagnostic logging used to run under the lock. It is file
     * I/O (and, under Defender, potentially slow), so it now runs after release.
     * ws_patch_all() may still emit a few anomaly lines while the lock is held;
     * that path never re-enters this lock (ws_log goes through the captured
     * original CreateFileW), so it cannot self-deadlock. */
    if (didInstall) {
        ws_log("hooks installed: %d IAT sites across %d modules (%d delay descriptors seen) "
               "families: file=%s reg=%s",
               patched, modules, g_delayDescriptors,
               g_ws.disableFileFamily ? "OFF" : "on",
               g_ws.disableRegFamily ? "OFF" : "on");
        /* Which targets actually appeared in some import table? Purely
         * diagnostic, but it is the fastest way to answer "why was API X not
         * intercepted?" (a hit count of 0 means no loaded module imported it --
         * it is then only reachable through GetProcAddress). */
        if (g_ws.verbose) {
            for (size_t ti = 0; ti < WS_TARGET_COUNT; ti++) {
                ws_log("  target %-22s hits=%d original=%s", g_targets[ti].name, g_targetHits[ti],
                       *(g_targets[ti].originalSlot) ? "yes" : "NULL");
            }
        }
    }
    return patched;
}

int ws_hook_refresh(void)
{
    if (!g_installed) {
        return 0;
    }
    ws_lock_enter(&g_hookLock);
    int patched = ws_patch_all();
    ws_lock_leave(&g_hookLock);
    return patched;
}

void ws_hook_remove(void)
{
    ws_lock_enter(&g_hookLock);
    for (int i = g_siteCount - 1; i >= 0; i--) {
        DWORD old = 0;
        /* ★ round-4：撤钩走与 `ws_patch_module` 同一套加固（理由见那里的长注释）——
         * 同样必须保持该页可执行，且槽位用原子写入，避免撤钩瞬间被别的线程取到中间态。 */
        if (VirtualProtect(g_sites[i].slot, sizeof(ULONG_PTR), PAGE_EXECUTE_READWRITE, &old)) {
            InterlockedExchangePointer((void *volatile *)g_sites[i].slot, g_sites[i].oldValue);
            VirtualProtect(g_sites[i].slot, sizeof(ULONG_PTR), old, &old);
        }
    }
    g_siteCount = 0;
    g_installed = 0;
    ws_lock_leave(&g_hookLock);
}

void *ws_hook_original_by_name(const char *apiName)
{
    const WsHookTarget *t = ws_find_target(apiName);
    if (!t) {
        if (apiName && strcmp(apiName, "LdrGetProcedureAddress") == 0) {
            return (void *)g_orig.LdrGetProcedureAddress;
        }
        return NULL;
    }
    return *(t->originalSlot);
}

int ws_hook_stats(int *iatSites, int *modules, int *delaySites)
{
    if (iatSites) *iatSites = g_siteCount;
    if (modules) *modules = g_moduleCount;
    if (delaySites) *delaySites = g_delayDescriptors;
    return g_installed;
}

/* ------------------------------------------------------- control hooks */

FARPROC WINAPI ws_GetProcAddress(HMODULE hModule, LPCSTR lpProcName)
{
    if (lpProcName && (ULONG_PTR)lpProcName > 0xFFFF) {
        void *rep = ws_hook_resolve(lpProcName);
        if (rep) {
            return (FARPROC)rep;
        }
    }
    if (!g_orig.GetProcAddress) {
        return NULL;
    }
    return g_orig.GetProcAddress(hModule, lpProcName);
}

HMODULE WINAPI ws_LoadLibraryExW(LPCWSTR lpLibFileName, HANDLE hFile, DWORD dwFlags)
{
    HMODULE h = g_orig.LoadLibraryExW(lpLibFileName, hFile, dwFlags);
    if (h) {
        ws_hook_refresh();
    }
    return h;
}

HMODULE WINAPI ws_LoadLibraryExA(LPCSTR lpLibFileName, HANDLE hFile, DWORD dwFlags)
{
    HMODULE h = g_orig.LoadLibraryExA(lpLibFileName, hFile, dwFlags);
    if (h) {
        ws_hook_refresh();
    }
    return h;
}

HMODULE WINAPI ws_LoadLibraryW(LPCWSTR lpLibFileName)
{
    HMODULE h = g_orig.LoadLibraryW(lpLibFileName);
    if (h) {
        ws_hook_refresh();
    }
    return h;
}

HMODULE WINAPI ws_LoadLibraryA(LPCSTR lpLibFileName)
{
    HMODULE h = g_orig.LoadLibraryA(lpLibFileName);
    if (h) {
        ws_hook_refresh();
    }
    return h;
}

/* ntdll!LdrGetProcedureAddress(PVOID DllHandle, PANSI_STRING ProcedureName,
 *                              ULONG ProcedureNumber, PVOID *ProcedureAddress) */
NTSTATUS NTAPI ws_LdrGetProcedureAddress(PVOID DllHandle, const void *ProcedureName,
                                         ULONG ProcedureNumber, PVOID *ProcedureAddress)
{
    NTSTATUS st = g_orig.LdrGetProcedureAddress(DllHandle, ProcedureName, ProcedureNumber, ProcedureAddress);
    if (st >= 0 && ProcedureNumber == 0 && ProcedureName && ProcedureAddress && *ProcedureAddress) {
        const unsigned char *s = (const unsigned char *)ProcedureName; /* ANSI_STRING */
        unsigned short len = *(const unsigned short *)(s + 0);
        const char *buf = *(const char *const *)(s + 8);
        if (buf && len) {
            void *rep = ws_hook_resolve_n(buf, len);
            if (rep) {
                *ProcedureAddress = rep;
            }
        }
    }
    return st;
}
