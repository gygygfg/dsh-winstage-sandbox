/* WinStageSandbox -- T4 shim: configuration, logging, path/string utilities.
 *
 * Invariant that makes the shim safe to write in C with ordinary Win32 calls:
 * the shim NEVER patches the import table of its own module (ws_hook.c skips it),
 * so every CreateFileW/CreateDirectoryW/... call made *from this DLL* still
 * reaches the real kernel32 implementation and cannot recurse into our hooks.
 * Do not "fix" that skip without re-auditing this file.
 */
#include "winstage_internal.h"

#include <stdio.h>

WsConfig g_ws;
WsOriginals g_orig;
WinstageStageApi g_wsStage;
WsNtQueryKeyFn g_NtQueryKey = NULL;

static volatile LONG g_logCounter = 0;
static wchar_t g_userSid[192];

/* ------------------------------------------------------------------ logging */

void ws_log(const char *fmt, ...)
{
    /* ★ Phase 3（2026-10-05）：**保存/还原调用线程的 last error**。
     *
     * 本函数写日志时用 `OPEN_ALWAYS` 打开**已存在**的日志文件，Win32 在那种情形下会把
     * 调用线程的 last error 置成 `ERROR_ALREADY_EXISTS (183)`；`WriteFile`/`CloseHandle`
     * 也会覆写它。被注入的子进程（如 `powershell.exe`）在 CLR 初始化
     * （`InitialSessionState` 的静态构造）期间读到这个被污染的值，就会以
     * `0xFFFF0000` 退出（HRESULT `0x8007054F`）—— 实测约 22% 的载体抖动就是这个原因，
     * 与"安全策略拦截"无关。
     *
     * 做法：入口取一次，**每一条退出路径**都还原（含两个提前 return 与正常出口）。
     * 钩子对调用方必须完全透明：它不能改变调用方看到的任何线程状态。
     */
    const DWORD ws_saved_last_error = GetLastError();
    if (!g_ws.logPath[0]) {
        SetLastError(ws_saved_last_error);
        return;
    }
    char line[WS_LOG_MAX];
    int n = 0;
    n += snprintf(line + n, sizeof(line) - (size_t)n, "[winstage-shim][%lu][%ld] ",
                  (unsigned long)GetCurrentProcessId(), (long)InterlockedIncrement(&g_logCounter));
    if (n < 0 || n >= (int)sizeof(line)) {
        SetLastError(ws_saved_last_error);
        return;
    }
    va_list ap;
    va_start(ap, fmt);
    int m = vsnprintf(line + n, sizeof(line) - (size_t)n - 2, fmt, ap);
    va_end(ap);
    if (m > 0) {
        n += m;
    }
    if (n > (int)sizeof(line) - 3) {
        n = (int)sizeof(line) - 3;
    }
    line[n++] = '\r';
    line[n++] = '\n';
    line[n] = 0;

    /* The log write must NOT go through this module's own import table: once a
     * provider module's IAT slot is hooked, an IAT-routed CreateFileW re-enters
     * ws_CreateFileW, whose verbose trace calls ws_log() again -- an immediate
     * infinite recursion. Use the original captured by ws_hook_init when it is
     * available; before that (early config/attach diagnostics) nothing is hooked
     * yet, so the plain call is safe. */
    HANDLE h;
    if (g_orig.CreateFileW) {
        h = g_orig.CreateFileW(g_ws.logPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                               NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    } else {
        h = CreateFileW(g_ws.logPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                        NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    }
    if (h == INVALID_HANDLE_VALUE) {
        SetLastError(ws_saved_last_error);
        return;
    }
    DWORD wrote = 0;
    WriteFile(h, line, (DWORD)n, &wrote, NULL);
    CloseHandle(h);
    SetLastError(ws_saved_last_error);
}

void ws_log_w(const wchar_t *tag, const wchar_t *detail)
{
    /* 同 `ws_log()`：`WideCharToMultiByte` 与下游的日志写入都会覆写 last error，
     * 这里同样入口保存、出口还原（本函数也会在**被注入的子进程内**执行）。 */
    const DWORD ws_saved_last_error = GetLastError();
    if (!g_ws.logPath[0]) {
        SetLastError(ws_saved_last_error);
        return;
    }
    char tagA[128];
    char detailA[2048];
    WideCharToMultiByte(CP_UTF8, 0, tag, -1, tagA, sizeof(tagA), NULL, NULL);
    WideCharToMultiByte(CP_UTF8, 0, detail ? detail : L"", -1, detailA, sizeof(detailA), NULL, NULL);
    ws_log("%s %s", tagA, detailA);
    SetLastError(ws_saved_last_error);
}

/* ---------------------------------------- reentrant lock + stuck reporter */
/* defect 4 + defect 5: see the declarations in winstage_internal.h. */

#define WS_LOCK_SPIN_TIGHT   4000u
#define WS_LOCK_SPIN_YIELD  40000u
#define WS_LOCK_STUCK_SPINS 400000u

#define WS_TRACE_SLOTS        128
#define WS_TRACE_PATH_CCH    1024
#define WS_STUCK_THRESHOLD_MS 10000u

void ws_lock_init(WsLock *l, const char *name)
{
    l->held = 0;
    l->depth = 0;
    l->owner = 0;
    l->name = name;
}

void ws_lock_enter(WsLock *l)
{
    DWORD tid = GetCurrentThreadId();
    /* Fast reentrant path: the owner never blocks against itself. */
    if (l->held && l->owner == tid) {
        InterlockedIncrement(&l->depth);
        return;
    }
    unsigned spins = 0;
    for (;;) {
        if (InterlockedCompareExchange(&l->held, 1, 0) == 0) {
            break;
        }
        /* Re-check reentrancy while spinning: a reentrant call from the *owner*
         * thread could arrive at any time (e.g. ws_log -> hook -> lock). */
        if (l->held && l->owner == tid) {
            InterlockedIncrement(&l->depth);
            return;
        }
        if (spins < WS_LOCK_SPIN_TIGHT) {
            YieldProcessor();
        } else if (spins < WS_LOCK_SPIN_YIELD) {
            SwitchToThread();
        } else {
            Sleep(0); /* bounded backoff: never a hard freeze */
        }
        spins++;
        if (spins == WS_LOCK_STUCK_SPINS) {
            ws_log("STUCK waiting on lock %s tid=%lu", l->name ? l->name : "(unnamed)",
                   (unsigned long)tid);
        }
    }
    l->owner = tid;
    l->depth = 1;
}

void ws_lock_leave(WsLock *l)
{
    if (InterlockedDecrement(&l->depth) == 0) {
        l->owner = 0; /* clear owner before publishing `held = 0` */
        InterlockedExchange(&l->held, 0);
    }
}

typedef struct WsTraceSlot {
    volatile LONG active;
    volatile DWORD tid;
    volatile ULONG64 start;
    volatile LONG reported;
    const char *name;
    wchar_t path[WS_TRACE_PATH_CCH];
} WsTraceSlot;

static WsTraceSlot g_trace[WS_TRACE_SLOTS];

/* Find this thread's slot by thread id.
 *
 * ★ 为什么**不用 TLS、也不用守护线程**（Windows VM 实测）：
 *   先前实现用 `TlsAlloc()` 取槽位、并起一个守护线程扫描。实测发现：只要
 *   `TlsAlloc()` 在**被注入进程自身的启动早期**被执行，一个普通的
 *   `node -e "..."` 就会以
 *   `OpenSSL configuration error ... BIO_new_file:No error:c:\ws\deps\openssl\...`
 *   退出（0/10，稳定复现）；把整个卡死子系统改成惰性/初始化时启动都同样触发，
 *   而**完全不碰它**则 10/10 通过。因此这里改为**协作式上报**：不分配 TLS、
 *   不起线程，改由"任意一次钩子进入"顺带扫描并上报超时槽位。
 *   代价：整进程单线程且完全冻死时无人上报；但已观测到的两类挂住
 *   （锁等待、注入等待）本身就在原地直接打 STUCK，不依赖本表。 */
static int ws_trace_find_slot(void)
{
    DWORD tid = GetCurrentThreadId();
    for (int i = 0; i < WS_TRACE_SLOTS; i++) {
        if (g_trace[i].active && g_trace[i].tid == tid) {
            return i;
        }
    }
    return -1;
}

/* Report any slot that has been inside one call longer than the threshold.
 * Called on hook entry; each slot reports once per call (`reported` latch). */
static void ws_stuck_scan(void)
{
    ULONG64 now = GetTickCount64();
    for (int i = 0; i < WS_TRACE_SLOTS; i++) {
        if (!g_trace[i].active) {
            continue;
        }
        ULONG64 start = g_trace[i].start;
        if (start == 0) {
            continue;
        }
        ULONG64 age = now - start;
        if (age >= WS_STUCK_THRESHOLD_MS && !g_trace[i].reported) {
            g_trace[i].reported = 1;
            ws_log("STUCK %llu ms in %s tid=%lu path=%ls",
                   (unsigned long long)age, g_trace[i].name ? g_trace[i].name : "(unknown)",
                   (unsigned long)g_trace[i].tid,
                   g_trace[i].path[0] ? g_trace[i].path : L"(n/a)");
        }
    }
}

void ws_stuck_enter(const char *name)
{
    DWORD tid = GetCurrentThreadId();
    int idx = ws_trace_find_slot();
    if (idx < 0) {
        for (int i = 0; i < WS_TRACE_SLOTS; i++) {
            if (InterlockedCompareExchange(&g_trace[i].active, 1, 0) == 0) {
                g_trace[i].tid = tid;
                idx = i;
                break;
            }
        }
        if (idx < 0) {
            return; /* registry full: this thread is simply untraced */
        }
    }
    g_trace[idx].start = GetTickCount64();
    g_trace[idx].reported = 0;
    g_trace[idx].name = name;
    g_trace[idx].path[0] = 0;
    ws_stuck_scan();
}

void ws_stuck_path(const wchar_t *path)
{
    int idx = ws_trace_find_slot();
    if (idx < 0 || !path) {
        return;
    }
    ws_strlcpy_w(g_trace[idx].path, path, WS_TRACE_PATH_CCH);
}

void ws_stuck_leave(void)
{
    int idx = ws_trace_find_slot();
    if (idx < 0) {
        return;
    }
    InterlockedExchange(&g_trace[idx].active, 0);
}

/* ---------------------------------------------------- structured audit sink */
/* Independent of the verbose text log: an outside program can tail one JSONL
 * file and count exactly which files/registry keys the agent read or modified.
 * Off unless WINSTAGE_AUDIT_LOG points somewhere. Each line is self-contained
 * and carries pid+tid, so lines from several injected children can be merged. */

int ws_audit_escape_w(const wchar_t *in, char *out, size_t cch)
{
    if (!out || cch == 0) {
        return 0;
    }
    out[0] = 0;
    if (!in) {
        return 1;
    }
    char tmp[WS_PATH_MAX * 3];
    int n = WideCharToMultiByte(CP_UTF8, 0, in, -1, tmp, (int)sizeof(tmp), NULL, NULL);
    if (n <= 0) {
        return 0;
    }
    size_t o = 0;
    for (const char *p = tmp; *p && o + 2 < cch; p++) {
        unsigned char c = (unsigned char)*p;
        if (c == '\\' || c == '"') {
            out[o++] = '\\';
            out[o++] = (char)c;
        } else if (c < 0x20) {
            out[o++] = ' ';
        } else {
            out[o++] = (char)c;
        }
    }
    out[o] = 0;
    return 1;
}

void ws_audit(const char *fmt, ...)
{
    const DWORD ws_saved_last_error = GetLastError();
    if (!g_ws.auditPath[0]) {
        SetLastError(ws_saved_last_error);
        return;
    }
    char line[WS_LOG_MAX];
    int n = snprintf(line, sizeof(line), "[winstage-audit][%lu][%lu] ",
                     (unsigned long)GetCurrentProcessId(), (unsigned long)GetCurrentThreadId());
    if (n < 0 || n >= (int)sizeof(line)) {
        SetLastError(ws_saved_last_error);
        return;
    }
    va_list ap;
    va_start(ap, fmt);
    int m = vsnprintf(line + n, sizeof(line) - (size_t)n - 2, fmt, ap);
    va_end(ap);
    if (m > 0) {
        n += m;
    }
    if (n > (int)sizeof(line) - 2) {
        n = (int)sizeof(line) - 2;
    }
    line[n++] = '\n';
    line[n] = 0;
    HANDLE h;
    if (g_orig.CreateFileW) {
        h = g_orig.CreateFileW(g_ws.auditPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                               NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    } else {
        h = CreateFileW(g_ws.auditPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                        NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    }
    if (h != INVALID_HANDLE_VALUE) {
        DWORD wrote = 0;
        WriteFile(h, line, (DWORD)n, &wrote, NULL);
        CloseHandle(h);
    }
    SetLastError(ws_saved_last_error);
}

void ws_audit_path(const char *op, const wchar_t *path, const char *extra)
{
    if (!g_ws.auditPath[0]) {
        return;
    }
    char esc[WS_PATH_MAX * 3];
    ws_audit_escape_w(path, esc, sizeof(esc));
    ws_audit("{\"op\":\"%s\",\"path\":\"%s\"%s}", op, esc, extra ? extra : "");
}

/* --------------------------------------------------------------- strings */

size_t ws_strlcpy_w(wchar_t *dst, const wchar_t *src, size_t cch)
{
    if (!dst || cch == 0) {
        return 0;
    }
    size_t i = 0;
    if (src) {
        for (; i + 1 < cch && src[i]; i++) {
            dst[i] = src[i];
        }
    }
    dst[i] = 0;
    return i;
}

wchar_t *ws_strdup_w(const wchar_t *s)
{
    if (!s) {
        return NULL;
    }
    size_t cch = wcslen(s) + 1;
    wchar_t *p = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, cch * sizeof(wchar_t));
    if (p) {
        memcpy(p, s, cch * sizeof(wchar_t));
    }
    return p;
}

void ws_free(void *p)
{
    if (p) {
        HeapFree(GetProcessHeap(), 0, p);
    }
}

void ws_tolower_w(wchar_t *s)
{
    for (; s && *s; s++) {
        if (*s >= L'A' && *s <= L'Z') {
            *s = (wchar_t)(*s - L'A' + L'a');
        }
    }
}

int ws_wcscmp_ci(const wchar_t *a, const wchar_t *b)
{
    if (a == b) {
        return 0;
    }
    if (!a) {
        return -1;
    }
    if (!b) {
        return 1;
    }
    for (;; a++, b++) {
        wchar_t ca = *a, cb = *b;
        if (ca >= L'A' && ca <= L'Z') ca = (wchar_t)(ca - L'A' + L'a');
        if (cb >= L'A' && cb <= L'Z') cb = (wchar_t)(cb - L'A' + L'a');
        if (ca != cb) {
            return ca < cb ? -1 : 1;
        }
        if (!ca) {
            return 0;
        }
    }
}

int ws_starts_with_ci_w(const wchar_t *s, const wchar_t *prefix)
{
    if (!s || !prefix) {
        return 0;
    }
    while (*prefix) {
        wchar_t a = *s++, b = *prefix++;
        if (a >= L'A' && a <= L'Z') a = (wchar_t)(a - L'A' + L'a');
        if (b >= L'A' && b <= L'Z') b = (wchar_t)(b - L'A' + L'a');
        if (a != b) {
            return 0;
        }
    }
    return 1;
}

int ws_iends_with_ci_w(const wchar_t *s, const wchar_t *suffix)
{
    if (!s || !suffix) {
        return 0;
    }
    size_t ls = wcslen(s), lf = wcslen(suffix);
    if (lf > ls) {
        return 0;
    }
    return ws_wcscmp_ci(s + (ls - lf), suffix) == 0;
}

int ws_append_w(wchar_t *dst, size_t cch, size_t *pos, const wchar_t *src)
{
    if (!dst || !src || !pos || *pos >= cch) {
        return 0;
    }
    for (; *src; src++) {
        if (*pos + 1 >= cch) {
            return 0;
        }
        dst[(*pos)++] = *src;
    }
    dst[*pos] = 0;
    return 1;
}

int ws_appendf_w(wchar_t *dst, size_t cch, size_t *pos, const wchar_t *fmt, ...)
{
    if (!dst || !fmt || !pos || *pos >= cch) {
        return 0;
    }
    va_list ap;
    va_start(ap, fmt);
    int n = _vsnwprintf(dst + *pos, cch - *pos - 1, fmt, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= cch - *pos) {
        dst[cch - 1] = 0;
        return 0;
    }
    *pos += (size_t)n;
    dst[*pos] = 0;
    return 1;
}

/* ------------------------------------------------------------------ JSON
 * Deliberately a *scanner*, not a parser: the shim config is a flat object of
 * strings/bools written by our own tooling. Nested values are ignored, unknown
 * keys are ignored, invalid input leaves the defaults in place. Documented as a
 * limitation in docs/T4-shim?.md. */

static const char *json_find_key(const char *json, const char *key)
{
    size_t klen = strlen(key);
    const char *p = json;
    while ((p = strchr(p, '"')) != NULL) {
        const char *q = p + 1;
        const char *r = q;
        int esc = 0;
        while (*r) {
            if (esc) { esc = 0; r++; continue; }
            if (*r == '\\') { esc = 1; r++; continue; }
            if (*r == '"') break;
            r++;
        }
        if (*r != '"') {
            return NULL;
        }
        size_t len = (size_t)(r - q);
        const char *after = r + 1;
        while (*after == ' ' || *after == '\t' || *after == '\r' || *after == '\n') after++;
        if (len == klen && strncmp(q, key, klen) == 0 && *after == ':') {
            after++;
            while (*after == ' ' || *after == '\t' || *after == '\r' || *after == '\n') after++;
            return after;
        }
        p = r + 1;
    }
    return NULL;
}

int ws_config_get_string(const char *json, const char *key, wchar_t *out, DWORD cch)
{
    if (!json || !key || !out || cch == 0) {
        return 0;
    }
    const char *v = json_find_key(json, key);
    if (!v || *v != '"') {
        return 0;
    }
    char tmp[WS_PATH_MAX * 2];
    size_t n = 0;
    v++;
    while (*v && *v != '"' && n + 1 < sizeof(tmp)) {
        if (*v == '\\' && v[1]) {
            v++;
            switch (*v) {
            case 'n': tmp[n++] = '\n'; break;
            case 't': tmp[n++] = '\t'; break;
            case 'r': tmp[n++] = '\r'; break;
            case '\\': tmp[n++] = '\\'; break;
            case '"': tmp[n++] = '"'; break;
            case '/': tmp[n++] = '/'; break;
            default: tmp[n++] = *v; break;
            }
            v++;
            continue;
        }
        tmp[n++] = *v++;
    }
    tmp[n] = 0;
    /* Config strings may carry a \uXXXX-free UTF-8 path. */
    int w = MultiByteToWideChar(CP_UTF8, 0, tmp, -1, out, (int)cch);
    if (w == 0) {
        w = MultiByteToWideChar(CP_ACP, 0, tmp, -1, out, (int)cch);
    }
    return w != 0;
}

/* Read `"key": ["a","b"]` into a fixed table of 256-byte strings. */
static int ws_config_get_string_array(const char *json, const char *key, char out[][256], int cap, int *count)
{
    *count = 0;
    const char *v = json_find_key(json, key);
    if (!v || *v != '[') {
        return 0;
    }
    v++;
    while (*v && *v != ']' && *count < cap) {
        while (*v == ' ' || *v == ',' || *v == '\n' || *v == '\r' || *v == '\t') v++;
        if (*v != '"') break;
        v++;
        size_t n = 0;
        while (*v && *v != '"' && n + 1 < 256) {
            if (*v == '\\' && v[1]) {
                v++;
                out[*count][n++] = *v;
                v++;
                continue;
            }
            out[*count][n++] = *v++;
        }
        out[*count][n] = 0;
        if (*v == '"') v++;
        if (out[*count][0]) (*count)++;
    }
    return 1;
}

int ws_config_get_bool(const char *json, const char *key, int *out)
{
    if (!json || !key || !out) {
        return 0;
    }
    const char *v = json_find_key(json, key);
    if (!v) {
        return 0;
    }
    if (strncmp(v, "true", 4) == 0) { *out = 1; return 1; }
    if (strncmp(v, "false", 5) == 0) { *out = 0; return 1; }
    if (*v == '1') { *out = 1; return 1; }
    if (*v == '0') { *out = 0; return 1; }
    return 0;
}

void ws_config_defaults(void)
{
    memset(&g_ws, 0, sizeof(g_ws));
#ifdef WINSTAGE_PROFILE_FILE_ONLY
    /* Minimal-profile build (tools/build-shim.mjs --profile=file-only): only the
     * file family is installed, so the carrier gate can be bisected at build time
     * as well as at run time. */
    g_ws.disableRegFamily = 1;
#endif
    g_ws.failClosed = 1;
    g_ws.readThrough = 1;
    g_ws.verbose = 0;
    g_ws.traceStagedOps = 1;
    g_ws.unstagedWrites = 1;

}

static void env_to_w(const wchar_t *name, wchar_t *out, DWORD cch)
{
    out[0] = 0;
    DWORD n = GetEnvironmentVariableW(name, out, cch);
    if (n == 0 || n >= cch) {
        out[0] = 0;
    }
}

void ws_config_from_env(void)
{
    wchar_t buf[WS_PATH_MAX];
    env_to_w(WINSTAGE_ENV_STAGE_ROOT, buf, WS_PATH_MAX);
    if (buf[0]) {
        ws_strlcpy_w(g_ws.stageRoot, buf, WS_PATH_MAX);
        g_ws.haveStageRoot = 1;
    }
    env_to_w(WINSTAGE_ENV_CONFIG, buf, WS_PATH_MAX);
    if (buf[0]) {
        ws_strlcpy_w(g_ws.configPath, buf, WS_PATH_MAX);
    }
    env_to_w(WINSTAGE_ENV_LOG, buf, WS_PATH_MAX);
    if (buf[0]) {
        ws_strlcpy_w(g_ws.logPath, buf, WS_PATH_MAX);
    }
    env_to_w(L"WINSTAGE_AUDIT_LOG", buf, WS_PATH_MAX);
    if (buf[0]) {
        ws_strlcpy_w(g_ws.auditPath, buf, WS_PATH_MAX);
    }
    /* Triage switches (default off). They exist so a single build can bisect
     * which hook family breaks a target, instead of guessing. */
    env_to_w(L"WINSTAGE_READ_DENY_FILE", buf, WS_PATH_MAX);
    if (buf[0]) {
        ws_strlcpy_w(g_ws.readDenyFile, buf, WS_PATH_MAX);
    }
    env_to_w(L"WINSTAGE_SHIM_VERBOSE", buf, WS_PATH_MAX);
    if (buf[0] && !(buf[0] == L'0' && buf[1] == 0)) {
        g_ws.verbose = 1;
        g_ws.traceStagedOps = 1;
    g_ws.unstagedWrites = 1;

    }
    env_to_w(L"WINSTAGE_UNSTAGED_WRITES", buf, WS_PATH_MAX);
    if (buf[0] && ws_wcscmp_ci(buf, L"passthrough") == 0) {
        /* Escape hatch: when a write cannot be staged, call the real API instead
         * of failing. Off by default -- it means real-system writes. */
        g_ws.unstagedWrites = 2;
    }
    env_to_w(L"WINSTAGE_SHIM_DISABLE_FILE", buf, WS_PATH_MAX);
    if (buf[0] && !(buf[0] == L'0' && buf[1] == 0)) {
        g_ws.disableFileFamily = 1;
    }
    env_to_w(L"WINSTAGE_SHIM_DISABLE_REG", buf, WS_PATH_MAX);
    if (buf[0] && !(buf[0] == L'0' && buf[1] == 0)) {
        g_ws.disableRegFamily = 1;
    }
}

void *ws_open_file_raw_flags(const wchar_t *path, DWORD access, DWORD share, DWORD disposition, DWORD flags)
{
    if (g_orig.CreateFileW) {
        return g_orig.CreateFileW(path, access, share, NULL, disposition, flags, NULL);
    }
    return CreateFileW(path, access, share, NULL, disposition, flags, NULL);
}

HANDLE ws_open_file_raw(const wchar_t *path, DWORD access, DWORD share, DWORD disposition)
{
    return (HANDLE)ws_open_file_raw_flags(path, access, share, disposition, FILE_ATTRIBUTE_NORMAL);
}

int ws_read_text_file(const wchar_t *path, char **out, DWORD *outLen)
{
    /* ★ WP13（A3）：`ws_open_file_raw` / `GetFileSizeEx` / `ReadFile` / `CloseHandle` /
     * `HeapAlloc`/`HeapFree` 都会改调用线程的 last error；本函数成败由返回值 +
     * `*out` 表达 ⇒ 入口保存、五条出口还原。 */
    DWORD ws_saved_last_error = GetLastError();
    *out = NULL;
    if (outLen) {
        *outLen = 0;
    }
    HANDLE h = ws_open_file_raw(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, OPEN_EXISTING);
    if (h == INVALID_HANDLE_VALUE) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    LARGE_INTEGER sz;
    if (!GetFileSizeEx(h, &sz) || sz.QuadPart < 0 || sz.QuadPart > (LONGLONG)(64 * 1024 * 1024)) {
        CloseHandle(h);
        SetLastError(ws_saved_last_error);
        return 0;
    }
    DWORD len = (DWORD)sz.QuadPart;
    char *buf = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)len + 1);
    if (!buf) {
        CloseHandle(h);
        SetLastError(ws_saved_last_error);
        return 0;
    }
    DWORD got = 0;
    BOOL ok = ReadFile(h, buf, len, &got, NULL);
    CloseHandle(h);
    if (!ok) {
        HeapFree(GetProcessHeap(), 0, buf);
        SetLastError(ws_saved_last_error);
        return 0;
    }
    buf[got] = 0;
    *out = buf;
    if (outLen) {
        *outLen = got;
    }
    SetLastError(ws_saved_last_error);
    return 1;
}

int ws_write_bytes_to_file(const wchar_t *path, const void *data, DWORD len)
{
    /* ★ WP13（A4）：同 A3，成败由返回值表达 ⇒ 出口还原。 */
    DWORD ws_saved_last_error = GetLastError();
    HANDLE h = ws_open_file_raw(path, GENERIC_WRITE, FILE_SHARE_READ, CREATE_ALWAYS);
    if (h == INVALID_HANDLE_VALUE) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    DWORD wrote = 0;
    BOOL ok = WriteFile(h, data, len, &wrote, NULL);
    CloseHandle(h);
    SetLastError(ws_saved_last_error);
    return ok && wrote == len;
}

int ws_config_load_file(const wchar_t *path)
{
    char *text = NULL;
    if (!ws_read_text_file(path, &text, NULL)) {
        return 0;
    }
    wchar_t wbuf[WS_PATH_MAX];
    int ok = 1;
    if (ws_config_get_string(text, "stageRoot", wbuf, WS_PATH_MAX)) {
        ws_strlcpy_w(g_ws.stageRoot, wbuf, WS_PATH_MAX);
        g_ws.haveStageRoot = 1;
    }
    if (ws_config_get_string(text, "logPath", wbuf, WS_PATH_MAX)) {
        ws_strlcpy_w(g_ws.logPath, wbuf, WS_PATH_MAX);
    }
    ws_config_get_string_array(text, "readDeny", g_ws.readDeny, 32, &g_ws.readDenyCount);
    ws_config_get_string_array(text, "readAllow", g_ws.readAllow, 8, &g_ws.readAllowCount);
    if (ws_config_get_string(text, "readDenyFile", wbuf, WS_PATH_MAX)) {
        ws_strlcpy_w(g_ws.readDenyFile, wbuf, WS_PATH_MAX);
    }
    int rdFail = -1;
    if (ws_config_get_bool(text, "readDenyFailClosed", &rdFail)) {
        g_ws.readDenyFailMode = rdFail ? 0 : 1;
    }
    int b = 0;
    if (ws_config_get_bool(text, "failClosed", &b)) g_ws.failClosed = b;
    if (ws_config_get_bool(text, "readThrough", &b)) g_ws.readThrough = b;
    if (ws_config_get_bool(text, "verbose", &b)) g_ws.verbose = b;
    if (ws_config_get_bool(text, "traceStagedOps", &b)) g_ws.traceStagedOps = b;
    const char *v = json_find_key(text, "passthrough");
    if (v && *v == '[') {
        v++;
        while (*v && *v != ']' && g_ws.passthroughCount < WS_MAX_PASSTHROUGH) {
            while (*v && (*v == ' ' || *v == ',' || *v == '\n' || *v == '\r' || *v == '\t')) v++;
            if (*v != '"') break;
            v++;
            char tmp[WS_PATH_MAX * 2];
            size_t n = 0;
            while (*v && *v != '"' && n + 1 < sizeof(tmp)) {
                if (*v == '\\' && v[1]) { v++; tmp[n++] = (*v == '\\') ? '\\' : *v; v++; continue; }
                tmp[n++] = *v++;
            }
            tmp[n] = 0;
            if (*v == '"') v++;
            MultiByteToWideChar(CP_UTF8, 0, tmp, -1, g_ws.passthrough[g_ws.passthroughCount], WS_PATH_MAX);
            g_ws.passthroughCount++;
        }
    }
    HeapFree(GetProcessHeap(), 0, text);
    return ok;
}

/* ------------------------------------------------------------ path helpers */

int ws_normalize_path(const wchar_t *in, wchar_t *out, DWORD cch)
{
    if (!in || !out || cch < 4) {
        return 0;
    }
    const wchar_t *p = in;
    if (ws_starts_with_ci_w(p, L"\\\\?\\UNC\\")) {
        p += 8;
        out[0] = out[1] = L'\\';
        size_t pos = 2;
        if (!ws_append_w(out, cch, &pos, p)) {
            return 0;
        }
    } else if (ws_starts_with_ci_w(p, L"\\\\?\\")) {
        p += 4;
        ws_strlcpy_w(out, p, cch);
    } else {
        ws_strlcpy_w(out, p, cch);
    }
    /* collapse / -> \ and duplicated separators (after a possible UNC prefix) */
    size_t r = 0, w = 0;
    size_t lead = (out[0] == L'\\' && out[1] == L'\\') ? 2 : 0;
    for (r = 0; out[r]; r++) {
        wchar_t c = out[r];
        if (c == L'/') {
            c = L'\\';
        }
        if (c == L'\\' && r >= lead && w > 0 && out[w - 1] == L'\\' && w > lead) {
            continue;
        }
        out[w++] = c;
    }
    out[w] = 0;
    /* drop a trailing separator unless it is a drive/UNC root */
    while (w > 1 && out[w - 1] == L'\\') {
        int isRoot = (w == 3 && out[1] == L':');
        if (isRoot) break;
        if (lead == 2 && w <= lead) break;
        out[--w] = 0;
    }
    return 1;
}

int ws_ensure_dirs(const wchar_t *path, int asDir)
{
    /* ★ WP13（A1）：`CreateDirectoryW` / `GetFileAttributesW` 都会改**调用线程**的
     * last error，而本函数是**初始化期最热**的一条路径（stage 树创建），
     * 其成败由**返回值**表达 ⇒ 入口保存、每条出口还原，对调用方透明。 */
    DWORD ws_saved_last_error = GetLastError();
    wchar_t tmp[WS_PATH_MAX];
    wchar_t target[WS_PATH_MAX];
    if (!ws_strlcpy_w(tmp, path, WS_PATH_MAX)) {
        SetLastError(ws_saved_last_error);
        return 0;
    }
    size_t n = wcslen(tmp);
    if (!asDir) {
        wchar_t *slash = wcsrchr(tmp, L'\\');
        if (!slash) {
            SetLastError(ws_saved_last_error);
            return 1;
        }
        *slash = 0;
        n = wcslen(tmp);
    }
    ws_strlcpy_w(target, tmp, WS_PATH_MAX);
    for (size_t i = 0; i <= n; i++) {
        if (tmp[i] == L'\\' || tmp[i] == 0) {
            wchar_t save = tmp[i];
            tmp[i] = 0;
            size_t len = wcslen(tmp);
            /* Skip only the bare drive root "C:" (it always exists); every other
             * prefix, including "C:\Users", must be created. */
            if (len >= 2 && !(len == 2 && tmp[1] == L':')) {
                CreateDirectoryW(tmp, NULL);
            }
            tmp[i] = save;
        }
    }
    /* Verify the result instead of trusting CreateDirectoryW: this is what turns
     * "staging tree is broken" into a detectable provider failure (and hence a
     * fail-closed ERROR_ACCESS_DENIED at the hook) instead of a silent partial
     * staging path. */
    DWORD attrs = GetFileAttributesW(target);
    if (attrs == INVALID_FILE_ATTRIBUTES || !(attrs & FILE_ATTRIBUTE_DIRECTORY)) {
        /* 注意顺序：真正的原因（GetLastError）必须在**还原之前**被日志取走 */
        ws_log("ensure_dirs failed: target missing (attrs=0x%lx err=%lu)", (unsigned long)attrs,
               (unsigned long)GetLastError());
        ws_log_w(L"ensure_dirs target", target);
        SetLastError(ws_saved_last_error);
        return 0;
    }
    SetLastError(ws_saved_last_error);
    return 1;
}

/* ------------------------------------------------------------------- hex */

static int hexval_w(wchar_t c)
{
    if (c >= L'0' && c <= L'9') return (int)(c - L'0');
    if (c >= L'a' && c <= L'f') return (int)(c - L'a' + 10);
    if (c >= L'A' && c <= L'F') return (int)(c - L'A' + 10);
    return -1;
}

void ws_hex_encode_w(const wchar_t *s, wchar_t *out, size_t outCch)
{
    static const wchar_t digits[] = L"0123456789abcdef";
    size_t o = 0;
    for (; s && *s; s++) {
        if (o + 5 >= outCch) {
            break;
        }
        unsigned v = (unsigned)(*s) & 0xFFFFu;
        out[o++] = digits[(v >> 12) & 0xF];
        out[o++] = digits[(v >> 8) & 0xF];
        out[o++] = digits[(v >> 4) & 0xF];
        out[o++] = digits[v & 0xF];
    }
    out[o] = 0;
}

int ws_hex_decode_w(const wchar_t *hex, wchar_t *out, size_t outCch)
{
    size_t o = 0;
    if (!hex || !out) {
        return 0;
    }
    for (size_t i = 0; hex[i] && hex[i + 1] && hex[i + 2] && hex[i + 3]; i += 4) {
        int a = hexval_w(hex[i]), b = hexval_w(hex[i + 1]), c = hexval_w(hex[i + 2]), d = hexval_w(hex[i + 3]);
        if (a < 0 || b < 0 || c < 0 || d < 0) {
            break;
        }
        if (o + 1 >= outCch) {
            break;
        }
        out[o++] = (wchar_t)((a << 12) | (b << 8) | (c << 4) | d);
    }
    out[o] = 0;
    return (int)o;
}

void ws_hex_encode_b(const BYTE *b, DWORD len, char *out, size_t outCch)
{
    static const char digits[] = "0123456789abcdef";
    size_t o = 0;
    for (DWORD i = 0; i < len; i++) {
        if (o + 3 >= outCch) {
            break;
        }
        out[o++] = digits[(b[i] >> 4) & 0xF];
        out[o++] = digits[b[i] & 0xF];
    }
    out[o] = 0;
}

int ws_hex_decode_b(const char *hex, BYTE *out, DWORD outCap, DWORD *outLen)
{
    DWORD o = 0;
    if (outLen) {
        *outLen = 0;
    }
    for (size_t i = 0; hex && hex[i] && hex[i + 1]; i += 2) {
        int a, b;
        char ca = hex[i], cb = hex[i + 1];
        a = (ca >= '0' && ca <= '9') ? ca - '0' : (ca >= 'a' && ca <= 'f') ? ca - 'a' + 10 : (ca >= 'A' && ca <= 'F') ? ca - 'A' + 10 : -1;
        b = (cb >= '0' && cb <= '9') ? cb - '0' : (cb >= 'a' && cb <= 'f') ? cb - 'a' + 10 : (cb >= 'A' && cb <= 'F') ? cb - 'A' + 10 : -1;
        if (a < 0 || b < 0) {
            break;
        }
        if (o >= outCap) {
            break;
        }
        out[o++] = (BYTE)((a << 4) | b);
    }
    if (outLen) {
        *outLen = o;
    }
    return 1;
}

/* -------------------------------------------------- registry helper state */

void ws_reg_set_current_user_sid(const wchar_t *sid)
{
    ws_strlcpy_w(g_userSid, sid ? sid : L"", sizeof(g_userSid) / sizeof(wchar_t));
}

const wchar_t *ws_current_user_sid(void)
{
    return g_userSid;
}

int ws_hive_prefix_of(HKEY hive, wchar_t *out, DWORD cch)
{
    out[0] = 0;
    /* Short canonical names, matching T3's HIVE_CANONICAL / SHORT_BY_LONG
     * (src/registry-guard.mjs). Long and short spellings must normalize to the
     * same string, otherwise one registry location would compare unequal to
     * itself and every snapshot comparison would report a difference. */
    struct { HKEY h; const wchar_t *name; } table[] = {
        { HKEY_CURRENT_USER,   L"HKCU" },
        { HKEY_LOCAL_MACHINE,  L"HKLM" },
        { HKEY_CLASSES_ROOT,   L"HKCR" },
        { HKEY_USERS,          L"HKU" },
        { HKEY_CURRENT_CONFIG, L"HKCC" },
        { HKEY_PERFORMANCE_DATA, L"HKPD" },
    };
    for (size_t i = 0; i < sizeof(table) / sizeof(table[0]); i++) {
        if (hive == table[i].h) {
            ws_strlcpy_w(out, table[i].name, cch);
            return 1;
        }
    }
    return 0;
}

/* Map (hive handle, subkey) to canonical (hiveName, subkey). */
int ws_key_path_of_handle(HKEY hive, LPCWSTR subkey, wchar_t *hiveOut, DWORD hiveCch, wchar_t *subkeyOut, DWORD subkeyCch)
{
    if (!ws_hive_prefix_of(hive, hiveOut, hiveCch)) {
        return 0;
    }
    wchar_t norm[WS_PATH_MAX];
    if (subkey && subkey[0]) {
        if (!ws_normalize_key_path(subkey, norm, WS_PATH_MAX)) {
            return 0;
        }
        ws_strlcpy_w(subkeyOut, norm, subkeyCch);
    } else {
        subkeyOut[0] = 0;
    }
    return 1;
}

/* Normalize a registry subkey: registry "paths" use backslashes; we additionally
 * accept forward slashes for convenience and strip leading separators. */
int ws_normalize_key_path(const wchar_t *in, wchar_t *out, DWORD cch)
{
    if (!in || !out || cch < 2) {
        return 0;
    }
    while (*in == L'\\' || *in == L'/') {
        in++;
    }
    size_t w = 0;
    for (; *in; in++) {
        wchar_t c = (*in == L'/') ? L'\\' : *in;
        if (c == L'\\' && w > 0 && out[w - 1] == L'\\') {
            continue;
        }
        if (w + 1 >= cch) {
            return 0;
        }
        out[w++] = c;
    }
    while (w > 0 && out[w - 1] == L'\\') {
        w--;
    }
    out[w] = 0;
    return 1;
}

/* Map a real, already-open key handle to (short hive name, full canonical path).
 * The canonical path INCLUDES the hive name, exactly like the predefined-root
 * branch of ws_rstore_canonical builds it -- mixing "HKEY_CURRENT_USER" with
 * "HKCU" produced two different strings for one location, which made overlay
 * lookups miss and produced bogus "unresolvable" hard denials. */
int ws_handle_reg_path(HKEY key, wchar_t *hiveOut, DWORD hiveCch, wchar_t *canonicalOut, DWORD canonicalCch)
{
    hiveOut[0] = canonicalOut[0] = 0;
    if (!g_NtQueryKey || !key) {
        return 0;
    }
    BYTE buf[2048];
    ULONG len = 0;
    /* KeyNameInformation == 3; returns KEY_NAME_INFORMATION { ULONG NameLength; WCHAR Name[]; } */
    NTSTATUS st = g_NtQueryKey((HANDLE)key, 3, buf, sizeof(buf), &len);
    if (st < 0) {
        return 0;
    }
    ULONG nameLen = *(ULONG *)buf;
    const wchar_t *name = (const wchar_t *)(buf + sizeof(ULONG));
    size_t chars = nameLen / sizeof(wchar_t);
    if (chars == 0 || chars >= 1024) {
        return 0;
    }
    wchar_t full[1024];
    memcpy(full, name, chars * sizeof(wchar_t));
    full[chars] = 0;

    /* Full form: \REGISTRY\MACHINE\...  or  \REGISTRY\USER\<sid>\... */
    const wchar_t *rest = NULL;
    const wchar_t *hiveShort = NULL;
    if (ws_starts_with_ci_w(full, L"\\REGISTRY\\MACHINE")) {
        hiveShort = L"HKLM";
        rest = full + 17;
    } else if (ws_starts_with_ci_w(full, L"\\REGISTRY\\USER\\")) {
        rest = full + 15;
        const wchar_t *sid = ws_current_user_sid();
        size_t sidLen = sid ? wcslen(sid) : 0;
        if (sidLen && ws_starts_with_ci_w(rest, sid) && (rest[sidLen] == 0 || rest[sidLen] == L'\\')) {
            hiveShort = L"HKCU";
            rest += sidLen;
        } else {
            hiveShort = L"HKU"; /* includes .DEFAULT */
        }
    } else {
        return 0;
    }
    while (rest && (*rest == L'\\' || *rest == L'/')) {
        rest++;
    }
    wchar_t rel[WS_PATH_MAX];
    if (!ws_normalize_key_path(rest ? rest : L"", rel, WS_PATH_MAX)) {
        return 0;
    }
    size_t pos = 0;
    canonicalOut[0] = 0;
    if (!ws_append_w(canonicalOut, canonicalCch, &pos, hiveShort)) {
        return 0;
    }
    if (rel[0]) {
        if (!ws_append_w(canonicalOut, canonicalCch, &pos, L"\\") ||
            !ws_append_w(canonicalOut, canonicalCch, &pos, rel)) {
            return 0;
        }
    }
    ws_strlcpy_w(hiveOut, hiveShort, hiveCch);
    return 1;
}