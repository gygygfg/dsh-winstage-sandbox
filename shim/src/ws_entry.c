/* WinStageSandbox -- T4 shim: DllMain, initialization and exported ABI. */
#include "winstage_internal.h"

#include <stdio.h>

int g_stageBound = 0;

static void ws_env_get(const wchar_t *name, wchar_t *out, DWORD cch)
{
    out[0] = 0;
    DWORD n = GetEnvironmentVariableW(name, out, cch);
    if (n == 0 || n >= cch) {
        out[0] = 0;
    }
}

static int ws_env_truthy(const wchar_t *name)
{
    wchar_t v[16];
    ws_env_get(name, v, 16);
    if (!v[0]) {
        return 0;
    }
    return !(v[0] == L'0' && v[1] == 0);
}

/* Format the current process token user SID as "S-1-5-21-...". */
static void ws_compute_user_sid(wchar_t *out, DWORD cch)
{
    /* ★ WP13（A2）：`OpenProcessToken` / `GetTokenInformation` / `CloseHandle` 都会改
     * 调用线程的 last error；本函数在**初始化期**跑、且结果只写进 `out`（无错误返回）
     * ⇒ 入口保存、两条出口还原。 */
    DWORD ws_saved_last_error = GetLastError();
    out[0] = 0;
    HANDLE tok = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok)) {
        SetLastError(ws_saved_last_error);
        return;
    }
    BYTE buf[512];
    DWORD len = 0;
    if (GetTokenInformation(tok, TokenUser, buf, sizeof(buf), &len)) {
        SID *sid = ((TOKEN_USER *)buf)->User.Sid;
        if (sid) {
            size_t pos = 0;
            ws_appendf_w(out, cch, &pos, L"S-%u-%llu", (unsigned)sid->Revision,
                         (unsigned long long)(((unsigned long long)sid->IdentifierAuthority.Value[0] << 40) |
                                              ((unsigned long long)sid->IdentifierAuthority.Value[1] << 32) |
                                              ((unsigned long long)sid->IdentifierAuthority.Value[2] << 24) |
                                              ((unsigned long long)sid->IdentifierAuthority.Value[3] << 16) |
                                              ((unsigned long long)sid->IdentifierAuthority.Value[4] << 8) |
                                              ((unsigned long long)sid->IdentifierAuthority.Value[5])));
            for (DWORD i = 0; i < sid->SubAuthorityCount; i++) {
                ws_appendf_w(out, cch, &pos, L"-%lu", (unsigned long)sid->SubAuthority[i]);
            }
        }
    }
    CloseHandle(tok);
    SetLastError(ws_saved_last_error);
}

static int ws_prepare_stage_root(void)
{
    /* ★ WP13（A5）：初始化期创建 stage 树（fs/wo/reg），内部走
     * `ws_ensure_dirs`（已透明）与字符串拼接；成败由返回值表达 ⇒ 同样入口保存、
     * 每条出口还原，避免把 init 期的中间错误留在被注入载体的线程上。 */
    DWORD ws_saved_last_error = GetLastError();
    if (!g_ws.haveStageRoot || !g_ws.stageRoot[0]) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    if (!ws_ensure_dirs(g_ws.stageRoot, 1)) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    wchar_t sub[WS_PATH_MAX];
    static const wchar_t *parts[] = { L"fs", L"wo", L"reg" };
    for (size_t i = 0; i < sizeof(parts) / sizeof(parts[0]); i++) {
        size_t pos = 0;
        sub[0] = 0;
        ws_append_w(sub, WS_PATH_MAX, &pos, g_ws.stageRoot);
        ws_append_w(sub, WS_PATH_MAX, &pos, L"\\");
        ws_append_w(sub, WS_PATH_MAX, &pos, parts[i]);
        if (!ws_ensure_dirs(sub, 1)) {
            SetLastError(ws_saved_last_error);
            return 0;
        }
    }
    if (!g_ws.logPath[0]) {
        size_t pos = 0;
        ws_append_w(g_ws.logPath, WS_PATH_MAX, &pos, g_ws.stageRoot);
        ws_append_w(g_ws.logPath, WS_PATH_MAX, &pos, L"\\shim.log");
    }
    SetLastError(ws_saved_last_error);
    return 1;
}

static void ws_store_user_sid(void)
{
    wchar_t sid[192];
    ws_compute_user_sid(sid, 192);
    ws_reg_set_current_user_sid(sid);
}

static int ws_init_full(const wchar_t *configJsonPath)
{
    if (g_ws.initialized) {
        return 0;
    }
    if (ws_env_truthy(WINSTAGE_ENV_DISABLE)) {
        return ERROR_SERVICE_DISABLED;
    }
    ws_config_defaults();
    ws_config_from_env();
    wchar_t envRoot[WS_PATH_MAX], envLog[WS_PATH_MAX];
    int haveEnvRoot = g_ws.haveStageRoot;
    ws_strlcpy_w(envRoot, g_ws.stageRoot, WS_PATH_MAX);
    ws_strlcpy_w(envLog, g_ws.logPath, WS_PATH_MAX);
    if (configJsonPath && configJsonPath[0]) {
        ws_strlcpy_w(g_ws.configPath, configJsonPath, WS_PATH_MAX);
    }
    if (g_ws.configPath[0] && !ws_config_load_file(g_ws.configPath)) {
        return ERROR_BAD_CONFIGURATION;
    }
    if (haveEnvRoot) {
        ws_strlcpy_w(g_ws.stageRoot, envRoot, WS_PATH_MAX);
        g_ws.haveStageRoot = 1;
    }
    if (envLog[0]) {
        ws_strlcpy_w(g_ws.logPath, envLog, WS_PATH_MAX);
    }
    if (!g_ws.haveStageRoot) {
        return ERROR_BAD_CONFIGURATION;
    }
    if (!ws_prepare_stage_root()) {
        return ERROR_PATH_NOT_FOUND;
    }
    ws_store_user_sid();

    if (!g_stageBound) {
        g_wsStage = g_defaultStage;
    }
    /* Attach T3's registry staging (app hive + WAL). The session directory is
     * either WINSTAGE_REGSTAGE_SESSION_DIR, DSH_REGSTAGE_ROOT (T3's name), or the
     * file staging root. Failure is not fatal for the file layer but makes every
     * registry write fail closed (never a real-hive write). */
    if (!ws_t3_is_attached()) {
        wchar_t sessionDir[WS_PATH_MAX];
        sessionDir[0] = 0;
        ws_env_get(L"WINSTAGE_REGSTAGE_SESSION_DIR", sessionDir, WS_PATH_MAX);
        if (!sessionDir[0]) {
            ws_env_get(L"DSH_REGSTAGE_ROOT", sessionDir, WS_PATH_MAX);
        }
        if (!sessionDir[0]) {
            ws_strlcpy_w(sessionDir, g_ws.stageRoot, WS_PATH_MAX);
        }
        LSTATUS rc = DshRegStageAttach(sessionDir, L"winstage-shim");
        if (rc != ERROR_SUCCESS) {
            ws_log("DshRegStageAttach failed: %lu (sessionDir=%ls); registry writes will fail closed",
                   (unsigned long)rc, sessionDir);
        }
    }
    /* Capture the original API pointers first: read-mask normalization goes
     * through them, so the mask must be initialized after ws_hook_init. */
    ws_hook_init();
    LSTATUS maskRc = ws_mask_init();
    if (maskRc < 0) {
        ws_log("read mask is declared but could not be honored: reads will be denied (fail-closed)");
    }
    ws_hook_install();
    g_ws.initialized = 1;
    ws_log("initialized: stageRoot=%ls provider=%ls failClosed=%d readThrough=%d",
           g_ws.stageRoot, g_wsStage.name ? g_wsStage.name : L"(none)", g_ws.failClosed, g_ws.readThrough);
    /* ★ WP13（A6）—— 全仓**唯一**保留的"硬清零"，理由：
     * 本函数从 `DllMain(DLL_PROCESS_ATTACH)` 调用，而初始化过程里的
     * `CreateDirectoryW` / `GetFileAttributesW` / `GetTokenInformation` /
     * `RegLoadAppKeyW` / `SetNamedSecurityInfoW` 都是**探测式**调用：失败是预期内的
     * （stageRoot 已存在、hive 已有属主、hive 被占用……），它们会把 last error 留在
     * `ERROR_ALREADY_EXISTS(183)` / `ERROR_FILE_NOT_FOUND(2)` / `ERROR_SHARING_VIOLATION(32)`。
     * 这里"还原入口值"没有意义：入口值本身是这些调用之前的任意值，且被注入进程的加载器
     * 没有义务先清零。DllMain 成功返回后按 Win32 约定该线程的 last error 未被定义，
     * **显式清零是唯一能让紧随其后的 CLR 初始化读到 ERROR_SUCCESS 的做法** ——
     * 即签名 A(`0xFFFF0000`/`0x8007054F`) 与签名 B(`0x80070002`) 的止血点。
     * 安全性：`SetLastError` 只写 TEB、不经过任何 IAT，因此不会被本 DLL 的钩子重入，
     * 也不会与 `ws_log` 自身的保存/还原互相干扰。 */
    SetLastError(0);
    return 0;
}

int __cdecl WinstageShimInit(const wchar_t *configJsonPath)
{
    return ws_init_full(configJsonPath);
}

void __cdecl WinstageShimShutdown(void)
{
    if (!g_ws.initialized) {
        return;
    }
    ws_log("shutdown requested");
    ws_hook_remove();
    DshRegStageDetach();
    g_ws.initialized = 0;
}

uint32_t __cdecl WinstageShimAbiVersion(void)
{
    return WINSTAGE_SHIM_ABI_VERSION;
}

int __cdecl WinstageShimBindStageApi(const WinstageStageApi *api)
{
    if (!api || api->abi_version != WINSTAGE_STAGE_ABI_VERSION ||
        api->struct_size != (uint32_t)sizeof(WinstageStageApi)) {
        return ERROR_INVALID_PARAMETER;
    }
    if (!api->file_resolve || !api->reg_key_resolve ||
        !api->reg_value_set || !api->reg_value_get) {
        return ERROR_INVALID_PARAMETER;
    }
    g_wsStage = *api;
    g_stageBound = 1;
    return 0;
}

void *__cdecl WinstageShimOriginal(const char *apiName)
{
    return ws_hook_original_by_name(apiName);
}

int __cdecl WinstageShimRefreshHooks(void)
{
    return ws_hook_refresh();
}

/* Offline mask tools (used by winstage-probe.exe and the regression runner, so
 * they do not need a stage root or an active policy). */
__declspec(dllexport) int __cdecl WinstageShimMaskCheck(const wchar_t *maskFile, const wchar_t *outFile)
{
    char summary[256];
    int rc = ws_mask_check_probes(maskFile, outFile, summary, sizeof(summary));
    ws_log("WinstageShimMaskCheck: %s", summary);
    return rc;
}

__declspec(dllexport) int __cdecl WinstageShimCheckPath(const wchar_t *maskFile, const wchar_t *path,
                                                       char *outJson, unsigned cch)
{
    return ws_mask_check_path_file(maskFile, path, outJson, cch);
}

__declspec(dllexport) int __cdecl WinstageShimMaskRuleCount(void)
{
    return ws_mask_rule_count();
}

static size_t json_escape(char *dst, size_t cch, const char *src)
{
    size_t o = 0;
    for (; src && *src; src++) {
        if (o + 7 >= cch) {
            break;
        }
        switch (*src) {
        case '\\': dst[o++] = '\\'; dst[o++] = '\\'; break;
        case '"': dst[o++] = '\\'; dst[o++] = '"'; break;
        case '\n': dst[o++] = '\\'; dst[o++] = 'n'; break;
        case '\r': dst[o++] = '\\'; dst[o++] = 'r'; break;
        case '\t': dst[o++] = '\\'; dst[o++] = 't'; break;
        default: dst[o++] = *src; break;
        }
    }
    dst[o] = 0;
    return o;
}

int __cdecl WinstageShimStatsJson(char *buf, unsigned cch)
{
    int iatSites = 0, modules = 0, delaySites = 0;
    int installed = ws_hook_stats(&iatSites, &modules, &delaySites);
    char rootA[WS_PATH_MAX * 2], logA[WS_PATH_MAX * 2], cfgA[WS_PATH_MAX * 2];
    char rootE[WS_PATH_MAX * 3], logE[WS_PATH_MAX * 3], cfgE[WS_PATH_MAX * 3];
    char providerA[256];
    rootA[0] = logA[0] = cfgA[0] = providerA[0] = 0;
    WideCharToMultiByte(CP_UTF8, 0, g_ws.stageRoot, -1, rootA, sizeof(rootA), NULL, NULL);
    WideCharToMultiByte(CP_UTF8, 0, g_ws.logPath, -1, logA, sizeof(logA), NULL, NULL);
    WideCharToMultiByte(CP_UTF8, 0, g_ws.configPath, -1, cfgA, sizeof(cfgA), NULL, NULL);
    if (g_wsStage.name) {
        WideCharToMultiByte(CP_UTF8, 0, g_wsStage.name, -1, providerA, sizeof(providerA), NULL, NULL);
    }
    json_escape(rootE, sizeof(rootE), rootA);
    json_escape(logE, sizeof(logE), logA);
    json_escape(cfgE, sizeof(cfgE), cfgA);

    char tmp[WS_PATH_MAX * 6];
    int n = snprintf(tmp, sizeof(tmp),
                     "{\"dll\":\"winstage-shim\",\"abi\":%u,\"initialized\":%s,\"hooksInstalled\":%s,"
                     "\"stageRoot\":\"%s\",\"logPath\":\"%s\",\"configPath\":\"%s\",\"provider\":\"%s\","
                     "\"failClosed\":%s,\"readThrough\":%s,\"hooks\":{\"iatSites\":%d,\"modules\":%d,\"delayDescriptors\":%d},"
                     "\"pid\":%lu}",
                     (unsigned)WINSTAGE_SHIM_ABI_VERSION,
                     g_ws.initialized ? "true" : "false",
                     installed ? "true" : "false",
                     rootE, logE, cfgE, providerA,
                     g_ws.failClosed ? "true" : "false",
                     g_ws.readThrough ? "true" : "false",
                     iatSites, modules, delaySites,
                     (unsigned long)GetCurrentProcessId());
    if (n < 0) {
        return 0;
    }
    if (buf && cch) {
        unsigned copy = (unsigned)n < cch - 1 ? (unsigned)n : cch - 1;
        memcpy(buf, tmp, copy);
        buf[copy] = 0;
    }
    return n;
}

static int ws_wants_autoinit(void)
{
    if (ws_env_truthy(WINSTAGE_ENV_DISABLE)) {
        return 0;
    }
    wchar_t v[WS_PATH_MAX];
    ws_env_get(WINSTAGE_ENV_STAGE_ROOT, v, WS_PATH_MAX);
    if (v[0]) {
        return 1;
    }
    ws_env_get(WINSTAGE_ENV_CONFIG, v, WS_PATH_MAX);
    return v[0] ? 1 : 0;
}

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved)
{
    switch (fdwReason) {
    case DLL_PROCESS_ATTACH:
        DisableThreadLibraryCalls(hinstDLL);
        /* Remote injection only runs DllMain, so auto-initialize when the caller
         * (injector/launcher) has published the staging configuration in the
         * environment. No environment -> the DLL loads inert. */
        if (ws_wants_autoinit()) {
            int rc = ws_init_full(NULL);
            if (rc != 0) {
                /* Leave a breadcrumb; the launcher probes WinstageShimStatsJson and
                 * must see initialized=false and fall back. */
                ws_config_defaults();
                ws_config_from_env();
                if (!g_ws.logPath[0] && g_ws.stageRoot[0]) {
                    size_t pos = 0;
                    ws_append_w(g_ws.logPath, WS_PATH_MAX, &pos, g_ws.stageRoot);
                    ws_append_w(g_ws.logPath, WS_PATH_MAX, &pos, L"\\shim.log");
                }
                ws_log("auto-init failed: rc=%d", rc);
                /* 同 A6：DllMain 的**失败出口**也必须显式清零 —— 失败路径上
                 * `ws_config_defaults`/`ws_config_from_env`/`ws_log` 都会留下
                 * 探测式调用的错误（2/3/183），而被注入进程的 CLR 初始化紧随其后。 */
                SetLastError(0);
            }
        }
        break;
    case DLL_PROCESS_DETACH:
        if (g_ws.initialized) {
            /* R11-D-13d (v2)：**两条路径都要 dump**。Win32 在"进程终止"时以
             * lpvReserved != NULL 调用本分支，而短命探针进程走的正是这条路 ——
             * v1 把它挡在 !lpvReserved 之外，导致计数永不落盘。
             * 撤钩仍只在非终止路径做（保持既有语义）。 */
            if (!lpvReserved) {
                ws_hook_remove();
            }
            ws_count_dump();
            g_ws.initialized = 0;
        }
        break;
    default:
        break;
    }
    return TRUE;
}
