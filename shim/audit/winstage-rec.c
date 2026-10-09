/* winstage-rec.c - Method 1: a command-level recorder (NO injection, NO API hooks).
 *
 * It runs a command with cwd = a mirror root, snapshots the root before/after,
 * and emits a JSONL "record" of what the command and its children changed
 * (created / modified / deleted). This is the "convert the file operations into
 * shell commands and record by before/after comparison" approach.
 *
 * Build: zig cc -target x86_64-windows-gnu -O2 -municode -o winstage-rec.exe winstage-rec.c
 * Usage: winstage-rec.exe --root <dir> --audit <file.jsonl> -- <cmd> [args...]
 *
 * Honest limitation (by construction): a before/after snapshot can see *effects*
 * (writes/deletes) but CANNOT see reads, and only sees what happens inside
 * <root>. Anything a child writes outside <root> is invisible.
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#define WS_MAXPATH 4096

typedef struct {
    WCHAR rel[WS_MAXPATH];
    unsigned long long size;
    FILETIME mtime;
    unsigned int hash;
} Entry;

typedef struct {
    Entry *items;
    size_t count;
    size_t cap;
} Entries;

static void entries_push(Entries *a, const Entry *e)
{
    if (a->count == a->cap) {
        a->cap = a->cap ? a->cap * 2 : 128;
        a->items = (Entry *)realloc(a->items, a->cap * sizeof(Entry));
    }
    a->items[a->count++] = *e;
}

static unsigned int hash_file(const WCHAR *full)
{
    HANDLE h = CreateFileW(full, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    unsigned int hsh = 2166136261u;
    char buf[65536];
    DWORD got = 0;
    while (ReadFile(h, buf, sizeof(buf), &got, NULL) && got > 0) {
        for (DWORD i = 0; i < got; i++) { hsh ^= (unsigned char)buf[i]; hsh *= 16777619u; }
    }
    CloseHandle(h);
    return hsh;
}

static void walk(const WCHAR *dir, const WCHAR *base, Entries *out)
{
    WCHAR pattern[WS_MAXPATH];
    _snwprintf(pattern, WS_MAXPATH, L"%ls\\*", dir);
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(pattern, &fd);
    if (h == INVALID_HANDLE_VALUE) return;
    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        WCHAR full[WS_MAXPATH];
        _snwprintf(full, WS_MAXPATH, L"%ls\\%ls", dir, fd.cFileName);
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            walk(full, base, out);
        } else {
            Entry e;
            ZeroMemory(&e, sizeof(e));
            size_t bl = wcslen(base);
            const WCHAR *rel = full + (bl < wcslen(full) ? bl : 0);
            if (*rel == L'\\') rel++;
            wcsncpy(e.rel, rel, WS_MAXPATH - 1);
            e.size = ((unsigned long long)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
            e.mtime = fd.ftLastWriteTime;
            e.hash = (e.size <= (64ull << 20)) ? hash_file(full) : 0;
            entries_push(out, &e);
        }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
}

static void snapshot(const WCHAR *root, Entries *out)
{
    ZeroMemory(out, sizeof(*out));
    walk(root, root, out);
}

static const Entry *find_entry(const Entries *a, const WCHAR *rel)
{
    for (size_t i = 0; i < a->count; i++) {
        if (_wcsicmp(a->items[i].rel, rel) == 0) return &a->items[i];
    }
    return NULL;
}

static void json_escape_w(const WCHAR *in, char *out, size_t cch)
{
    char tmp[WS_MAXPATH * 3];
    WideCharToMultiByte(CP_UTF8, 0, in, -1, tmp, (int)sizeof(tmp), NULL, NULL);
    size_t o = 0;
    for (char *p = tmp; *p && o + 2 < cch; p++) {
        unsigned char c = (unsigned char)*p;
        if (c == '\\' || c == '"') { out[o++] = '\\'; out[o++] = (char)c; }
        else if (c < 0x20) out[o++] = ' ';
        else out[o++] = (char)c;
    }
    out[o] = 0;
}

static void emit(FILE *f, const char *op, const WCHAR *rel)
{
    char esc[WS_MAXPATH * 3];
    json_escape_w(rel, esc, sizeof(esc));
    fprintf(f, "{\"op\":\"%s\",\"method\":\"snapshot\",\"path\":\"%s\"}\n", op, esc);
}

static int sig_equal(const Entry *a, const Entry *b)
{
    return a->size == b->size && a->hash == b->hash &&
           a->mtime.dwLowDateTime == b->mtime.dwLowDateTime &&
           a->mtime.dwHighDateTime == b->mtime.dwHighDateTime;
}

int wmain(int argc, WCHAR **argv)
{
    const WCHAR *root = NULL;
    const WCHAR *audit = NULL;
    int i = 1;
    WCHAR cmdline[32768];
    cmdline[0] = 0;
    for (; i < argc; i++) {
        if (wcscmp(argv[i], L"--root") == 0 && i + 1 < argc) root = argv[++i];
        else if (wcscmp(argv[i], L"--audit") == 0 && i + 1 < argc) audit = argv[++i];
        else if (wcscmp(argv[i], L"--") == 0) { i++; break; }
    }
    if (!root || !audit) {
        fwprintf(stderr, L"usage: winstage-rec.exe --root <dir> --audit <file.jsonl> -- <cmd> [args...]\n");
        return 2;
    }
    size_t pos = 0;
    for (int k = i; k < argc; k++) {
        if (k > i) cmdline[pos++] = L' ';
        size_t l = wcslen(argv[k]);
        wcsncpy(cmdline + pos, argv[k], 32767 - pos);
        pos += l;
    }
    cmdline[pos] = 0;

    Entries before, after;
    snapshot(root, &before);

    WCHAR cmdCopy[32768];
    wcscpy(cmdCopy, cmdline);
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));
    DWORD exitCode = (DWORD)-1;
    if (CreateProcessW(NULL, cmdCopy, NULL, NULL, FALSE, 0, NULL, root, &si, &pi)) {
        WaitForSingleObject(pi.hProcess, INFINITE);
        GetExitCodeProcess(pi.hProcess, &exitCode);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }

    snapshot(root, &after);

    FILE *f = _wfopen(audit, L"ab");
    if (!f) { fwprintf(stderr, L"cannot open audit %ls\n", audit); return 1; }

    /* created + modified */
    for (size_t k = 0; k < after.count; k++) {
        const Entry *b = find_entry(&before, after.items[k].rel);
        if (!b) emit(f, "file.create", after.items[k].rel);
        else if (!sig_equal(b, &after.items[k])) emit(f, "file.modify", after.items[k].rel);
    }
    /* deleted */
    for (size_t k = 0; k < before.count; k++) {
        if (!find_entry(&after, before.items[k].rel)) emit(f, "file.delete", before.items[k].rel);
    }
    char esc[WS_MAXPATH * 3];
    json_escape_w(cmdline, esc, sizeof(esc));
    fprintf(f, "{\"op\":\"run\",\"method\":\"snapshot\",\"cmd\":\"%s\",\"exit\":%lu}\n", esc, (unsigned long)exitCode);
    fclose(f);

    free(before.items);
    free(after.items);
    wprintf(L"[winstage-rec] root=%ls before=%zu after=%zu exit=%lu\n", root, before.count, after.count, (unsigned long)exitCode);
    return 0;
}
