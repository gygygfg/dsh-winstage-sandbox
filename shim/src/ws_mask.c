/* WinStageSandbox -- T4 shim: process-level read masking (task-10 execution half).
 *
 * The mask table is owned by T2 (src/paths.mjs, exported as `winstage.mask.v1`).
 * This file is the EXECUTOR: it must not invent its own normalization or table.
 * Two inputs are supported:
 *   - config `readDenyFile`: path to the `winstage.mask.v1` JSON export, or
 *   - config `readDeny`: an array of regex sources (same dialect),
 * plus `readAllow`: regexes evaluated BEFORE the deny list (minimum-necessary
 * whitelist that keeps the shell itself startable).
 *
 * Matching mirrors T2's maskKey(): realpath-native (junctions/symlinks resolved,
 * 8.3 short names expanded, `\\?\` stripped, `/` unified, trailing separator
 * dropped, `.`/`..` folded) followed by a case-INSENSITIVE regex search with
 * first-match-wins ordering.
 *
 * Fail-closed: a declared policy that cannot be loaded refuses reads; a pattern
 * that cannot be compiled becomes an always-matching rule (and is logged); the
 * matcher's step budget is also treated as a match.
 */
#include "winstage_internal.h"

#include <stdio.h>

/* ------------------------------------------------------------- regex engine
 * Recursive-descent parser -> node tree, matched with continuation passing.
 * Supported: literals, `.`, `[...]` (ranges, negation, \d \w \s), `(...)`, `|`,
 * `*`, `+`, `?`, `^`, `$` and escaped metacharacters. This is exactly the
 * dialect T2's table uses; anything unsupported fails compilation (=> deny). */

#define WS_RE_MAX_NODES 512
#define WS_RE_MAX_RULES 128
#define WS_RE_MATCH_BUDGET 400000

enum { N_EMPTY = 0, N_CHAR, N_ANY, N_CLASS, N_BOL, N_EOL, N_CAT, N_ALT, N_REP };

typedef struct WsReNode {
    int type;
    wchar_t ch;
    unsigned char cls[32];
    int negate;
    int min, max; /* N_REP; max = -1 unbounded */
    struct WsReNode *a, *b;
} WsReNode;

typedef struct WsReRule {
    wchar_t *label;
    int slabCount;      /* nodes are heap-allocated and owned by `root` */
    WsReNode *root;
    int caseSensitive;
} WsReRule;

typedef struct WsReParser {
    const char *p;
    WsReNode **slab;
    int *count;
    int cap;
    int error;
    int caseSensitive;
} WsReParser;

static WsReNode *re_new(WsReParser *ps, int type)
{
    if (*ps->count >= ps->cap) {
        ps->error = 1;
        return NULL;
    }
    WsReNode *n = (WsReNode *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(WsReNode));
    if (!n) {
        ps->error = 1;
        return NULL;
    }
    n->type = type;
    n->max = 1;
    ps->slab[(*ps->count)++] = n;
    return n;
}

static void re_free_node(WsReNode *n);
static void re_free_node(WsReNode *n)
{
    if (!n) return;
    if (n->type == N_CAT || n->type == N_ALT) {
        re_free_node(n->a);
        re_free_node(n->b);
    } else if (n->type == N_REP) {
        re_free_node(n->a);
    }
    HeapFree(GetProcessHeap(), 0, n);
}

static WsReNode *re_parse_alt(WsReParser *ps);

static void re_class_add(unsigned char *cls, wchar_t lo, wchar_t hi, int *ok)
{
    if (hi < lo) {
        *ok = 0;
        return;
    }
    for (unsigned int ch = (unsigned int)lo; ch <= (unsigned int)hi; ch++) {
        if (ch > 0x7F) {
            *ok = 0; /* the mask table only needs ASCII classes */
            return;
        }
        cls[ch >> 3] |= (unsigned char)(1u << (ch & 7));
    }
}

static WsReNode *re_parse_class(WsReParser *ps)
{
    unsigned char cls[32];
    memset(cls, 0, sizeof(cls));
    int negate = 0;
    int ok = 1;
    if (*ps->p == '^') {
        negate = 1;
        ps->p++;
    }
    while (*ps->p && *ps->p != ']') {
        wchar_t lo;
        if (*ps->p == '\\' && ps->p[1]) {
            ps->p++;
            switch (*ps->p) {
            case 'd': re_class_add(cls, L'0', L'9', &ok); ps->p++; continue;
            case 'w':
                re_class_add(cls, L'a', L'z', &ok);
                re_class_add(cls, L'A', L'Z', &ok);
                re_class_add(cls, L'0', L'9', &ok);
                re_class_add(cls, L'_', L'_', &ok);
                ps->p++;
                continue;
            case 's':
                re_class_add(cls, L' ', L' ', &ok);
                re_class_add(cls, L'\t', L'\t', &ok);
                re_class_add(cls, L'\n', L'\n', &ok);
                ps->p++;
                continue;
            default: lo = (wchar_t)(unsigned char)*ps->p; ps->p++; break;
            }
        } else {
            lo = (wchar_t)(unsigned char)*ps->p;
            ps->p++;
        }
        if (*ps->p == '-' && ps->p[1] && ps->p[1] != ']') {
            ps->p++;
            wchar_t hi;
            if (*ps->p == '\\' && ps->p[1]) {
                ps->p++;
                hi = (wchar_t)(unsigned char)*ps->p;
                ps->p++;
            } else {
                hi = (wchar_t)(unsigned char)*ps->p;
                ps->p++;
            }
            re_class_add(cls, lo, hi, &ok);
        } else {
            re_class_add(cls, lo, lo, &ok);
        }
    }
    if (*ps->p != ']') {
        ps->error = 1;
        return NULL;
    }
    ps->p++;
    if (!ok) {
        ps->error = 1;
        return NULL;
    }
    WsReNode *n = re_new(ps, N_CLASS);
    if (!n) return NULL;
    if (negate) {
        for (int i = 0; i < 32; i++) {
            cls[i] = (unsigned char)~cls[i];
        }
    }
    memcpy(n->cls, cls, 32);
    return n;
}

static WsReNode *re_parse_atom(WsReParser *ps)
{
    if (!*ps->p) {
        return NULL;
    }
    if (*ps->p == '(') {
        ps->p++;
        WsReNode *inner = re_parse_alt(ps);
        if (!inner || *ps->p != ')') {
            ps->error = 1;
            return NULL;
        }
        ps->p++;
        return inner;
    }
    if (*ps->p == '[') {
        ps->p++;
        return re_parse_class(ps);
    }
    if (*ps->p == '.') {
        ps->p++;
        return re_new(ps, N_ANY);
    }
    if (*ps->p == '^') {
        ps->p++;
        return re_new(ps, N_BOL);
    }
    if (*ps->p == '$') {
        ps->p++;
        return re_new(ps, N_EOL);
    }
    if (*ps->p == '\\' && ps->p[1]) {
        ps->p++;
        switch (*ps->p) {
        case 'd': {
            WsReNode *n = re_new(ps, N_CLASS);
            if (!n) return NULL;
            int ok = 1;
            re_class_add(n->cls, L'0', L'9', &ok);
            ps->p++;
            if (!ok) { ps->error = 1; return NULL; }
            return n;
        }
        case 'w': {
            WsReNode *n = re_new(ps, N_CLASS);
            if (!n) return NULL;
            int ok = 1;
            re_class_add(n->cls, L'a', L'z', &ok);
            re_class_add(n->cls, L'A', L'Z', &ok);
            re_class_add(n->cls, L'0', L'9', &ok);
            re_class_add(n->cls, L'_', L'_', &ok);
            ps->p++;
            if (!ok) { ps->error = 1; return NULL; }
            return n;
        }
        default: {
            wchar_t ch = (wchar_t)(unsigned char)*ps->p;
            ps->p++;
            WsReNode *n = re_new(ps, N_CHAR);
            if (!n) return NULL;
            n->ch = ch;
            return n;
        }
        }
    }
    wchar_t ch = (wchar_t)(unsigned char)*ps->p;
    ps->p++;
    WsReNode *n = re_new(ps, N_CHAR);
    if (!n) return NULL;
    n->ch = ch;
    return n;
}

static WsReNode *re_cat(WsReParser *ps, WsReNode *left, WsReNode *right)
{
    if (!left) return right;
    if (!right) return left;
    WsReNode *n = re_new(ps, N_CAT);
    if (!n) return left;
    n->a = left;
    n->b = right;
    return n;
}

static WsReNode *re_parse_repeat(WsReParser *ps)
{
    WsReNode *atom = re_parse_atom(ps);
    if (!atom) {
        return NULL;
    }
    if (*ps->p == '*' || *ps->p == '+' || *ps->p == '?') {
        char q = *ps->p++;
        WsReNode *rep = re_new(ps, N_REP);
        if (!rep) {
            re_free_node(atom);
            return NULL;
        }
        rep->a = atom;
        if (q == '*') { rep->min = 0; rep->max = -1; }
        else if (q == '+') { rep->min = 1; rep->max = -1; }
        else { rep->min = 0; rep->max = 1; }
        return rep;
    }
    return atom;
}

static WsReNode *re_parse_seq(WsReParser *ps)
{
    WsReNode *seq = NULL;
    while (*ps->p && *ps->p != ')' && *ps->p != '|') {
        WsReNode *piece = re_parse_repeat(ps);
        if (!piece) {
            break;
        }
        seq = re_cat(ps, seq, piece);
    }
    return seq;
}

static WsReNode *re_parse_alt(WsReParser *ps)
{
    WsReNode *left = re_parse_seq(ps);
    while (*ps->p == '|') {
        ps->p++;
        WsReNode *right = re_parse_seq(ps);
        WsReNode *n = re_new(ps, N_ALT);
        if (!n) {
            break;
        }
        n->a = left;
        n->b = right;
        left = n;
    }
    return left;
}

/* --------------------------------------------------------------- matching */

typedef struct WsK WsK;
typedef int (*WsKFn)(WsK *k, const wchar_t *s, int pos);
struct WsK {
    WsKFn fn;
    void *d1;
    void *d2;
    int i1;
    int i2;
};

static long g_reSteps;
/* Per-search case sensitivity, set by re_search() from the rule being matched.
 *
 * The matcher used to fold unconditionally (N_CHAR folded both sides; N_CLASS
 * tested the lowercase *and* the uppercase form), so `WsReRule.caseSensitive` --
 * and therefore the WINSTAGE_MASK_CASE_SENSITIVE mutation switch -- had no
 * effect on matching at all, and tools/mask-regression.mjs's "is the case
 * folding load-bearing?" self-proof could never go red. Honouring the flag here
 * only changes the mutation build: production compiles every rule with
 * caseSensitive = 0 (folding on), which is the behaviour asserted by
 * `mask.case-variant-denied`. */
static int g_reCase;

static int match_node(WsReNode *n, const wchar_t *s, int pos, WsK *k);

static int k_accept(WsK *k, const wchar_t *s, int pos)
{
    (void)k; (void)s; (void)pos;
    return 1;
}

typedef struct RepCtx {
    WsReNode *child;
    WsK *k;
    int min, max;
    int caseSensitive;
} RepCtx;

static int rep_try(RepCtx *rc, const wchar_t *s, int pos, int count);

static int k_rep_iter(WsK *k, const wchar_t *s, int pos)
{
    RepCtx *rc = (RepCtx *)k->d1;
    int before = k->i1;
    int count = k->i2 + 1;
    if (pos == before) {
        /* the child matched empty: stop iterating instead of looping forever */
        if (count - 1 >= rc->min || count >= rc->min) {
            return rc->k->fn(rc->k, s, pos);
        }
        return 0;
    }
    return rep_try(rc, s, pos, count);
}

static int rep_try(RepCtx *rc, const wchar_t *s, int pos, int count)
{
    if (rc->max < 0 || count < rc->max) {
        WsK more;
        more.fn = k_rep_iter;
        more.d1 = rc;
        more.d2 = NULL;
        more.i1 = pos;
        more.i2 = count;
        if (match_node(rc->child, s, pos, &more)) {
            return 1;
        }
    }
    if (count >= rc->min) {
        return rc->k->fn(rc->k, s, pos);
    }
    return 0;
}

static wchar_t re_fold(wchar_t ch, int caseSensitive)
{
    if (caseSensitive) {
        return ch;
    }
    if (ch >= L'A' && ch <= L'Z') {
        return (wchar_t)(ch - L'A' + L'a');
    }
    return ch;
}

typedef struct CatCtx {
    WsReNode *next;
    WsK *k;
} CatCtx;

static int k_cat(WsK *k, const wchar_t *s, int pos)
{
    CatCtx *cc = (CatCtx *)k->d1;
    return match_node(cc->next, s, pos, cc->k);
}

static int match_node(WsReNode *n, const wchar_t *s, int pos, WsK *k)
{
    if (!n) {
        return k->fn(k, s, pos);
    }
    if (--g_reSteps <= 0) {
        return 2; /* budget exhausted: caller treats it as a match (fail-closed) */
    }
    switch (n->type) {
    case N_EMPTY:
        return k->fn(k, s, pos);
    case N_CHAR:
        if (s[pos] == 0) {
            return 0;
        }
        if (g_reCase ? (s[pos] != n->ch) : (re_fold(s[pos], 0) != re_fold(n->ch, 0))) {
            return 0;
        }
        return k->fn(k, s, pos + 1);
    case N_ANY:
        if (s[pos] == 0) {
            return 0;
        }
        return k->fn(k, s, pos + 1);
    case N_CLASS: {
        if (s[pos] == 0) {
            return 0;
        }
        unsigned int raw = (unsigned int)s[pos];
        int hit = 0;
        if (g_reCase) {
            /* fold disabled: only the character as written may match */
            if (raw < 256 && ((n->cls[raw >> 3] >> (raw & 7)) & 1)) hit = 1;
        } else {
            unsigned int lo = (unsigned int)re_fold(s[pos], 0);
            unsigned int hi = (unsigned int)re_fold(s[pos], 1);
            if (lo < 256 && ((n->cls[lo >> 3] >> (lo & 7)) & 1)) hit = 1;
            if (!hit && hi < 256 && ((n->cls[hi >> 3] >> (hi & 7)) & 1)) hit = 1;
        }
        if (!hit) {
            return 0;
        }
        return k->fn(k, s, pos + 1);
    }
    case N_BOL:
        return pos == 0 ? k->fn(k, s, pos) : 0;
    case N_EOL:
        return s[pos] == 0 ? k->fn(k, s, pos) : 0;
    case N_CAT: {
        CatCtx cc;
        cc.next = n->b;
        cc.k = k;
        WsK k2;
        k2.fn = k_cat;
        k2.d1 = &cc;
        k2.d2 = NULL;
        k2.i1 = 0;
        k2.i2 = 0;
        int res = match_node(n->a, s, pos, &k2);
        return res;
    }
    case N_ALT: {
        int res = match_node(n->a, s, pos, k);
        if (res) {
            return res;
        }
        return match_node(n->b, s, pos, k);
    }
    case N_REP: {
        RepCtx rc;
        rc.child = n->a;
        rc.k = k;
        rc.min = n->min;
        rc.max = n->max;
        return rep_try(&rc, s, pos, 0);
    }
    default:
        return 0;
    }
}

static int re_search(const WsReRule *r, const wchar_t *s)
{
    WsK accept;
    accept.fn = k_accept;
    accept.d1 = accept.d2 = NULL;
    accept.i1 = accept.i2 = 0;
    g_reCase = r->caseSensitive;
    for (int start = 0;; start++) {
        g_reSteps = WS_RE_MATCH_BUDGET;
        int res = match_node(r->root, s, start, &accept);
        if (res == 1 || res == 2) {
            return 1;
        }
        if (s[start] == 0) {
            return 0;
        }
    }
}

/* ------------------------------------------------------------ mask storage */

typedef struct WsMask {
    int declared;
    int loaded;
    int ruleCount;
    WsReRule rules[WS_RE_MAX_RULES];
    int allowCount;
    WsReRule allow[WS_RE_MAX_RULES];
    int caseSensitive;
} WsMask;

static WsMask g_mask;

static void re_rule_free(WsReRule *r)
{
    if (r->root) {
        re_free_node(r->root);
    }
    r->root = NULL;
    r->slabCount = 0;
    ws_free(r->label);
    r->label = NULL;
}

/* Compile `patternA` (UTF-8/ASCII) into `r`. Returns 1 on success. */
static int ws_mask_compile(WsReRule *r, const char *patternA, const wchar_t *label)
{
    memset(r, 0, sizeof(*r));
    r->caseSensitive = g_mask.caseSensitive;
    r->label = ws_strdup_w(label && label[0] ? label : L"<rule>");
    /* The parser arena lives on this frame: nodes are heap-allocated, and the
     * tree (root) owns them. Storing the slab inside the rule used to leave an
     * uninitialised pointer as the arena -> wild writes (0xC0000005). */
    WsReNode *slab[WS_RE_MAX_NODES];
    WsReParser ps;
    memset(&ps, 0, sizeof(ps));
    ps.p = patternA;
    ps.slab = slab;
    ps.count = &r->slabCount;
    ps.cap = WS_RE_MAX_NODES;
    ps.caseSensitive = r->caseSensitive;
    r->root = re_parse_alt(&ps);
    if (ps.error || !r->root || *ps.p != 0) {
        if (r->root) {
            re_free_node(r->root);
            r->root = NULL;
        } else {
            for (int i = 0; i < r->slabCount; i++) {
                HeapFree(GetProcessHeap(), 0, slab[i]);
            }
        }
        r->slabCount = 0;
        return 0;
    }
    return 1;
}

static void ws_mask_always_match(WsReRule *r)
{
    WsReParser ps;
    memset(&ps, 0, sizeof(ps));
    WsReNode *slab[WS_RE_MAX_NODES];
    ps.slab = slab;
    ps.count = &r->slabCount;
    ps.cap = WS_RE_MAX_NODES;
    WsReNode *a = re_new(&ps, N_ANY);
    WsReNode *rep = re_new(&ps, N_REP);
    if (rep) {
        rep->a = a;
        rep->min = 0;
        rep->max = -1;
        r->root = rep;
    }
}

/* --------------------------------------------------------- normalization */

/* maskKey() equivalent: absolute, `\\?\` stripped, 8.3 expanded, `.`/`..`
 * folded, separators unified, trailing separator dropped, and junctions /
 * symlinks resolved via the final path of the file (or of the parent when the
 * file does not exist -- otherwise a junction to the *parent* of a sensitive
 * file would evade the mask). */
static void ws_mask_normalize(const wchar_t *in, wchar_t *out, DWORD cch)
{
    out[0] = 0;
    if (!in || !in[0]) {
        return;
    }
    wchar_t full[WS_PATH_MAX];
    if (!GetFullPathNameW(in, WS_PATH_MAX, full, NULL)) {
        ws_strlcpy_w(full, in, WS_PATH_MAX);
    }
    wchar_t longName[WS_PATH_MAX];
    if (GetLongPathNameW(full, longName, WS_PATH_MAX) > 0) {
        ws_strlcpy_w(full, longName, WS_PATH_MAX);
    }
    wchar_t resolved[WS_PATH_MAX];
    resolved[0] = 0;
    /* MUST NOT call CreateFileW directly: the shim's own import table is not
     * reliably skipped by the IAT pass, so this re-entered ws_CreateFileW ->
     * mask decision -> normalize -> CreateFileW ... and blew the stack
     * (0xC00000FD, measured). Use the captured original. */
    HANDLE h = ws_open_file_raw_flags(full, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS);
    if (h != INVALID_HANDLE_VALUE) {
        DWORD n = GetFinalPathNameByHandleW(h, resolved, WS_PATH_MAX, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
        CloseHandle(h);
        if (n == 0 || n >= WS_PATH_MAX) {
            resolved[0] = 0;
        }
    }
    if (!resolved[0]) {
        wchar_t parent[WS_PATH_MAX];
        ws_strlcpy_w(parent, full, WS_PATH_MAX);
        wchar_t *slash = wcsrchr(parent, L'\\');
        if (slash && slash != parent) {
            wchar_t leaf[WS_PATH_MAX];
            ws_strlcpy_w(leaf, slash + 1, WS_PATH_MAX);
            *slash = 0;
            HANDLE ph = ws_open_file_raw_flags(parent, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                                OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS);
            if (ph != INVALID_HANDLE_VALUE) {
                wchar_t pr[WS_PATH_MAX];
                DWORD n = GetFinalPathNameByHandleW(ph, pr, WS_PATH_MAX, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
                CloseHandle(ph);
                if (n > 0 && n < WS_PATH_MAX) {
                    size_t pos = 0;
                    resolved[0] = 0;
                    ws_append_w(resolved, WS_PATH_MAX, &pos, pr);
                    ws_append_w(resolved, WS_PATH_MAX, &pos, L"\\");
                    ws_append_w(resolved, WS_PATH_MAX, &pos, leaf);
                }
            }
        }
    }
    const wchar_t *src = resolved[0] ? resolved : full;
    if (ws_starts_with_ci_w(src, L"\\\\?\\UNC\\")) {
        src += 8;
        out[0] = L'\\';
        out[1] = L'\\';
        ws_strlcpy_w(out + 2, src, cch > 2 ? cch - 2 : 1);
    } else if (ws_starts_with_ci_w(src, L"\\\\?\\")) {
        src += 4;
        ws_strlcpy_w(out, src, cch);
    } else {
        ws_strlcpy_w(out, src, cch);
    }
    for (size_t i = 0; out[i]; i++) {
        if (out[i] == L'/') {
            out[i] = L'\\';
        }
    }
    size_t n = wcslen(out);
    while (n > 3 && out[n - 1] == L'\\') {
        out[--n] = 0;
    }
}

/* ------------------------------------------------- mask.json (purpose-built)
 * We only need the string fields of `entries[]` (id/pattern) and `probes[]`
 * (path/maskClass); a general JSON parser is unnecessary surface area. */

static const char *ws_json_find_key(const char *begin, const char *end, const char *key, const char **valueStart)
{
    size_t klen = strlen(key);
    const char *p = begin;
    while (p && p < end) {
        p = (const char *)memchr(p, '"', (size_t)(end - p));
        if (!p) {
            return NULL;
        }
        const char *q = p + 1;
        const char *r = q;
        int esc = 0;
        while (r < end && *r) {
            if (esc) { esc = 0; r++; continue; }
            if (*r == '\\') { esc = 1; r++; continue; }
            if (*r == '"') break;
            r++;
        }
        if (r >= end || *r != '"') {
            return NULL;
        }
        const char *after = r + 1;
        while (after < end && (*after == ' ' || *after == '\t' || *after == '\r' || *after == '\n')) after++;
        if ((size_t)(r - q) == klen && memcmp(q, key, klen) == 0 && after < end && *after == ':') {
            const char *v = after + 1;
            while (v < end && (*v == ' ' || *v == '\t' || *v == '\r' || *v == '\n')) v++;
            *valueStart = v;
            return q;
        }
        p = r + 1;
    }
    return NULL;
}

/* Like ws_json_find_key but keeps looking until the value is an array: the
 * export contains `counts.probes = 68` before the real `probes: [...]`, and the
 * first-match-wins scanner would stop there (it silently produced 0 cases). */
static int ws_json_find_array(const char *begin, const char *end, const char *key, const char **valueStart)
{
    const char *p = begin;
    for (;;) {
        const char *v = NULL;
        const char *found = ws_json_find_key(p, end, key, &v);
        if (!found || !v || v >= end) {
            return 0;
        }
        if (*v == '[') {
            *valueStart = v;
            return 1;
        }
        p = v;
        if (p >= end) {
            return 0;
        }
    }
}

static int ws_json_str(const char *v, const char *end, char *out, size_t cch)
{
    if (!v || v >= end || *v != '"') {
        return 0;
    }
    v++;
    size_t o = 0;
    while (v < end && *v && *v != '"') {
        if (*v == '\\' && v + 1 < end) {
            v++;
            switch (*v) {
            case 'n': if (o + 1 < cch) out[o++] = '\n'; break;
            case 't': if (o + 1 < cch) out[o++] = '\t'; break;
            case 'r': if (o + 1 < cch) out[o++] = '\r'; break;
            case '"': if (o + 1 < cch) out[o++] = '"'; break;
            case '\\': if (o + 1 < cch) out[o++] = '\\'; break;
            case '/': if (o + 1 < cch) out[o++] = '/'; break;
            default: if (o + 1 < cch) out[o++] = *v; break;
            }
            v++;
            continue;
        }
        if (o + 1 < cch) {
            out[o++] = *v;
        }
        v++;
    }
    out[o] = 0;
    return 1;
}

static int ws_mask_load_rules(const wchar_t *path, WsReRule *list, int *count, int cap, int *hardFailure)
{
    char *text = NULL;
    DWORD len = 0;
    if (!ws_read_text_file(path, &text, &len)) {
        if (hardFailure) *hardFailure = 1;
        return 0;
    }
    const char *end = text + len;
    const char *v = NULL;
    if (!ws_json_find_array(text, end, "entries", &v)) {
        HeapFree(GetProcessHeap(), 0, text);
        if (hardFailure) *hardFailure = 1;
        return 0;
    }
    const char *p = v + 1;
    while (p < end && *p && *count < cap) {
        while (p < end && (*p == ' ' || *p == ',' || *p == '\r' || *p == '\n' || *p == '\t')) p++;
        if (p >= end || *p != '{') break;
        const char *objEnd = (const char *)memchr(p, '}', (size_t)(end - p));
        if (!objEnd) break;
        char pattern[1024], id[256];
        pattern[0] = id[0] = 0;
        const char *pv = NULL, *iv = NULL;
        if (ws_json_find_key(p, objEnd, "pattern", &pv)) {
            ws_json_str(pv, objEnd, pattern, sizeof(pattern));
        }
        if (ws_json_find_key(p, objEnd, "id", &iv)) {
            ws_json_str(iv, objEnd, id, sizeof(id));
        }
        if (pattern[0]) {
            wchar_t label[256];
            label[0] = 0;
            MultiByteToWideChar(CP_UTF8, 0, id, -1, label, 256);
            WsReRule *r = &list[*count];
            if (ws_mask_compile(r, pattern, label)) {
                (*count)++;
            } else {
                /* fail-closed: an uncompilable rule must not silently vanish */
                ws_log("read mask: pattern failed to compile (rule %s) -> always-match", id);
                memset(r, 0, sizeof(*r));
                r->label = ws_strdup_w(label[0] ? label : L"<uncompilable>");
                ws_mask_always_match(r);
                (*count)++;
                if (hardFailure) *hardFailure = 1;
            }
        }
        p = objEnd + 1;
    }
    HeapFree(GetProcessHeap(), 0, text);
    return *count > 0;
}

/* ------------------------------------------------------------------ public */

/* Mutation self-proof switch (WINSTAGE_MASK_CASE_SENSITIVE=1 disables the case
 * folding). It must be consulted by EVERY entry point that compiles rules, not
 * only by ws_mask_init(): ws_mask_compile() reads g_mask.caseSensitive, so the
 * offline helpers used by tools/mask-regression.mjs went through the same
 * compile path and silently ignored the switch -- the self-proof could then
 * never go red, i.e. it proved nothing. */
static int ws_mask_case_sensitive_env(void)
{
    wchar_t buf[16];
    DWORD n = GetEnvironmentVariableW(L"WINSTAGE_MASK_CASE_SENSITIVE", buf, 16);
    return n > 0 && n < 16 && !(buf[0] == L'0' && buf[1] == 0);
}

LSTATUS ws_mask_init(void)
{
    memset(&g_mask, 0, sizeof(g_mask));
    if (ws_mask_case_sensitive_env()) {
        g_mask.caseSensitive = 1; /* mutation self-proof only */
    }
    for (int i = 0; i < g_ws.readAllowCount; i++) {
        WsReRule r;
        if (ws_mask_compile(&r, g_ws.readAllow[i], L"readAllow")) {
            g_mask.allow[g_mask.allowCount++] = r;
        } else {
            ws_log("readAllow[%d] failed to compile; ignored (allow-list is a safety valve)", i);
        }
    }
    int hardFailure = 0;
    if (g_ws.readDenyFile[0]) {
        g_mask.declared = 1;
        if (!ws_mask_load_rules(g_ws.readDenyFile, g_mask.rules, &g_mask.ruleCount, WS_RE_MAX_RULES, &hardFailure)) {
            ws_log("readDenyFile could not be loaded");
            g_mask.loaded = 0;
            return -1;
        }
    }
    for (int i = 0; i < g_ws.readDenyCount; i++) {
        g_mask.declared = 1;
        WsReRule r;
        if (ws_mask_compile(&r, g_ws.readDeny[i], L"readDeny")) {
            g_mask.rules[g_mask.ruleCount++] = r;
        } else {
            ws_log("readDeny[%d] failed to compile -> always-match", i);
            memset(&r, 0, sizeof(r));
            r.label = ws_strdup_w(L"<uncompilable>");
            ws_mask_always_match(&r);
            g_mask.rules[g_mask.ruleCount++] = r;
            hardFailure = 1;
        }
    }
    g_mask.loaded = g_mask.ruleCount > 0 && !hardFailure;
    if (g_mask.declared) {
        ws_log("read mask: declared=%d loaded=%d denyRules=%d allowRules=%d caseSensitive=%d",
               g_mask.declared, g_mask.loaded, g_mask.ruleCount, g_mask.allowCount, g_mask.caseSensitive);
    }
    return g_mask.declared ? (g_mask.loaded ? 1 : -1) : 0;
}

int ws_mask_declared(void)
{
    return g_mask.declared;
}

int ws_mask_rule_count(void)
{
    return g_mask.ruleCount;
}

/* 1 = deny, 0 = allow. `outRule` gets the matched rule label. */
/* Thread-local re-entrancy guard. With every internal call routed through the
 * captured originals this never trips; if it ever does (a future hook, a
 * third-party hook chained in front of us), we fail CLOSED and log instead of
 * recursing until the stack overflows. */
static _Thread_local int t_maskDepth;
static int ws_mask_decide_read_inner(const wchar_t *path, wchar_t *outRule, DWORD outRuleCch);

int ws_mask_in_decision(void)
{
    return t_maskDepth > 0;
}

int ws_mask_decide_read(const wchar_t *path, wchar_t *outRule, DWORD outRuleCch)
{
    if (outRule && outRuleCch) {
        outRule[0] = 0;
    }
    if (!g_mask.declared) {
        return 0;
    }
    if (t_maskDepth > 0) {
        ws_log("read mask: re-entrant decision (depth %d) -> deny (fail-closed)", t_maskDepth);
        if (outRule && outRuleCch) {
            ws_strlcpy_w(outRule, L"<mask-reentrant>", outRuleCch);
        }
        return 1;
    }
    t_maskDepth++;
    int decision = ws_mask_decide_read_inner(path, outRule, outRuleCch);
    t_maskDepth--;
    return decision;
}

static int ws_mask_decide_read_inner(const wchar_t *path, wchar_t *outRule, DWORD outRuleCch)
{
    if (!g_mask.loaded) {
        if (outRule && outRuleCch) {
            ws_strlcpy_w(outRule, L"<mask-policy-unloadable>", outRuleCch);
        }
        return 1; /* fail-closed */
    }
    wchar_t normalized[WS_PATH_MAX];
    ws_mask_normalize(path, normalized, WS_PATH_MAX);
    if (!normalized[0]) {
        if (g_ws.readDenyFailMode == 0) {
            if (outRule && outRuleCch) {
                ws_strlcpy_w(outRule, L"<mask-normalize-failed>", outRuleCch);
            }
            return 1;
        }
        return 0;
    }
    for (int i = 0; i < g_mask.allowCount; i++) {
        if (re_search(&g_mask.allow[i], normalized)) {
            return 0;
        }
    }
    for (int i = 0; i < g_mask.ruleCount; i++) {
        if (re_search(&g_mask.rules[i], normalized)) {
            if (outRule && outRuleCch) {
                ws_strlcpy_w(outRule, g_mask.rules[i].label ? g_mask.rules[i].label : L"<rule>", outRuleCch);
            }
            return 1;
        }
    }
    return 0;
}

void ws_mask_normalized(const wchar_t *path, wchar_t *out, DWORD cch)
{
    ws_mask_normalize(path, out, cch);
}

/* Offline regression: run `probes[]` through the same normalize+search path and
 * compare with the expected `maskClass` (null = must not match). */
int ws_mask_check_probes(const wchar_t *maskFile, const wchar_t *outFile, char *summary, DWORD summaryCch)
{
    WsMask saved;
    memcpy(&saved, &g_mask, sizeof(WsMask));
    memset(&g_mask, 0, sizeof(g_mask));
    if (ws_mask_case_sensitive_env()) {
        g_mask.caseSensitive = 1; /* mutation self-proof only */
    }
    int hardFailure = 0;
    int loaded = ws_mask_load_rules(maskFile, g_mask.rules, &g_mask.ruleCount, WS_RE_MAX_RULES, &hardFailure);

    char *text = NULL;
    DWORD len = 0;
    int total = 0, agree = 0, mismatch = 0;
    if (!ws_read_text_file(maskFile, &text, &len)) {
        if (summary && summaryCch) snprintf(summary, summaryCch, "cannot read mask file");
        memcpy(&g_mask, &saved, sizeof(WsMask));
        return -1;
    }
    const char *end = text + len;
    char *json = (char *)HeapAlloc(GetProcessHeap(), 0, 512 * 1024);
    int written = 0;
    if (json) {
        written += snprintf(json + written, 512 * 1024 - (size_t)written,
                            "{\"suite\":\"maskcheck\",\"loaded\":%s,\"rules\":%d,\"cases\":[",
                            loaded ? "true" : "false", g_mask.ruleCount);
    }
    const char *v = NULL;
    if (ws_json_find_array(text, end, "probes", &v)) {
        const char *p = v + 1;
        while (p < end && *p && json && written < 512 * 1024 - 2048) {
            while (p < end && (*p == ' ' || *p == ',' || *p == '\r' || *p == '\n' || *p == '\t')) p++;
            if (p >= end || *p != '{') break;
            const char *objEnd = (const char *)memchr(p, '}', (size_t)(end - p));
            if (!objEnd) break;
            char pathA[2048], expectA[256];
            pathA[0] = expectA[0] = 0;
            const char *pv = NULL;
            if (ws_json_find_key(p, objEnd, "path", &pv)) {
                ws_json_str(pv, objEnd, pathA, sizeof(pathA));
            }
            const char *ev = NULL;
            int hasExpect = ws_json_find_key(p, objEnd, "maskClass", &ev) != NULL;
            int expectNull = 0;
            if (hasExpect && !ws_json_str(ev, objEnd, expectA, sizeof(expectA))) {
                expectNull = 1;
            }
            wchar_t wpath[2048];
            wpath[0] = 0;
            MultiByteToWideChar(CP_UTF8, 0, pathA, -1, wpath, 2048);
            wchar_t normalized[WS_PATH_MAX];
            ws_mask_normalize(wpath, normalized, WS_PATH_MAX);
            wchar_t hit[256];
            hit[0] = 0;
            int deny = 0;
            for (int i = 0; i < g_mask.ruleCount; i++) {
                if (re_search(&g_mask.rules[i], normalized)) {
                    deny = 1;
                    ws_strlcpy_w(hit, g_mask.rules[i].label ? g_mask.rules[i].label : L"<rule>", 256);
                    break;
                }
            }
            total++;
            int ok = expectNull ? !deny : deny;
            if (ok) agree++; else mismatch++;
            char pathEsc[4096], hitA[512];
            size_t o = 0;
            for (size_t i = 0; pathA[i] && o + 3 < sizeof(pathEsc); i++) {
                if (pathA[i] == '\\' || pathA[i] == '"') pathEsc[o++] = '\\';
                pathEsc[o++] = pathA[i];
            }
            pathEsc[o] = 0;
            WideCharToMultiByte(CP_UTF8, 0, hit, -1, hitA, sizeof(hitA), NULL, NULL);
            written += snprintf(json + written, 512 * 1024 - (size_t)written,
                                "%s{\"path\":\"%s\",\"expected\":\"%s\",\"got\":\"%s\",\"rule\":\"%s\",\"ok\":%s}",
                                total > 1 ? "," : "", pathEsc, expectNull ? "(none)" : expectA,
                                deny ? "hit" : "none", hitA, ok ? "true" : "false");
            p = objEnd + 1;
        }
    }
    HeapFree(GetProcessHeap(), 0, text);
    if (json) {
        written += snprintf(json + written, 512 * 1024 - (size_t)written,
                            "],\"total\":%d,\"agree\":%d,\"mismatch\":%d}\n", total, agree, mismatch);
        ws_write_bytes_to_file(outFile, json, (DWORD)written);
    }
    memcpy(&g_mask, &saved, sizeof(WsMask));
    if (summary && summaryCch) {
        snprintf(summary, summaryCch, "total=%d agree=%d mismatch=%d loaded=%s", total, agree, mismatch,
                 loaded ? "true" : "false");
    }
    return (mismatch == 0 && total > 0) ? 1 : 0;
}

/* Evaluate one path against a mask file WITHOUT disturbing the running policy.
 * Used by the probe export (offline regression / triage). */
int ws_mask_check_path_file(const wchar_t *maskFile, const wchar_t *path, char *out, DWORD cch)
{
    WsMask saved;
    memcpy(&saved, &g_mask, sizeof(WsMask));
    memset(&g_mask, 0, sizeof(g_mask));
    if (ws_mask_case_sensitive_env()) {
        g_mask.caseSensitive = 1; /* mutation self-proof only */
    }
    int hardFailure = 0;
    int loaded = ws_mask_load_rules(maskFile, g_mask.rules, &g_mask.ruleCount, WS_RE_MAX_RULES, &hardFailure);
    wchar_t normalized[WS_PATH_MAX];
    ws_mask_normalize(path, normalized, WS_PATH_MAX);
    wchar_t hit[256];
    hit[0] = 0;
    int deny = 0;
    int ruleIndex = -1;
    if (loaded) {
        for (int i = 0; i < g_mask.ruleCount; i++) {
            if (re_search(&g_mask.rules[i], normalized)) {
                deny = 1;
                ruleIndex = i;
                ws_strlcpy_w(hit, g_mask.rules[i].label ? g_mask.rules[i].label : L"<rule>", 256);
                break;
            }
        }
    }
    char pathA[4096], normA[4096], hitA[512];
    pathA[0] = normA[0] = hitA[0] = 0;
    WideCharToMultiByte(CP_UTF8, 0, path ? path : L"", -1, pathA, sizeof(pathA), NULL, NULL);
    WideCharToMultiByte(CP_UTF8, 0, normalized, -1, normA, sizeof(normA), NULL, NULL);
    WideCharToMultiByte(CP_UTF8, 0, hit, -1, hitA, sizeof(hitA), NULL, NULL);
    char pathEsc[8192], normEsc[8192];
    size_t o = 0;
    for (size_t i = 0; pathA[i] && o + 3 < sizeof(pathEsc); i++) {
        if (pathA[i] == '\\' || pathA[i] == '"') pathEsc[o++] = '\\';
        pathEsc[o++] = pathA[i];
    }
    pathEsc[o] = 0;
    o = 0;
    for (size_t i = 0; normA[i] && o + 3 < sizeof(normEsc); i++) {
        if (normA[i] == '\\' || normA[i] == '"') normEsc[o++] = '\\';
        normEsc[o++] = normA[i];
    }
    normEsc[o] = 0;
    char json[20000];
    int n = snprintf(json, sizeof(json),
                     "{\"path\":\"%s\",\"normalized\":\"%s\",\"loaded\":%s,\"rules\":%d,\"decision\":\"%s\",\"rule\":\"%s\",\"ruleIndex\":%d}\n",
                     pathEsc, normEsc, loaded ? "true" : "false", g_mask.ruleCount,
                     deny ? "deny" : "allow", hitA, ruleIndex);
    if (out && cch) {
        unsigned copy = (unsigned)n < cch - 1 ? (unsigned)n : cch - 1;
        memcpy(out, json, copy);
        out[copy] = 0;
    }
    memcpy(&g_mask, &saved, sizeof(WsMask));
    return deny;
}