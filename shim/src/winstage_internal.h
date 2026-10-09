/* WinStageSandbox -- T4 shim: internal shared declarations. */
#ifndef WINSTAGE_INTERNAL_H
#define WINSTAGE_INTERNAL_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <winternl.h>
#include <stdint.h>
#include <stdarg.h>
#include <wchar.h>
#include <string.h>

#include "winstage_shim.h"

#define WS_PATH_MAX 4096
#define WS_LOG_MAX  2048
#define WS_MAX_PASSTHROUGH 8

typedef struct WsConfig {
    int initialized;
    int failClosed;      /* deny writes we cannot stage (default 1) */
    int readThrough;     /* reads fall through to the real file/registry (default 1) */
    int verbose;
    int traceStagedOps;  /* log every staged operation */
    int haveStageRoot;
    wchar_t stageRoot[WS_PATH_MAX];
    wchar_t logPath[WS_PATH_MAX];
    /* Optional structured audit sink (WINSTAGE_AUDIT_LOG): one JSONL line per
     * hooked file/registry operation, so an outside program can count what the
     * agent read and modified without parsing the verbose text log. Empty = off. */
    wchar_t auditPath[WS_PATH_MAX];
    wchar_t configPath[WS_PATH_MAX];
    int unstagedWrites;     /* 1 = deny (default, fail closed), 2 = allow the real API */
    int disableFileFamily;  /* debug/triage: leave the file-family hooks uninstalled */
    int disableRegFamily;   /* debug/triage: leave the registry-family hooks uninstalled */
    /* read masking (task-10 execution half) */
    int readDenyCount;
    char readDeny[32][256];
    wchar_t readDenyFile[WS_PATH_MAX];
    int readAllowCount;
    char readAllow[8][256];
    int readDenyFailMode;   /* 0 = deny reads when the policy cannot be honored (fail-closed) */
    int passthroughCount;
    wchar_t passthrough[WS_MAX_PASSTHROUGH][WS_PATH_MAX];
} WsConfig;

/* --- originals captured before hooking ---------------------------------- */
typedef struct WsOriginals {
    HMODULE hKernel32;
    HMODULE hKernelBase;
    HMODULE hAdvapi32;
    HMODULE hNtdll;

    /* --- file --- */
    HANDLE(WINAPI *CreateFileW)(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
    HANDLE(WINAPI *CreateFileA)(LPCSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
    BOOL(WINAPI *CreateDirectoryW)(LPCWSTR, LPSECURITY_ATTRIBUTES);
    BOOL(WINAPI *CreateDirectoryA)(LPCSTR, LPSECURITY_ATTRIBUTES);
    BOOL(WINAPI *DeleteFileW)(LPCWSTR);
    BOOL(WINAPI *DeleteFileA)(LPCSTR);
    BOOL(WINAPI *MoveFileExW)(LPCWSTR, LPCWSTR, DWORD);
    BOOL(WINAPI *MoveFileExA)(LPCSTR, LPCSTR, DWORD);
    BOOL(WINAPI *MoveFileW)(LPCWSTR, LPCWSTR);
    BOOL(WINAPI *MoveFileA)(LPCSTR, LPCSTR);
    BOOL(WINAPI *RemoveDirectoryW)(LPCWSTR);
    BOOL(WINAPI *RemoveDirectoryA)(LPCSTR);
    BOOL(WINAPI *CopyFileW)(LPCWSTR, LPCWSTR, BOOL);
    BOOL(WINAPI *CopyFileA)(LPCSTR, LPCSTR, BOOL);
    BOOL(WINAPI *SetFileAttributesW)(LPCWSTR, DWORD);
    /* Overlay-aware existence/stat hooks (added for the A1 stat gap): the
     * originals are captured like every other target. */
    DWORD(WINAPI *GetFileAttributesW)(LPCWSTR);
    DWORD(WINAPI *GetFileAttributesA)(LPCSTR);
    BOOL(WINAPI *GetFileAttributesExW)(LPCWSTR, GET_FILEEX_INFO_LEVELS, LPVOID);
    BOOL(WINAPI *GetFileAttributesExA)(LPCSTR, GET_FILEEX_INFO_LEVELS, LPVOID);

    /* --- process / directive-level file APIs (defect ① fix, see ws_file.c/ws_proc.c) --- */
    NTSTATUS(NTAPI *NtOpenFile)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, ULONG, ULONG);
    NTSTATUS(NTAPI *NtSetInformationFile)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
    BOOL(WINAPI *MoveFileWithProgressW)(LPCWSTR, LPCWSTR, LPPROGRESS_ROUTINE, LPVOID, DWORD);
    BOOL(WINAPI *CreateProcessW)(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD,
                                 LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);
    BOOL(WINAPI *CreateProcessAsUserW)(HANDLE, LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES,
                                       BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);

    /* --- loader / resolution --- */
    FARPROC(WINAPI *GetProcAddress)(HMODULE, LPCSTR);
    HMODULE(WINAPI *LoadLibraryW)(LPCWSTR);
    HMODULE(WINAPI *LoadLibraryA)(LPCSTR);
    HMODULE(WINAPI *LoadLibraryExW)(LPCWSTR, HANDLE, DWORD);
    HMODULE(WINAPI *LoadLibraryExA)(LPCSTR, HANDLE, DWORD);
    NTSTATUS(NTAPI *LdrGetProcedureAddress)(PVOID, const void * /*PANSI_STRING*/, ULONG, PVOID *);
    /* task-13：ntdll!LdrLoadDll —— CLR P/Invoke / Add-Type / 原生模块自身导入走的加载路径
     * （Win32 LoadLibrary* 钩子看不到它）。签名与 ntdll 导出一致。 */
    NTSTATUS(NTAPI *LdrLoadDll)(PCWSTR, PULONG, const void * /*PUNICODE_STRING*/, PHANDLE);
    /* task-13 ②：ntdll 属性查询面 —— node/libuv 的 stat/exists 与 cmd 的存在性检查
     * 走这里（实测：GetFileAttributes* 面看得见 overlay，这两个不钩就看不见）。 */
    NTSTATUS(NTAPI *NtQueryAttributesFile)(const void * /*POBJECT_ATTRIBUTES*/, PVOID);
    NTSTATUS(NTAPI *NtQueryFullAttributesFile)(const void *, PVOID);

    /* --- registry --- */
    LONG(WINAPI *RegCreateKeyExW)(HKEY, LPCWSTR, DWORD, LPWSTR, DWORD, REGSAM, LPSECURITY_ATTRIBUTES, PHKEY, LPDWORD);
    LONG(WINAPI *RegCreateKeyExA)(HKEY, LPCSTR, DWORD, LPSTR, DWORD, REGSAM, LPSECURITY_ATTRIBUTES, PHKEY, LPDWORD);
    LONG(WINAPI *RegCreateKeyW)(HKEY, LPCWSTR, PHKEY);
    LONG(WINAPI *RegCreateKeyA)(HKEY, LPCSTR, PHKEY);
    LONG(WINAPI *RegOpenKeyExW)(HKEY, LPCWSTR, DWORD, REGSAM, PHKEY);
    LONG(WINAPI *RegOpenKeyExA)(HKEY, LPCSTR, DWORD, REGSAM, PHKEY);
    LONG(WINAPI *RegOpenKeyW)(HKEY, LPCWSTR, PHKEY);
    LONG(WINAPI *RegOpenKeyA)(HKEY, LPCSTR, PHKEY);
    LONG(WINAPI *RegSetValueExW)(HKEY, LPCWSTR, DWORD, DWORD, const BYTE *, DWORD);
    LONG(WINAPI *RegSetValueExA)(HKEY, LPCSTR, DWORD, DWORD, const BYTE *, DWORD);
    LONG(WINAPI *RegQueryValueExW)(HKEY, LPCWSTR, LPDWORD, LPDWORD, LPBYTE, LPDWORD);
    LONG(WINAPI *RegQueryValueExA)(HKEY, LPCSTR, LPDWORD, LPDWORD, LPBYTE, LPDWORD);
    LONG(WINAPI *RegDeleteKeyExW)(HKEY, LPCWSTR, REGSAM, DWORD);
    LONG(WINAPI *RegDeleteKeyExA)(HKEY, LPCSTR, REGSAM, DWORD);
    LONG(WINAPI *RegDeleteKeyW)(HKEY, LPCWSTR);
    LONG(WINAPI *RegDeleteKeyA)(HKEY, LPCSTR);
    LONG(WINAPI *RegDeleteValueW)(HKEY, LPCWSTR);
    LONG(WINAPI *RegDeleteValueA)(HKEY, LPCSTR);
    LONG(WINAPI *RegCloseKey)(HKEY);
    LONG(WINAPI *RegFlushKey)(HKEY);
    LONG(WINAPI *RegQueryInfoKeyW)(HKEY, LPWSTR, LPDWORD, LPDWORD, LPDWORD, LPDWORD, LPDWORD, LPDWORD, LPDWORD, LPDWORD, LPDWORD, PFILETIME);
    LONG(WINAPI *RegEnumValueW)(HKEY, DWORD, LPWSTR, LPDWORD, LPDWORD, LPDWORD, LPBYTE, LPDWORD);
    LONG(WINAPI *RegEnumKeyExW)(HKEY, DWORD, LPWSTR, LPDWORD, LPDWORD, LPWSTR, LPDWORD, PFILETIME);
} WsOriginals;

typedef NTSTATUS(NTAPI *WsNtQueryKeyFn)(HANDLE, int, PVOID, ULONG, PULONG);

extern WsConfig g_ws;
extern WsOriginals g_orig;
extern WinstageStageApi g_wsStage;   /* currently bound provider (never NULL after init) */
extern WsNtQueryKeyFn g_NtQueryKey;

/* --- ws_util.c: reentrant lock (defect 4) -------------------------------
 * The old per-module spinlocks (`while (InterlockedCompareExchange(...))`) were
 * not reentrant: exactly the same thread re-entering one of them spins for ever.
 * That is one of the observed "hang" shapes. `WsLock` records owner tid + depth,
 * so the owner re-enters freely, and the wait path backs off (tight spin ->
 * SwitchToThread -> Sleep) with a bounded cap instead of hard-freezing. A long
 * wait is logged once as `STUCK ... lock <name>` so a stall names itself. */
typedef struct WsLock {
    volatile LONG held;    /* 0 = free, 1 = held */
    volatile LONG depth;   /* reentrancy depth, owner-only */
    volatile DWORD owner;  /* GetCurrentThreadId() of the holder */
    const char *name;      /* literal, for stuck diagnostics */
} WsLock;

void ws_lock_init(WsLock *l, const char *name);
void ws_lock_enter(WsLock *l);
void ws_lock_leave(WsLock *l);

/* --- ws_util.c: stuck self-report (defect 5) ----------------------------
 * A daemon thread scans a per-thread registry of "which hook is this thread in,
 * and since when" every few seconds and logs `STUCK <ms> in <name> ...` for any
 * entry that outlives the threshold. One slot per thread (a nested hook updates
 * the same slot); the registry is best-effort and never blocks the hot path. */
void ws_stuck_enter(const char *name);
void ws_stuck_path(const wchar_t *path);
void ws_stuck_leave(void);

/* Scope guard: `WS_STUCK("CreateFileW");` at the top of a hook registers the
 * call for its whole scope and clears it on *every* return path (compiler
 * cleanup attribute). `name` must outlive the call (string literal). */
#define WS_STUCK_CAT2_(a, b) a##b
#define WS_STUCK_CAT_(a, b) WS_STUCK_CAT2_(a, b)
static void ws_stuck_leave_cb_(void *unused)
{
    (void)unused;
    ws_stuck_leave();
}
#define WS_STUCK(name)                                                        \
    int WS_STUCK_CAT_(ws_stuck_scope_, __LINE__)                              \
        __attribute__((cleanup(ws_stuck_leave_cb_))) = 0;                     \
    ws_stuck_enter(name)

/* --- ws_util.c ---------------------------------------------------------- */
void ws_log(const char *fmt, ...);
void ws_log_w(const wchar_t *tag, const wchar_t *detail);
/* Structured audit sink (WINSTAGE_AUDIT_LOG). `ws_audit` appends one JSONL line
 * (with pid/tid prefix); `ws_audit_escape_w` renders a wide path/value as an
 * escaped UTF-8 JSON string body. Both are no-ops when auditPath is empty. */
void ws_audit(const char *fmt, ...);
int  ws_audit_escape_w(const wchar_t *in, char *out, size_t cch);
/* Convenience: emit `{"op":"<op>",...}` for a single path plus an optional
 * pre-built JSON fragment (`extra`, may be NULL). */
void ws_audit_path(const char *op, const wchar_t *path, const char *extra);
size_t ws_strlcpy_w(wchar_t *dst, const wchar_t *src, size_t cch);
wchar_t *ws_strdup_w(const wchar_t *s);          /* HeapAlloc; caller frees with ws_free */
void ws_free(void *p);
int ws_starts_with_ci_w(const wchar_t *s, const wchar_t *prefix);
int ws_iends_with_ci_w(const wchar_t *s, const wchar_t *suffix);
void ws_tolower_w(wchar_t *s);
int ws_wcscmp_ci(const wchar_t *a, const wchar_t *b);
/* Append src to a WS_PATH_MAX sized buffer at *pos. Returns 0 on overflow. */
int ws_append_w(wchar_t *dst, size_t cch, size_t *pos, const wchar_t *src);
int ws_appendf_w(wchar_t *dst, size_t cch, size_t *pos, const wchar_t *fmt, ...);

void ws_config_defaults(void);
int ws_config_load_file(const wchar_t *path);
void ws_config_from_env(void);
int ws_config_get_string(const char *json, const char *key, wchar_t *out, DWORD cch);
int ws_config_get_bool(const char *json, const char *key, int *out);
int ws_read_text_file(const wchar_t *path, char **out, DWORD *outLen); /* HeapAlloc; NUL-terminated */
/* File opens used *inside* the shim: routed through the captured original
 * CreateFileW when available, because the IAT pass does not reliably skip this
 * module and a direct call re-enters the hooks (that recursion is what produced
 * STATUS_STACK_OVERFLOW 0xC00000FD once read masking was enabled). */
HANDLE ws_open_file_raw(const wchar_t *path, DWORD access, DWORD share, DWORD disposition);
void *ws_open_file_raw_flags(const wchar_t *path, DWORD access, DWORD share, DWORD disposition, DWORD flags);
int ws_write_bytes_to_file(const wchar_t *path, const void *data, DWORD len); /* create/truncate */

/* Normalize a caller-supplied path: strip \\?\ and \\?\UNC\ prefixes, collapse
 * forward slashes, drop a trailing slash (except for drive roots). */
int ws_normalize_path(const wchar_t *in, wchar_t *out, DWORD cch);

/* Normalize a registry subkey path (forward slashes accepted, leading and
 * duplicated separators removed, no trailing separator). */
int ws_normalize_key_path(const wchar_t *in, wchar_t *out, DWORD cch);

/* Create every intermediate directory of `path` (the final component may or may
 * not exist; if it does not, it is created too when asDir != 0). */
int ws_ensure_dirs(const wchar_t *path, int asDir);

void ws_hex_encode_w(const wchar_t *s, wchar_t *out, size_t outCch); /* 4 hex digits per wchar_t */
int ws_hex_decode_w(const wchar_t *hex, wchar_t *out, size_t outCch);
void ws_hex_encode_b(const BYTE *b, DWORD len, char *out, size_t outCch);
int ws_hex_decode_b(const char *hex, BYTE *out, DWORD outCap, DWORD *outLen);

/* --- ws_stage.c (built-in default provider) ----------------------------- */
extern const WinstageStageApi g_defaultStage;
const WinstageStageApi *ws_stage_default_get(void);

/* Registry overlay storage (used by ws_reg.c through the provider when the
 * provider is the built-in one; T3 replaces the whole provider). */
int ws_hive_prefix_of(HKEY hive, wchar_t *out, DWORD cch);
int ws_key_path_of_handle(HKEY hive, LPCWSTR subkey, wchar_t *hiveOut, DWORD hiveCch, wchar_t *subkeyOut, DWORD subkeyCch);
int ws_handle_reg_path(HKEY key, wchar_t *hiveOut, DWORD hiveCch, wchar_t *subkeyOut, DWORD subkeyCch);
void ws_reg_set_current_user_sid(const wchar_t *sid);
const wchar_t *ws_current_user_sid(void);

/* --- ws_hook.c ---------------------------------------------------------- */
int  ws_hook_init(void);      /* capture originals (idempotent) */
int  ws_hook_install(void);   /* patch import tables + export interception */
void ws_hook_remove(void);
int  ws_hook_refresh(void);
void *ws_hook_original_by_name(const char *name);
int  ws_hook_stats(int *iatSites, int *modules, int *delaySites);

/* --- ws_t3reg.c: T3-aligned registry staging (docs/T3-??md ?4) --- */
__declspec(dllexport) UINT32 __cdecl DshRegStageAbiVersion(void);
__declspec(dllexport) LSTATUS __cdecl DshRegStageAttach(const wchar_t *stageRoot, const wchar_t *sessionId);
__declspec(dllexport) LSTATUS __cdecl DshRegStageDetach(void);
__declspec(dllexport) LSTATUS __cdecl DshRegStageJournalAppend(const void *record, const wchar_t *path,
                                         const wchar_t *valueName, const void *data,
                                         UINT32 *outBytesWritten);
__declspec(dllexport) LSTATUS __cdecl DshRegStageAttachState(void *out);
int ws_t3_is_attached(void);
HKEY ws_t3_hive_root(void);
const wchar_t *ws_t3_session_dir(void);
UINT32 ws_t3_records_appended(void);
LSTATUS ws_t3_last_status(void);
LSTATUS ws_t3_open_key(const wchar_t *canonical, int create, REGSAM sam, HKEY *out);
LSTATUS ws_t3_key_exists(const wchar_t *canonical, int *exists);
LSTATUS ws_t3_record_create_key(const wchar_t *canonical);
LSTATUS ws_t3_record_delete_key(const wchar_t *canonical);
LSTATUS ws_t3_record_set_value(const wchar_t *canonical, const wchar_t *name, UINT16 type,
                               const void *data, UINT32 dataBytes, int isVolatile);
LSTATUS ws_t3_record_delete_value(const wchar_t *canonical, const wchar_t *name, int isVolatile);
LSTATUS ws_t3_record_hard_deny(const wchar_t *pathOrPlaceholder, UINT32 status);

/* --- ws_regstore.c: registry provider on top of the app hive + WAL --- */
const wchar_t *ws_short_hive_of(HKEY hive);
int ws_rstore_canonical(HKEY hKey, LPCWSTR lpSubKey, wchar_t *hiveShort, DWORD hiveCch,
                        wchar_t *canonical, DWORD canonicalCch, int *isPseudo, int *isBareHiveRoot);
int ws_rstore_key_resolve(const wchar_t *hive, const wchar_t *subkey, uint32_t intent,
                          wchar_t *out_path, uint32_t out_cch, uint32_t *out_flags);
/* RegCreateKeyExW on a key that exists nowhere: materialize it (WAL-first) so that
 * path-based opens/values resolve against the overlay instead of the real hive. */
int ws_rstore_key_materialize(const wchar_t *hive, const wchar_t *subkey);
int ws_rstore_key_delete(const wchar_t *hive, const wchar_t *subkey);
int ws_rstore_value_set(const wchar_t *hive, const wchar_t *subkey, const wchar_t *name,
                        uint32_t type, const unsigned char *data, uint32_t len);
int ws_rstore_value_get(const wchar_t *hive, const wchar_t *subkey, const wchar_t *name,
                        uint32_t *type_out, unsigned char *data_out, uint32_t *len_inout,
                        uint32_t *flags_out);
int ws_rstore_value_delete(const wchar_t *hive, const wchar_t *subkey, const wchar_t *name);
int ws_rstore_value_enum(const wchar_t *hive, const wchar_t *subkey, uint32_t index,
                         wchar_t *name_out, uint32_t name_cch, uint32_t *type_out,
                         unsigned char *data_out, uint32_t *len_inout, uint32_t *flags_out);
int ws_rstore_key_enum(const wchar_t *hive, const wchar_t *subkey, uint32_t index,
                       wchar_t *name_out, uint32_t name_cch);
LSTATUS ws_rstore_hard_deny(const wchar_t *pathOrPlaceholder, UINT32 status);
/* open a key in the REAL hive by (short hive name, relative subkey) */
HKEY ws_reg_open_real_pub(const wchar_t *hive, const wchar_t *rel, DWORD samDesired);
int ws_rstore_is_tombstoned(const wchar_t *canonical, const wchar_t *name, int isKey);

/* --- ws_mask.c: process-level read masking (task-10 execution half) --- */
LSTATUS ws_mask_init(void);
int ws_mask_declared(void);
int ws_mask_rule_count(void);
int ws_mask_decide_read(const wchar_t *path, wchar_t *outRule, DWORD outRuleCch);
void ws_mask_normalized(const wchar_t *path, wchar_t *out, DWORD cch);
int ws_mask_check_probes(const wchar_t *maskFile, const wchar_t *outFile, char *summary, DWORD summaryCch);
int ws_mask_check_path_file(const wchar_t *maskFile, const wchar_t *path, char *out, DWORD cch);

/* --- ws_reg.c: pseudo handles (table lookup only, never a numeric guess) --- */
int ws_pseudo_key_path(HKEY hKey, wchar_t *hiveOut, DWORD hiveCch,
                       wchar_t *canonicalOut, DWORD canonicalCch, int *isPseudo);
HKEY ws_pseudo_key_make(const wchar_t *hive, const wchar_t *canonical);
void ws_pseudo_key_free(HKEY hKey);
int ws_pseudo_key_is(HKEY hKey);
int ws_pseudo_key_live_count(void);

/* Hooked functions implemented in ws_file.c / ws_reg.c, installed by ws_hook.c. */
void *ws_hook_resolve(const char *apiName);
void *ws_hook_resolve_n(const char *name, size_t len);
const char *const *ws_hook_target_names(size_t *count);

/* --- ws_file.c ---------------------------------------------------------- */
HANDLE WINAPI ws_CreateFileW(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
HANDLE WINAPI ws_CreateFileA(LPCSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
BOOL WINAPI ws_CreateDirectoryW(LPCWSTR, LPSECURITY_ATTRIBUTES);
BOOL WINAPI ws_CreateDirectoryA(LPCSTR, LPSECURITY_ATTRIBUTES);
BOOL WINAPI ws_DeleteFileW(LPCWSTR);
BOOL WINAPI ws_DeleteFileA(LPCSTR);
BOOL WINAPI ws_MoveFileExW(LPCWSTR, LPCWSTR, DWORD);
BOOL WINAPI ws_MoveFileExA(LPCSTR, LPCSTR, DWORD);
BOOL WINAPI ws_MoveFileW(LPCWSTR, LPCWSTR);
BOOL WINAPI ws_MoveFileA(LPCSTR, LPCSTR);
BOOL WINAPI ws_RemoveDirectoryW(LPCWSTR);
BOOL WINAPI ws_RemoveDirectoryA(LPCSTR);
BOOL WINAPI ws_CopyFileW(LPCWSTR, LPCWSTR, BOOL);
BOOL WINAPI ws_CopyFileA(LPCSTR, LPCSTR, BOOL);
BOOL WINAPI ws_SetFileAttributesW(LPCWSTR, DWORD);
DWORD WINAPI ws_GetFileAttributesW(LPCWSTR);
DWORD WINAPI ws_GetFileAttributesA(LPCSTR);
BOOL WINAPI ws_GetFileAttributesExW(LPCWSTR, GET_FILEEX_INFO_LEVELS, LPVOID);
BOOL WINAPI ws_GetFileAttributesExA(LPCSTR, GET_FILEEX_INFO_LEVELS, LPVOID);

/* --- ws_reg.c ----------------------------------------------------------- */
LONG WINAPI ws_RegCreateKeyExW(HKEY, LPCWSTR, DWORD, LPWSTR, DWORD, REGSAM, LPSECURITY_ATTRIBUTES, PHKEY, LPDWORD);
LONG WINAPI ws_RegCreateKeyExA(HKEY, LPCSTR, DWORD, LPSTR, DWORD, REGSAM, LPSECURITY_ATTRIBUTES, PHKEY, LPDWORD);
LONG WINAPI ws_RegCreateKeyW(HKEY, LPCWSTR, PHKEY);
LONG WINAPI ws_RegCreateKeyA(HKEY, LPCSTR, PHKEY);
LONG WINAPI ws_RegOpenKeyExW(HKEY, LPCWSTR, DWORD, REGSAM, PHKEY);
LONG WINAPI ws_RegOpenKeyExA(HKEY, LPCSTR, DWORD, REGSAM, PHKEY);
LONG WINAPI ws_RegOpenKeyW(HKEY, LPCWSTR, PHKEY);
LONG WINAPI ws_RegOpenKeyA(HKEY, LPCSTR, PHKEY);
LONG WINAPI ws_RegSetValueExW(HKEY, LPCWSTR, DWORD, DWORD, const BYTE *, DWORD);
LONG WINAPI ws_RegSetValueExA(HKEY, LPCSTR, DWORD, DWORD, const BYTE *, DWORD);
LONG WINAPI ws_RegQueryValueExW(HKEY, LPCWSTR, LPDWORD, LPDWORD, LPBYTE, LPDWORD);
LONG WINAPI ws_RegQueryValueExA(HKEY, LPCSTR, LPDWORD, LPDWORD, LPBYTE, LPDWORD);
LONG WINAPI ws_RegDeleteKeyExW(HKEY, LPCWSTR, REGSAM, DWORD);
LONG WINAPI ws_RegDeleteKeyExA(HKEY, LPCSTR, REGSAM, DWORD);
LONG WINAPI ws_RegDeleteKeyW(HKEY, LPCWSTR);
LONG WINAPI ws_RegDeleteKeyA(HKEY, LPCSTR);
LONG WINAPI ws_RegDeleteValueW(HKEY, LPCWSTR);
LONG WINAPI ws_RegDeleteValueA(HKEY, LPCSTR);
LONG WINAPI ws_RegCloseKey(HKEY);
LONG WINAPI ws_RegFlushKey(HKEY);
LONG WINAPI ws_RegQueryInfoKeyW(HKEY, LPWSTR, LPDWORD, LPDWORD, LPDWORD, LPDWORD, LPDWORD, LPDWORD, LPDWORD, LPDWORD, LPDWORD, PFILETIME);
LONG WINAPI ws_RegEnumValueW(HKEY, DWORD, LPWSTR, LPDWORD, LPDWORD, LPDWORD, LPBYTE, LPDWORD);
LONG WINAPI ws_RegEnumKeyExW(HKEY, DWORD, LPWSTR, LPDWORD, LPDWORD, LPWSTR, LPDWORD, PFILETIME);

/* --- ws_file.c: directive-level deletion + the non-Win32 exports ---------- */
NTSTATUS NTAPI ws_NtOpenFile(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, ULONG, ULONG);
NTSTATUS NTAPI ws_NtSetInformationFile(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
BOOL WINAPI ws_MoveFileWithProgressW(LPCWSTR, LPCWSTR, LPPROGRESS_ROUTINE, LPVOID, DWORD);

/* --- ws_proc.c: CreateProcess* + child self-injection -------------------- */
void ws_proc_set_self_module(HMODULE self);
BOOL WINAPI ws_CreateProcessW(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD,
                              LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);
BOOL WINAPI ws_CreateProcessAsUserW(HANDLE, LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES,
                                    BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);

/* --- ws_hook.c ---------------------------------------------------------- */
FARPROC WINAPI ws_GetProcAddress(HMODULE, LPCSTR);
HMODULE WINAPI ws_LoadLibraryW(LPCWSTR);
HMODULE WINAPI ws_LoadLibraryA(LPCSTR);
HMODULE WINAPI ws_LoadLibraryExW(LPCWSTR, HANDLE, DWORD);
HMODULE WINAPI ws_LoadLibraryExA(LPCSTR, HANDLE, DWORD);
NTSTATUS NTAPI ws_LdrGetProcedureAddress(PVOID, const void *, ULONG, PVOID *);
/* task-13：单模块补丁的加载路径扩展（见 ws_hook.c 的 ws_patch_one 长注释）。 */
NTSTATUS NTAPI ws_LdrLoadDll(PCWSTR, PULONG, const void *, PHANDLE);
/* task-13 ②：ntdll 属性查询面的 overlay-aware 包装（见 ws_file.c 的长注释）。 */
NTSTATUS NTAPI ws_NtQueryAttributesFile(const void *, PVOID);
NTSTATUS NTAPI ws_NtQueryFullAttributesFile(const void *, PVOID);
int ws_hook_refresh_module(HMODULE base);

#endif /* WINSTAGE_INTERNAL_H */
