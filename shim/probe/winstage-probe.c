/* WinStageSandbox -- T4 shim: probe program.
 *
 * Two jobs:
 *  1. `selftest <dll> <out.json>` -- load the shim into *this short-lived*
 *     process and report ABI + stats. This is the "real availability" probe T1
 *     should use (never LoadLibrary the shim into a long-lived host process).
 *  2. exercise the virtualized APIs and write a JSON result, so the closed-loop
 *     evidence does not depend on stdout parsing:
 *       file-write <path> <content> <out.json>
 *       file-read  <path> <out.json>
 *       file-delete <path> <out.json>
 *       dir-create <path> <out.json>
 *       dir-remove <path> <out.json>
 *       move       <src> <dst> <out.json>
 *       reg-write  <hive> <subkey> <name> <data> <out.json>
 *       reg-read   <hive> <subkey> <name> <out.json>
 *       reg-delete-value <hive> <subkey> <name> <out.json>
 *       reg-delete-key   <hive> <subkey> <out.json>
 *
 * The result file must live OUTSIDE the virtualized namespace or the shim
 * would stage it too; the T4 harness always points it at
 * <stageRoot>\evidence\... (the staging root is a passthrough prefix).
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* --- tiny UTF-8 JSON writer -------------------------------------------- */
static char g_json[16384];
static size_t g_jsonLen;

static void jreset(void)
{
    g_jsonLen = 0;
    g_json[0] = 0;
}

static void jraw(const char *s)
{
    size_t n = strlen(s);
    if (g_jsonLen + n + 1 >= sizeof(g_json)) {
        return;
    }
    memcpy(g_json + g_jsonLen, s, n);
    g_jsonLen += n;
    g_json[g_jsonLen] = 0;
}

static void jw(const wchar_t *s)
{
    char buf[8192];
    buf[0] = 0;
    if (s) {
        WideCharToMultiByte(CP_UTF8, 0, s, -1, buf, sizeof(buf), NULL, NULL);
    }
    for (size_t i = 0; buf[i]; i++) {
        char tmp[8];
        if (buf[i] == '\\' || buf[i] == '"') {
            tmp[0] = '\\';
            tmp[1] = buf[i];
            tmp[2] = 0;
        } else if ((unsigned char)buf[i] < 0x20) {
            sprintf(tmp, "\\u%04x", (unsigned char)buf[i]);
        } else {
            tmp[0] = buf[i];
            tmp[1] = 0;
        }
        jraw(tmp);
    }
}

static void jkey(const char *k)
{
    jraw("\"");
    jraw(k);
    jraw("\":");
}

static void jstr_value(const wchar_t *v)
{
    jraw("\"");
    jw(v);
    jraw("\"");
}

static void jstr(const char *k, const wchar_t *v)
{
    jkey(k);
    jstr_value(v);
    jraw(",");
}

static void jnum(const char *k, long long v)
{
    char tmp[64];
    sprintf(tmp, "%lld", v);
    jkey(k);
    jraw(tmp);
    jraw(",");
}

static void jbool(const char *k, int v)
{
    jkey(k);
    jraw(v ? "true" : "false");
    jraw(",");
}

static void jfinish(void)
{
    size_t n = g_jsonLen;
    while (n > 0 && g_json[n - 1] == ',') {
        n--;
    }
    g_json[n] = 0;
    g_jsonLen = n;
    jraw("}\n");
}

static int write_out(const wchar_t *path, const char *extraPrefix)
{
    HANDLE h = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        return 0;
    }
    DWORD wrote = 0;
    if (extraPrefix) {
        WriteFile(h, extraPrefix, (DWORD)strlen(extraPrefix), &wrote, NULL);
    }
    WriteFile(h, g_json, (DWORD)g_jsonLen, &wrote, NULL);
    CloseHandle(h);
    return 1;
}

/* --- helpers ------------------------------------------------------------ */

static HKEY hive_from_name(const wchar_t *name)
{
    if (!_wcsicmp(name, L"HKCU") || !_wcsicmp(name, L"HKEY_CURRENT_USER")) return HKEY_CURRENT_USER;
    if (!_wcsicmp(name, L"HKLM") || !_wcsicmp(name, L"HKEY_LOCAL_MACHINE")) return HKEY_LOCAL_MACHINE;
    if (!_wcsicmp(name, L"HKCR") || !_wcsicmp(name, L"HKEY_CLASSES_ROOT")) return HKEY_CLASSES_ROOT;
    if (!_wcsicmp(name, L"HKU") || !_wcsicmp(name, L"HKEY_USERS")) return HKEY_USERS;
    if (!_wcsicmp(name, L"HKCC") || !_wcsicmp(name, L"HKEY_CURRENT_CONFIG")) return HKEY_CURRENT_CONFIG;
    return NULL;
}

static void wide_from_utf8ish(const char *in, wchar_t *out, DWORD cch)
{
    MultiByteToWideChar(CP_UTF8, 0, in, -1, out, (int)cch);
}

typedef struct {
    int (*fn)(int argc, wchar_t **argv);
} Mode;

static int mode_appkey(int argc, wchar_t **argv);
static int mode_maskcheck(int argc, wchar_t **argv);
static int mode_check_path(int argc, wchar_t **argv);
static int mode_selftest(int argc, wchar_t **argv);
static int mode_file_write(int argc, wchar_t **argv);
static int mode_file_read(int argc, wchar_t **argv);
static int mode_file_delete(int argc, wchar_t **argv);
static int mode_dir_create(int argc, wchar_t **argv);
static int mode_dir_remove(int argc, wchar_t **argv);
static int mode_move(int argc, wchar_t **argv);
static int mode_reg_write(int argc, wchar_t **argv);
static int mode_reg_read(int argc, wchar_t **argv);
static int mode_reg_delete_value(int argc, wchar_t **argv);
static int mode_reg_delete_key(int argc, wchar_t **argv);

typedef int (*ModeFn)(int argc, wchar_t **argv);

typedef struct {
    const wchar_t *name;
    ModeFn fn;
    int minArgs; /* including out.json as the last argument */
} ModeEntry;

static const ModeEntry g_modes[] = {
    { L"selftest", mode_selftest, 2 },
    { L"appkey", mode_appkey, 2 },
    { L"maskcheck", mode_maskcheck, 3 },
    { L"check-path", mode_check_path, 4 },
    { L"file-write", mode_file_write, 3 },
    { L"file-read", mode_file_read, 2 },
    { L"file-delete", mode_file_delete, 2 },
    { L"dir-create", mode_dir_create, 2 },
    { L"dir-remove", mode_dir_remove, 2 },
    { L"move", mode_move, 3 },
    { L"reg-write", mode_reg_write, 5 },
    { L"reg-read", mode_reg_read, 4 },
    { L"reg-delete-value", mode_reg_delete_value, 4 },
    { L"reg-delete-key", mode_reg_delete_key, 3 },
};

int wmain(int argc, wchar_t **argv)
{
    if (argc < 3) {
        fputs("usage: winstage-probe.exe <mode> ... <out.json>\n", stderr);
        return 2;
    }
    const wchar_t *mode = argv[1];
    for (size_t i = 0; i < sizeof(g_modes) / sizeof(g_modes[0]); i++) {
        if (_wcsicmp(g_modes[i].name, mode) == 0) {
            if (argc - 2 < g_modes[i].minArgs) {
                fputs("winstage-probe: not enough arguments for mode\n", stderr);
                return 2;
            }
            return g_modes[i].fn(argc - 2, argv + 2);
        }
    }
    fputs("winstage-probe: unknown mode\n", stderr);
    return 2;
}

/* mode args: <dll> <out.json> */
static int mode_selftest(int argc, wchar_t **argv)
{
    (void)argc;
    const wchar_t *dll = argv[0];
    const wchar_t *out = argv[1];
    jreset();
    jraw("{");
    jstr("mode", L"selftest");
    jstr("dll", dll);
    HMODULE h = LoadLibraryW(dll);
    jbool("loaded", h != NULL);
    jnum("loadError", h ? 0 : (long long)GetLastError());
    if (h) {
        typedef unsigned(__cdecl * AbiFn)(void);
        typedef int(__cdecl * StatsFn)(char *, unsigned);
        typedef int(__cdecl * InitFn)(const wchar_t *);
        AbiFn abi = (AbiFn)(void *)GetProcAddress(h, "WinstageShimAbiVersion");
        StatsFn stats = (StatsFn)(void *)GetProcAddress(h, "WinstageShimStatsJson");
        InitFn init = (InitFn)(void *)GetProcAddress(h, "WinstageShimInit");
        jbool("hasAbiExport", abi != NULL);
        jbool("hasStatsExport", stats != NULL);
        jbool("hasInitExport", init != NULL);
        jnum("abiVersion", abi ? (long long)abi() : -1);
        int initRc = init ? init(NULL) : -1;
        jnum("initReturn", initRc);
        char statsBuf[4096];
        statsBuf[0] = 0;
        if (stats) {
            stats(statsBuf, sizeof(statsBuf));
        }
        jkey("statsRaw");
        jraw("\"");
        for (size_t i = 0; statsBuf[i]; i++) {
            char tmp[8];
            if (statsBuf[i] == '"' || statsBuf[i] == '\\') {
                tmp[0] = '\\';
                tmp[1] = statsBuf[i];
                tmp[2] = 0;
            } else {
                tmp[0] = statsBuf[i];
                tmp[1] = 0;
            }
            jraw(tmp);
        }
        jraw("\"");
        jraw(",");
    }
    jfinish();
    return write_out(out, NULL) ? 0 : 3;
}

/* mode args: <path> <content> <out.json> */
static int mode_file_write(int argc, wchar_t **argv)
{
    (void)argc;
    const wchar_t *path = argv[0];
    wchar_t contentW[4096];
    wide_from_utf8ish((const char *)"", contentW, 1);
    /* content is passed as UTF-16 already (argv is wide); argv[1] is the text */
    const wchar_t *content = argv[1];
    const wchar_t *out = argv[2];

    char contentU8[4096];
    contentU8[0] = 0;
    WideCharToMultiByte(CP_UTF8, 0, content, -1, contentU8, sizeof(contentU8), NULL, NULL);

    jreset();
    jraw("{");
    jstr("mode", L"file-write");
    jstr("path", path);
    SetLastError(0);
    HANDLE h = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    DWORD openErr = GetLastError();
    int okOpen = h != INVALID_HANDLE_VALUE;
    DWORD wroteBytes = 0;
    int okWrite = 0;
    if (okOpen) {
        SetLastError(0);
        okWrite = WriteFile(h, contentU8, (DWORD)strlen(contentU8), &wroteBytes, NULL) ? 1 : 0;
        CloseHandle(h);
    }
    jbool("createOk", okOpen);
    jnum("createError", openErr);
    jbool("writeOk", okWrite);
    jnum("bytesWritten", wroteBytes);
    jbool("apiReturnedSuccess", okOpen && okWrite);
    jfinish();
    return write_out(out, NULL) ? 0 : 3;
}

/* mode args: <path> <out.json> */
static int mode_file_read(int argc, wchar_t **argv)
{
    (void)argc;
    const wchar_t *path = argv[0];
    const wchar_t *out = argv[1];
    jreset();
    jraw("{");
    jstr("mode", L"file-read");
    jstr("path", path);
    SetLastError(0);
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    DWORD err = GetLastError();
    jbool("openOk", h != INVALID_HANDLE_VALUE);
    jnum("openError", err);
    if (h != INVALID_HANDLE_VALUE) {
        char buf[4096];
        DWORD got = 0;
        if (ReadFile(h, buf, sizeof(buf) - 1, &got, NULL)) {
            buf[got] = 0;
            wchar_t wide[4096];
            MultiByteToWideChar(CP_UTF8, 0, buf, -1, wide, 4096);
            jstr("content", wide);
            jnum("bytesRead", got);
        }
        CloseHandle(h);
    }
    jfinish();
    return write_out(out, NULL) ? 0 : 3;
}

/* mode args: <path> <out.json> */
static int mode_file_delete(int argc, wchar_t **argv)
{
    (void)argc;
    const wchar_t *path = argv[0];
    const wchar_t *out = argv[1];
    jreset();
    jraw("{");
    jstr("mode", L"file-delete");
    jstr("path", path);
    SetLastError(0);
    BOOL ok = DeleteFileW(path);
    jbool("deleteOk", ok != 0);
    jnum("deleteError", ok ? 0 : (long long)GetLastError());
    jfinish();
    return write_out(out, NULL) ? 0 : 3;
}

/* mode args: <path> <out.json> */
static int mode_dir_create(int argc, wchar_t **argv)
{
    (void)argc;
    const wchar_t *path = argv[0];
    const wchar_t *out = argv[1];
    jreset();
    jraw("{");
    jstr("mode", L"dir-create");
    jstr("path", path);
    SetLastError(0);
    BOOL ok = CreateDirectoryW(path, NULL);
    jbool("createOk", ok != 0);
    jnum("createError", ok ? 0 : (long long)GetLastError());
    jfinish();
    return write_out(out, NULL) ? 0 : 3;
}

/* mode args: <path> <out.json> */
static int mode_dir_remove(int argc, wchar_t **argv)
{
    (void)argc;
    const wchar_t *path = argv[0];
    const wchar_t *out = argv[1];
    jreset();
    jraw("{");
    jstr("mode", L"dir-remove");
    jstr("path", path);
    SetLastError(0);
    BOOL ok = RemoveDirectoryW(path);
    jbool("removeOk", ok != 0);
    jnum("removeError", ok ? 0 : (long long)GetLastError());
    jfinish();
    return write_out(out, NULL) ? 0 : 3;
}

/* mode args: <src> <dst> <out.json> */
static int mode_move(int argc, wchar_t **argv)
{
    (void)argc;
    const wchar_t *src = argv[0];
    const wchar_t *dst = argv[1];
    const wchar_t *out = argv[2];
    jreset();
    jraw("{");
    jstr("mode", L"move");
    jstr("src", src);
    jstr("dst", dst);
    SetLastError(0);
    BOOL ok = MoveFileExW(src, dst, MOVEFILE_REPLACE_EXISTING | MOVEFILE_COPY_ALLOWED);
    jbool("moveOk", ok != 0);
    jnum("moveError", ok ? 0 : (long long)GetLastError());
    jfinish();
    return write_out(out, NULL) ? 0 : 3;
}

/* mode args: <hive> <subkey> <name> <data> <out.json> */
static int mode_reg_write(int argc, wchar_t **argv)
{
    (void)argc;
    HKEY hive = hive_from_name(argv[0]);
    const wchar_t *subkey = argv[1];
    const wchar_t *name = argv[2];
    const wchar_t *data = argv[3];
    const wchar_t *out = argv[4];
    DWORD dataBytes = (DWORD)((wcslen(data) + 1) * sizeof(wchar_t));
    jreset();
    jraw("{");
    jstr("mode", L"reg-write");
    jstr("hive", argv[0]);
    jstr("subkey", subkey);
    jstr("valueName", name);
    jstr("data", data);
    if (!hive) {
        jbool("ok", 0);
        jstr("error", L"bad hive name");
        jfinish();
        return write_out(out, NULL) ? 0 : 3;
    }
    HKEY key = NULL;
    DWORD disp = 0;
    SetLastError(0);
    LONG rc = RegCreateKeyExW(hive, subkey, 0, NULL, 0, KEY_ALL_ACCESS, NULL, &key, &disp);
    jnum("createRc", rc);
    jbool("createOk", rc == ERROR_SUCCESS);
    jnum("disposition", disp);
    LONG rcSet = 12345;
    if (rc == ERROR_SUCCESS) {
        SetLastError(0);
        rcSet = RegSetValueExW(key, name, 0, REG_SZ, (const BYTE *)data, dataBytes);
        RegCloseKey(key);
    }
    jnum("setRc", rcSet);
    jbool("setOk", rcSet == ERROR_SUCCESS);
    /* Explicitly: "every API call in this sequence returned success". It is
     * impossible for this to be true when any rc != 0 -- do not use it as a
     * proxy for "the write was staged"; check the rc fields. */
    jbool("allCallsSucceeded", rc == ERROR_SUCCESS && rcSet == ERROR_SUCCESS);
    jfinish();
    return write_out(out, NULL) ? 0 : 3;
}

/* mode args: <hive> <subkey> <name> <out.json> */
static int mode_reg_read(int argc, wchar_t **argv)
{
    (void)argc;
    HKEY hive = hive_from_name(argv[0]);
    const wchar_t *subkey = argv[1];
    const wchar_t *name = argv[2];
    const wchar_t *out = argv[3];
    jreset();
    jraw("{");
    jstr("mode", L"reg-read");
    jstr("subkey", subkey);
    jstr("valueName", name);
    HKEY key = NULL;
    LONG rc = hive ? RegOpenKeyExW(hive, subkey, 0, KEY_READ, &key) : 12345;
    jnum("openRc", rc);
    jbool("openOk", rc == ERROR_SUCCESS);
    LONG rcQ = 12345;
    if (rc == ERROR_SUCCESS) {
        wchar_t buf[4096];
        DWORD cb = sizeof(buf);
        DWORD type = 0;
        rcQ = RegQueryValueExW(key, name, NULL, &type, (LPBYTE)buf, &cb);
        jnum("queryRc", rcQ);
        jbool("queryOk", rcQ == ERROR_SUCCESS);
        jnum("type", type);
        if (rcQ == ERROR_SUCCESS && type == REG_SZ) {
            jstr("data", buf);
        } else if (rcQ == ERROR_SUCCESS) {
            jnum("bytes", cb);
        }
        RegCloseKey(key);
    } else {
        jnum("queryRc", -1);
        jbool("queryOk", 0);
    }
    /* "both calls succeeded" -- deliberately false whenever queryRc != 0, so a
     * caller cannot mistake an empty/missing overlay value for evidence. */
    jbool("allCallsSucceeded", rc == ERROR_SUCCESS && rcQ == ERROR_SUCCESS);
    jfinish();
    return write_out(out, NULL) ? 0 : 3;
}

/* mode args: <hive> <subkey> <name> <out.json> */
static int mode_reg_delete_value(int argc, wchar_t **argv)
{
    (void)argc;
    HKEY hive = hive_from_name(argv[0]);
    const wchar_t *subkey = argv[1];
    const wchar_t *name = argv[2];
    const wchar_t *out = argv[3];
    jreset();
    jraw("{");
    jstr("mode", L"reg-delete-value");
    jstr("subkey", subkey);
    HKEY key = NULL;
    LONG rc = hive ? RegOpenKeyExW(hive, subkey, 0, KEY_ALL_ACCESS, &key) : 12345;
    jnum("openRc", rc);
    LONG rcD = 12345;
    if (rc == ERROR_SUCCESS) {
        rcD = RegDeleteValueW(key, name);
        RegCloseKey(key);
    }
    jnum("deleteRc", rcD);
    jbool("deleteOk", rcD == ERROR_SUCCESS);
    jfinish();
    return write_out(out, NULL) ? 0 : 3;
}

/* mode args: <hive> <subkey> <out.json> */
static int mode_reg_delete_key(int argc, wchar_t **argv)
{
    (void)argc;
    HKEY hive = hive_from_name(argv[0]);
    const wchar_t *subkey = argv[1];
    const wchar_t *out = argv[2];
    jreset();
    jraw("{");
    jstr("mode", L"reg-delete-key");
    jstr("subkey", subkey);
    LONG rc = hive ? RegDeleteKeyExW(hive, subkey, KEY_WOW64_64KEY, 0) : 12345;
    jnum("deleteRc", rc);
    jbool("deleteOk", rc == ERROR_SUCCESS);
    jfinish();
    return write_out(out, NULL) ? 0 : 3;
}

/* mode args: <dir> <out.json>
 * Standalone (run WITHOUT the shim): learn how RegLoadAppKeyW + RegCreateKeyExW
 * behave on this machine, so the shim's app-hive assumptions are measured rather
 * than assumed. Reports the LSTATUS of each step. */
WINADVAPI LSTATUS WINAPI RegLoadAppKeyW(LPCWSTR, PHKEY, REGSAM, DWORD, DWORD);

static int mode_appkey(int argc, wchar_t **argv)
{
    (void)argc;
    const wchar_t *dir = argv[0];
    const wchar_t *out = argv[1];
    wchar_t hive[2048];
    _snwprintf(hive, 2048, L"%ls\\probe.hive", dir);
    hive[2047] = 0;
    CreateDirectoryW(dir, NULL);
    jreset();
    jraw("{");
    jstr("mode", L"appkey");
    jstr("hive", hive);


    HKEY root = NULL;
    LSTATUS rc = RegLoadAppKeyW(hive, &root, KEY_ALL_ACCESS, 1 /*REG_PROCESS_APPKEY*/, 0);
    jnum("loadAllAccessRc", rc);
    if (rc != ERROR_SUCCESS) {
        root = NULL;
        rc = RegLoadAppKeyW(hive, &root, KEY_READ | KEY_WRITE, 1, 0);
        jnum("loadReadWriteRc", rc);
    }
    if (root) {
        HKEY h = NULL;
        DWORD disp = 0;
        LSTATUS c1 = RegCreateKeyExW(root, L"A", 0, NULL, 0, KEY_ALL_ACCESS, NULL, &h, &disp);
        jnum("createAllAccessRc", c1);
        if (h) { RegCloseKey(h); h = NULL; }
        LSTATUS c2 = RegCreateKeyExW(root, L"B", 0, NULL, 0, KEY_READ | KEY_WRITE, NULL, &h, &disp);
        jnum("createReadWriteRc", c2);
        if (h) {
            static const wchar_t v[] = L"v";
            LSTATUS s = RegSetValueExW(h, L"V", 0, REG_SZ, (const BYTE *)v, (DWORD)sizeof(v));
            jnum("setValueRc", s);
            RegCloseKey(h);
        }
        HKEY h2 = NULL;
        LSTATUS c3 = RegCreateKeyExW(root, L"A\\X", 0, NULL, 0, KEY_READ | KEY_WRITE, NULL, &h2, &disp);
        jnum("createNestedRc", c3);
        if (h2) RegCloseKey(h2);
        RegCloseKey(root);
    }
    jbool("ok", root != NULL);
    jfinish();
    return write_out(out, NULL) ? 0 : 3;
}
/* mode args: <dll> <mask.json> <out.json>
 * Offline read-mask regression: loads the shim DLL and asks it to evaluate every
 * `probes[]` entry from T2's export (expected maskClass must be reproduced). */
static int mode_maskcheck(int argc, wchar_t **argv)
{
    (void)argc;
    const wchar_t *dll = argv[0];
    const wchar_t *maskFile = argv[1];
    const wchar_t *out = argv[2];
    jreset();
    jraw("{");
    jstr("mode", L"maskcheck");
    jstr("maskFile", maskFile);
    HMODULE h = LoadLibraryW(dll);
    jbool("loaded", h != NULL);
    if (!h) {
        jnum("loadError", (long long)GetLastError());
        jfinish();
        return write_out(out, NULL) ? 0 : 3;
    }
    typedef int(__cdecl * MaskCheckFn)(const wchar_t *, const wchar_t *);
    typedef int(__cdecl * RuleCountFn)(void);
    MaskCheckFn fn = (MaskCheckFn)(void *)GetProcAddress(h, "WinstageShimMaskCheck");
    RuleCountFn ruleCount = (RuleCountFn)(void *)GetProcAddress(h, "WinstageShimMaskRuleCount");
    jbool("hasMaskCheck", fn != NULL);
    if (!fn) {
        jfinish();
        return write_out(out, NULL) ? 0 : 3;
    }
    /* the export writes the detailed per-probe JSON to a side file */
    wchar_t detail[2048];
    _snwprintf(detail, 2048, L"%ls.detail.json", out);
    detail[2047] = 0;
    int rc = fn(maskFile, detail);
    jnum("returnCode", rc);
    jbool("allProbesAgree", rc == 1);
    jnum("ruleCount", ruleCount ? ruleCount() : -1);
    jfinish();
    return write_out(out, NULL) ? 0 : 3;
}

/* mode args: <dll> <mask.json> <path> <out.json> */
static int mode_check_path(int argc, wchar_t **argv)
{
    (void)argc;
    const wchar_t *dll = argv[0];
    const wchar_t *maskFile = argv[1];
    const wchar_t *path = argv[2];
    const wchar_t *out = argv[3];
    jreset();
    jraw("{");
    jstr("mode", L"check-path");
    jstr("path", path);
    HMODULE h = LoadLibraryW(dll);
    jbool("loaded", h != NULL);
    int deny = -1;
    char detail[8192];
    detail[0] = 0;
    if (h) {
        typedef int(__cdecl * CheckFn)(const wchar_t *, const wchar_t *, char *, unsigned);
        CheckFn fn = (CheckFn)(void *)GetProcAddress(h, "WinstageShimCheckPath");
        jbool("hasCheckPath", fn != NULL);
        if (fn) {
            deny = fn(maskFile, path, detail, (unsigned)sizeof(detail));
            jnum("returnCode", deny);
        }
    }
    jbool("deny", deny == 1);
    jkey("detail");
    jraw("\"");
    for (size_t i = 0; detail[i]; i++) {
        char tmp[8];
        unsigned char ch = (unsigned char)detail[i];
        if (ch == '"' || ch == '\\') {
            tmp[0] = '\\';
            tmp[1] = (char)ch;
            tmp[2] = 0;
        } else if (ch < 0x20) {
            /* a raw control character (the DLL detail ends with a newline) makes
             * the whole probe output invalid JSON -- escape it */
            static const char *esc[0x20] = { NULL };
            switch (ch) {
            case '\n': snprintf(tmp, sizeof(tmp), "\\n"); break;
            case '\r': snprintf(tmp, sizeof(tmp), "\\r"); break;
            case '\t': snprintf(tmp, sizeof(tmp), "\\t"); break;
            default: snprintf(tmp, sizeof(tmp), "\\u%04x", ch); break;
            }
            (void)esc;
        } else {
            tmp[0] = (char)ch;
            tmp[1] = 0;
        }
        jraw(tmp);
    }
    jraw("\"");
    jraw(",");
    jfinish();
    return write_out(out, NULL) ? 0 : 3;
}