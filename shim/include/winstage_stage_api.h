/* WinStageSandbox -- T4 shim: staging-provider C ABI (draft 1).
 *
 * This header is the *interface* between the injected shim DLL and the file /
 * registry staging layer. A built-in default provider lives in
 * shim/src/ws_stage.c. T3 owns the "real" registry staging layer; when
 * docs/T3-?.md lands, T3 can export an implementation of this
 * struct and the shim adopts it through
 *
 *     WinstageShimBindStageApi(&t3_api);
 *
 * ABI rules:
 *  - `abi_version` must equal WINSTAGE_STAGE_ABI_VERSION and `struct_size` must
 *    equal sizeof(WinstageStageApi); the shim rejects anything else with
 *    ERROR_INVALID_PARAMETER (version negotiation point).
 *  - All strings are UTF-16 (wchar_t), NUL-terminated.
 *  - The shim never frees provider-owned strings and never retains the pointers
 *    written into `out_*` buffers beyond the duration of the call.
 *  - Return convention: 0 = success, -1 = provider failure (the shim then applies
 *    its fail-closed policy). Functions that can report "not present" use 1 for
 *    "not found" as documented per function.
 *  - Providers MUST NOT call the hooked Win32 APIs to do their work in a way
 *    that re-enters the shim for a path inside the staging tree; the shim treats
 *    every path under the staging root as passthrough, which makes the built-in
 *    provider's direct Win32 calls safe.
 */
#ifndef WINSTAGE_STAGE_API_H
#define WINSTAGE_STAGE_API_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define WINSTAGE_STAGE_ABI_VERSION 1u

/* --- intent ------------------------------------------------------------- */
#define WINSTAGE_IO_READ   1u
#define WINSTAGE_IO_WRITE  2u
#define WINSTAGE_IO_DELETE 3u

/* --- resolution flags written to out_flags ------------------------------ */
/* out_path points inside the staging tree; call the API with it. */
#define WINSTAGE_RES_STAGED   0x00000001u
/* The object was logically deleted. The caller must fail with
 * ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND (file) or ERROR_FILE_NOT_FOUND
 * (registry) and must NOT touch the real object. */
#define WINSTAGE_RES_WHITEOUT 0x00000002u
/* out_path is (or equals) the real path; read-through is permitted. */
#define WINSTAGE_RES_REAL     0x00000004u
/* Fail-closed: the provider refuses to serve this request. The caller must fail
 * the call and must not fall back to the real system. */
#define WINSTAGE_RES_DENY     0x00000008u
/* The staging location already exists (overlay hit) -- informational. */
#define WINSTAGE_RES_EXISTS   0x00000010u

typedef struct WinstageStageApi {
    uint32_t abi_version;   /* must be WINSTAGE_STAGE_ABI_VERSION */
    uint32_t struct_size;   /* sizeof(WinstageStageApi)           */
    const wchar_t *name;    /* informational, e.g. L"builtin-default" */

    /* ---- file layer ---------------------------------------------------- */
    /* Map a real Win32 path to the path the caller should actually use.
     *   real_path : normalized absolute path, e.g. L"C:\\Windows\\Temp\\a.txt"
     *               or L"\\\\server\\share\\a.txt" (no \\?\ prefix).
     *   intent    : WINSTAGE_IO_*
     *   out_path  : buffer of out_cch wchar_t
     *   out_flags : WINSTAGE_RES_*
     * Returns 0 on success, -1 if the provider cannot answer (the caller then
     * applies the fail-closed policy).
     * For WINSTAGE_IO_WRITE the provider must also ensure that the staging
     * parent directory exists. */
    int (*file_resolve)(const wchar_t *real_path, uint32_t intent,
                        wchar_t *out_path, uint32_t out_cch, uint32_t *out_flags);

    /* Record that real_path has been deleted. 0 = ok, -1 = error. */
    int (*file_whiteout)(const wchar_t *real_path);

    /* 1 = whiteout present, 0 = not whiteouted, -1 = error. */
    int (*file_whiteouted)(const wchar_t *real_path);

    /* ---- registry layer ------------------------------------------------ */
    /* Map a registry key to its staging location.
     *   hive    : canonical hive prefix, never a raw HKEY value: one of
     *             "HKEY_CURRENT_USER", "HKEY_LOCAL_MACHINE",
     *             "HKEY_CLASSES_ROOT", "HKEY_USERS", "HKEY_CURRENT_CONFIG".
     *   subkey  : subkey path without the hive prefix, e.g. L"Software\\Foo";
     *             may be empty (the hive root).
     *   out_path: staging location (a directory in the built-in provider).
     * For WINSTAGE_IO_WRITE the provider must create the staging key location.
     * Returns 0 on success, -1 on failure. */
    int (*reg_key_resolve)(const wchar_t *hive, const wchar_t *subkey, uint32_t intent,
                           wchar_t *out_path, uint32_t out_cch, uint32_t *out_flags);

    /* Store a value in the overlay. data may be NULL when len == 0.
     * 0 = ok, -1 = error. */
    int (*reg_value_set)(const wchar_t *hive, const wchar_t *subkey, const wchar_t *name,
                         uint32_t type, const unsigned char *data, uint32_t len);

    /* Read a value from the overlay.
     * 0 = ok (type_out/data_out/len_out valid), 1 = not present in the overlay
     * (caller may read through to the real hive), -1 = error. */
    int (*reg_value_get)(const wchar_t *hive, const wchar_t *subkey, const wchar_t *name,
                         uint32_t *type_out, unsigned char *data_out, uint32_t *len_inout,
                         uint32_t *flags_out);

    /* Mark a value deleted in the overlay. 0 = ok, -1 = error. */
    int (*reg_value_delete)(const wchar_t *hive, const wchar_t *subkey, const wchar_t *name);

    /* Mark a whole key deleted in the overlay (recursively, including values).
     * 0 = ok, -1 = error. */
    int (*reg_key_delete)(const wchar_t *hive, const wchar_t *subkey);

    /* Enumerate the values of an overlay key (index is 0-based over the live
     * values only; deleted values are not enumerated).
     * 0 = ok (out parameters valid), 1 = no more entries, -1 = error.
     * name_out is NUL-terminated and truncated to name_cch. If data_out is NULL
     * the caller only wants the size in *len_inout. */
    int (*reg_value_enum)(const wchar_t *hive, const wchar_t *subkey, uint32_t index,
                          wchar_t *name_out, uint32_t name_cch, uint32_t *type_out,
                          unsigned char *data_out, uint32_t *len_inout, uint32_t *flags_out);

    /* Enumerate the immediate subkeys of an overlay key.
     * 0 = ok, 1 = no more entries, -1 = error. */
    int (*reg_key_enum)(const wchar_t *hive, const wchar_t *subkey, uint32_t index,
                        wchar_t *name_out, uint32_t name_cch);
} WinstageStageApi;

typedef const WinstageStageApi *(*WinstageGetStageApiFn)(uint32_t requested_abi_version);

#ifdef __cplusplus
}
#endif
#endif /* WINSTAGE_STAGE_API_H */
