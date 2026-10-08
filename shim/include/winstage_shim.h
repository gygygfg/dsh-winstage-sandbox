/* WinStageSandbox -- T4 shim DLL public interface.
 *
 * The shim is injected into a sandboxed process tree and virtualizes file and
 * registry writes into a staging tree ("overlay"), while reads fall through to
 * the real system for objects that are not present in the overlay.
 *
 * Exported symbols (x64, no name decoration):
 *   WinstageShimInit(const wchar_t* configJsonPath) -> int
 *   WinstageShimShutdown(void)
 *   WinstageShimAbiVersion(void) -> unsigned
 *   WinstageShimBindStageApi(const WinstageStageApi*) -> int   [T3 hook-up point]
 *   WinstageShimOriginal(const char* apiName) -> void*         [diagnostics]
 *   WinstageShimRefreshHooks(void) -> int                      [re-scan IATs]
 *   WinstageShimStatsJson(char* buf, unsigned cch) -> int
 *
 * Auto-initialization: because remote LoadLibraryW only runs DllMain (there is
 * no way to call the export in the target without extra machinery), DllMain
 * also auto-initializes from the environment when WINSTAGE_STAGE_ROOT and/or
 * WINSTAGE_SHIM_CONFIG are present. WinstageShimInit(null) performs the same
 * environment-driven initialization and is what a launcher-side explicit call
 * should use.
 *
 * Fail-closed: if the shim is initialized (hooks installed) but cannot stage a
 * write (no usable stage root, provider error, staging I/O failure), the hooked
 * call FAILS with ERROR_ACCESS_DENIED instead of falling through to the real
 * system. See docs/T4-shim?.md "fail-closed ?".
 */
#ifndef WINSTAGE_SHIM_H
#define WINSTAGE_SHIM_H

#include <stdint.h>
#include "winstage_stage_api.h"

#ifdef __cplusplus
extern "C" {
#endif

#define WINSTAGE_SHIM_ABI_VERSION 1u

/* Initialize and install hooks.
 *   configJsonPath : path to a UTF-8/ASCII JSON config file, or NULL to take
 *                    configuration from the environment.
 * Returns 0 on success, a Win32 error code on failure. Calling it twice is
 * safe and returns 0 (idempotent). */
__declspec(dllexport) int __cdecl WinstageShimInit(const wchar_t *configJsonPath);

/* Remove hooks (best effort) and release resources. */
__declspec(dllexport) void __cdecl WinstageShimShutdown(void);

/* ABI version of this DLL. */
__declspec(dllexport) uint32_t __cdecl WinstageShimAbiVersion(void);

/* Adopt an external staging provider (T3's registry staging layer). The
 * structure must stay valid for the lifetime of the process. Returns 0 on
 * success, ERROR_INVALID_PARAMETER on ABI/struct mismatch. */
__declspec(dllexport) int __cdecl WinstageShimBindStageApi(const WinstageStageApi *api);

/* Address of the original (unhooked) function the shim captured for `apiName`
 * (e.g. "CreateFileW", "RegSetValueExW"). NULL if unknown. Diagnostics only. */
__declspec(dllexport) void *__cdecl WinstageShimOriginal(const char *apiName);

/* Re-scan the import tables of every loaded module (used after a module is
 * loaded through a path the shim does not observe). */
__declspec(dllexport) int __cdecl WinstageShimRefreshHooks(void);

/* Diagnostics: writes a JSON status object into buf (UTF-8). Returns the number
 * of bytes that would have been written (like snprintf), or 0 on bad args. */
__declspec(dllexport) int __cdecl WinstageShimStatsJson(char *buf, unsigned cch);

/* Environment contract (read at init):
 *   WINSTAGE_STAGE_ROOT   required for staging; e.g. C:\...\shim\.stage\run1
 *   WINSTAGE_SHIM_CONFIG  optional path to the JSON config
 *   WINSTAGE_SHIM_DISABLE if set and not "0", the shim does nothing (escape
 *                         hatch so host tooling can run unsandboxed)
 *   WINSTAGE_SHIM_LOG     optional log file path (overrides config)
 */
#define WINSTAGE_ENV_STAGE_ROOT L"WINSTAGE_STAGE_ROOT"
#define WINSTAGE_ENV_CONFIG     L"WINSTAGE_SHIM_CONFIG"
#define WINSTAGE_ENV_DISABLE    L"WINSTAGE_SHIM_DISABLE"
#define WINSTAGE_ENV_LOG        L"WINSTAGE_SHIM_LOG"

#ifdef __cplusplus
}
#endif
#endif /* WINSTAGE_SHIM_H */
