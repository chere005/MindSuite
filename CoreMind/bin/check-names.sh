#!/bin/sh
# No account name or person name in any tracked file, path, commit message or history.
#
#   sh CoreMind/bin/check-names.sh tree [--ratchet REV|auto] [--files-only] [-- pathspec...]
#   sh CoreMind/bin/check-names.sh literals [--ratchet REV|auto] [-- pathspec...]
#   sh CoreMind/bin/check-names.sh staged
#   sh CoreMind/bin/check-names.sh message FILE
#   sh CoreMind/bin/check-names.sh history REV... [--not REV...]
#   sh CoreMind/bin/check-names.sh mirror DIR
#   sh CoreMind/bin/check-names.sh --self-test
#
# Needles live in an untracked list (MIND_NEEDLES, else ~/Library/Application Support/MindSuite/needles.txt,
# built by needles-init.sh). Output is path:line, a rule and a needle number (#k) only: never a needle, never a
# matched token, and a path that contains a needle is printed with <NAME> in its place.
#
# Matching, per token ([A-Za-z0-9_]+): a needle of 5+ letters hits as a case-insensitive substring of the line;
# a shorter one hits when a subword (split on _, digits, camelCase) or a whole letter run equals it, equals it
# plus s/es, or starts or ends with it. An allowlist beside the needles (sha256 of a lowercase token, or of
# path NUL line) lets a token or line through. Binary blobs get a long-needle byte search plus PNG text chunks and
# JPEG/EXIF strings; base64 runs (40+) are decoded and searched for long needles.
#
# Exit: 0 clean, 1 findings, 2 cannot run (no needle list and MIND_NAMES_OPTIONAL is not 1, bad arguments).
# literals needs no needle list (an id in a person context must be a placeholder, a generic word or a role word). The
# placeholders are the tracked CoreMind/bin/placeholder-ids.txt: one `handle  # reason` per line, optionally scoped to
# path globs (its header says how to register one). A registered handle that is a needle fails `literals`, so a real
# id cannot be registered. Syntactic non-literals are skipped: acc[$user] = ..., typeof user === 'string', the field
# names of a record held by a singular key, a /users path segment, "$id@x.com", scheme://u:password@, ${KEEP:-0}, KEEP=1.
# Strict zero (no ratchet) when MIND_NAMES_STRICT=1 or CoreMind/bin/names-strict exists.
set -e
MIND_CALLER_PWD=$(pwd -P)
export MIND_CALLER_PWD
cd "$(dirname "$0")/.."
. bin/python.sh
mind_python || exit 1
exec $MIND_PYTHON - "$@" <<'PY'
import base64, binascii, fnmatch, hashlib, os, re, shutil, struct, subprocess, sys, tempfile, unicodedata, zlib
from collections import Counter

HERE = os.getcwd()                     # CoreMind
SUITE = os.path.dirname(HERE)
CALLER = os.environ.get('MIND_CALLER_PWD') or HERE
ENV = None                             # self-test swaps in a clean environment
TOK = re.compile(r'[A-Za-z0-9_]+')
SUB = re.compile(r'[A-Z]?[a-z]+|[A-Z]+(?![a-z])')
B64 = re.compile(r'[A-Za-z0-9+/_-]{40,}={0,2}')
ZERO = re.compile(r'^0+$')


class Fail(Exception):
    pass


# ---------------------------------------------------------------- git plumbing
def git(repo, *args, inp=None):
    r = subprocess.run(['git', '-C', repo] + list(args), input=inp, capture_output=True, env=ENV)
    if r.returncode != 0:
        raise Fail('git %s failed' % (args[0] if args else ''))
    return r.stdout


def toplevel(path):
    r = subprocess.run(['git', '-C', path, 'rev-parse', '--show-toplevel'], capture_output=True, env=ENV)
    if r.returncode == 0 and r.stdout.strip():
        return r.stdout.decode().strip()
    return SUITE


def read_objects(repo, oids):
    """yield (oid, type, bytes|None) for each oid through one git cat-file --batch."""
    p = subprocess.Popen(['git', '-C', repo, 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, env=ENV)
    try:
        for oid in oids:
            p.stdin.write(oid.encode() + b'\n')
            p.stdin.flush()
            head = p.stdout.readline().split()
            if len(head) < 3:
                yield oid, 'missing', None
                continue
            size = int(head[2])
            data = p.stdout.read(size)
            p.stdout.read(1)
            yield oid, head[1].decode(), data
    finally:
        p.stdin.close()
        p.stdout.close()
        p.wait()


# ---------------------------------------------------------------- needles
def needle_path():
    return os.environ.get('MIND_NEEDLES') or os.path.expanduser('~/Library/Application Support/MindSuite/needles.txt')


def load_needles():
    p = needle_path()
    if not os.path.isfile(p):
        return None
    out = []
    for l in open(p, encoding='utf-8', errors='replace'):
        l = fold(l.strip()).lower()
        if l and not l.startswith('#') and l not in out:
            out.append(l)
    return out or None


def load_allow(needle_file):
    p = os.environ.get('MIND_NEEDLE_ALLOW') or os.path.join(os.path.dirname(needle_file), 'needle-allow.sha256')
    got = set()
    try:
        for l in open(p):
            w = l.split()
            if w and re.fullmatch(r'[0-9a-f]{64}', w[0]):
                got.add(w[0])
    except OSError:
        pass
    return got


def sha(s):
    return hashlib.sha256(s.encode('utf-8', 'replace')).hexdigest()


SPECIAL = {'ø': 'o', 'Ø': 'O', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ð': 'd', 'Ð': 'D', 'æ': 'ae', 'Æ': 'AE',
           'œ': 'oe', 'Œ': 'OE', 'ß': 'ss', 'ı': 'i', 'þ': 'th', 'Þ': 'TH'}


def fold(s):
    """accents, combining marks and invisible format characters removed (ASCII text is returned as is)."""
    if s.isascii():
        return s
    out = []
    for c in s:
        if ord(c) < 128:
            out.append(c)
        elif c in SPECIAL:
            out.append(SPECIAL[c])
        elif unicodedata.category(c) in ('Cf', 'Mn', 'Me'):
            continue
        else:
            out.append(''.join(x for x in unicodedata.normalize('NFKD', c) if unicodedata.category(x) not in ('Mn', 'Me')))
    return ''.join(out)


class Matcher:
    def __init__(self, needles, allow=()):
        self.needles = needles
        self.allow = set(allow)
        self.short = [(i + 1, n) for i, n in enumerate(needles) if len(n) < 5 and n.isalpha()]
        self.long = [(i + 1, n) for i, n in enumerate(needles) if not (len(n) < 5 and n.isalpha())]
        self.every = [n for n in needles]

    def line(self, text, path=''):
        """[(needle#, start, end)] for one line of text (positions are in the accent-folded text)."""
        orig = text
        text = fold(text)
        low = text.lower()
        if not any(n in low for n in self.every):
            return []
        if self.allow and sha(path + '\0' + orig) in self.allow:
            return []
        masked = list(low)
        toks = list(TOK.finditer(text))
        skip = set()
        if self.allow:
            for m in toks:
                if sha(m.group().lower()) in self.allow:
                    skip.add(m.start())
                    for k in range(m.start(), m.end()):
                        masked[k] = ' '
        masked = ''.join(masked)
        hits = {}
        for m in toks:
            if m.start() in skip:
                continue
            tl = m.group().lower()
            if not any(n in tl for _, n in self.short):
                continue
            t = m.group()
            cands = set()
            for run in re.split(r'[_0-9]+', t):
                if run:
                    cands.add(run.lower())
                    for sw in SUB.findall(run):
                        cands.add(sw.lower())
            for idx, n in self.short:
                if n not in tl:
                    continue
                for c in cands:
                    if c == n or c == n + 's' or c == n + 'es' or c.startswith(n) or c.endswith(n):
                        hits[(idx, m.start())] = m.end()
                        break
        for idx, n in self.long:
            j = masked.find(n)
            while j >= 0:
                hits[(idx, j)] = j + len(n)
                j = masked.find(n, j + len(n))
        return sorted((i, s, e) for (i, s), e in hits.items())

    def mask(self, text):
        text = fold(text)
        spans = self.line(text)
        out, last = [], 0
        for _, s, e in sorted(spans, key=lambda x: x[1]):
            if s < last:
                continue
            out.append(text[last:s])
            out.append('<NAME>')
            last = e
        out.append(text[last:])
        return ''.join(out)

    def blob(self, path, data):
        """[(lineno, rule, needle#)] for the content of one file; lineno 0 = whole blob."""
        out = []
        if len(data) > 60_000_000:
            return out
        if b'\0' in data[:8192]:
            low = data.lower()
            for idx, n in self.long:
                if n.encode() in low:
                    out.append((0, 'blob', idx))
            for s in binary_strings(data):
                for idx, _, _ in self.line(s, path):
                    out.append((0, 'blob-text', idx))
            return sorted(set(out))
        text = data.decode('utf-8', 'replace')
        for ln, line in enumerate(text.split('\n'), 1):
            for idx, _, _ in self.line(line, path):
                out.append((ln, 'name', idx))
            if len(line) >= 40 and self.long:
                for m in B64.finditer(line):
                    s = m.group().replace('-', '+').replace('_', '/')
                    s = s.rstrip('=')
                    s += '=' * (-len(s) % 4)
                    try:
                        dec = base64.b64decode(s).lower()
                    except (binascii.Error, ValueError):
                        continue
                    for idx, n in self.long:
                        if n.encode() in dec:
                            out.append((ln, 'base64', idx))
        return out


def binary_strings(data):
    """text held in a PNG text chunk or a JPEG APP1/COM segment."""
    out = []
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        pos = 8
        while pos + 8 <= len(data):
            ln, typ = struct.unpack('>I4s', data[pos:pos + 8])
            body = data[pos + 8:pos + 8 + ln]
            pos += 12 + ln
            try:
                if typ == b'tEXt':
                    out += [x.decode('latin-1') for x in body.split(b'\0')]
                elif typ == b'zTXt':
                    k, rest = body.split(b'\0', 1)
                    out += [k.decode('latin-1'), zlib.decompress(rest[1:]).decode('utf-8', 'replace')]
                elif typ == b'iTXt':
                    k, rest = body.split(b'\0', 1)
                    flag = rest[0]
                    rest = rest[2:]
                    _, rest = rest.split(b'\0', 1)
                    _, rest = rest.split(b'\0', 1)
                    out += [k.decode('latin-1'), (zlib.decompress(rest) if flag else rest).decode('utf-8', 'replace')]
                elif typ == b'eXIf':
                    out += [x.decode('latin-1') for x in re.findall(rb'[\x20-\x7e]{4,}', body)]
            except Exception:
                continue
    elif data[:2] == b'\xff\xd8':
        pos = 2
        while pos + 4 <= len(data) and data[pos] == 0xFF and data[pos + 1] != 0xDA:
            marker = data[pos + 1]
            ln = struct.unpack('>H', data[pos + 2:pos + 4])[0]
            seg = data[pos + 4:pos + 2 + ln]
            if marker in (0xE1, 0xFE, 0xED):
                out += [x.decode('latin-1') for x in re.findall(rb'[\x20-\x7e]{4,}', seg)]
            pos += 2 + ln
    return out


# ---------------------------------------------------------------- pathspec
def pathspec(args):
    pos, neg = [], []
    for a in args:
        if a.startswith(':!') or a.startswith(':^'):
            neg.append(a[2:])
        elif a.startswith(':(exclude)'):
            neg.append(a[len(':(exclude)'):])
        else:
            pos.append(a)

    def m(path, pat):
        pat = pat.rstrip('/')
        return path == pat or path.startswith(pat + '/') or fnmatch.fnmatchcase(path, pat)

    def ok(path):
        if pos and not any(m(path, p) for p in pos):
            return False
        return not any(m(path, p) for p in neg)
    return ok


def ls_tree(repo, rev, ok):
    out = git(repo, 'ls-tree', '-r', '-z', '--full-tree', rev).split(b'\0')
    ents = []
    for e in out:
        if not e:
            continue
        meta, path = e.split(b'\t', 1)
        mode, typ, oid = meta.decode().split()
        path = path.decode('utf-8', 'replace')
        if typ == 'blob' and ok(path):
            ents.append((path, oid, mode))
    return ents


def scan_tree(repo, rev, ok, S):
    """findings [(path, line, rule, needle#)]"""
    ents = ls_tree(repo, rev, ok)
    found = []
    for path, _, _ in ents:
        for idx, _, _ in S.line(path):
            found.append((path, 0, 'path', idx))
    oids = list(dict.fromkeys(o for _, o, _ in ents))
    bypath = {}
    for path, oid, _ in ents:
        bypath.setdefault(oid, []).append(path)
    for oid, typ, data in read_objects(repo, oids):
        if data is None:
            continue
        for path in bypath[oid]:
            for ln, rule, idx in S.blob(path, data):
                found.append((path, ln, rule, idx))
    return found


def load_exempt():
    """pathspecs in CoreMind/bin/names-ratchet-exempt.txt: ratchet runs ignore them, strict zero never does."""
    out = []
    try:
        for l in open(os.path.join(HERE, 'bin', 'names-ratchet-exempt.txt')):
            l = l.strip()
            if l and not l.startswith('#'):
                out.append(l)
    except OSError:
        pass
    return out


def ratchet_ok(spec):
    ex = load_exempt()
    base = pathspec(spec)
    if not ex:
        return base
    skip = pathspec([':!' + e for e in ex])
    return lambda path: base(path) and skip(path)


MARKER_DIR = None                      # self-test points this at a scratch dir, so the checkout's own marker is ignored


def strict_mode():
    marker = os.path.join(MARKER_DIR or HERE, 'bin', 'names-strict')
    return os.environ.get('MIND_NAMES_STRICT') == '1' or os.path.exists(marker)


# ---------------------------------------------------------------- literals
# An account-like id (a bare word) is a finding when it is the VALUE of a person key (owner, partner, createdBy, user,
# username, ...), an element of a person list (partners, members, KEEP), a key of a users map, a by= value, the
# <id> of records-<id>.json / prefs-<id>.json or the local part of an example.com address, unless it is a placeholder
# (CoreMind/bin/placeholder-ids.txt), a generic word, or built only from those. Syntactic non-literals are not values
# and are skipped: a subscript ($acc[$user] = ...), a typeof comparison, the field names of a record held by a
# singular key, a URL path segment (/users), an interpolated variable ($u@x.com), a URL password, a KEEP flag
# ($KEEP, ${KEEP:-0}, KEEP=1) or a trailing comment.
PH_FILE = os.path.join('bin', 'placeholder-ids.txt')
PH_TABLE = None
GENERIC = set('''admin root test tester user users username usernames system demo default guest unknown anonymous anon none
null undefined me self other others someone nobody x y z a b c id uid name names you noreply info support hello foo bar
baz person people persons tbd todo any all email mail account accounts member members role roles'''.split())
KEYS = (r'owners?|partners?|createdBy|updatedBy|seedAdmin|SEED_[A-Z_]+|members|personLists|users?|usernames?|'
        r'KEEP|people|persons?')
SINGULAR = ('owner', 'partner', 'createdby', 'updatedby', 'seedadmin', 'user', 'username', 'person')
KEEPKEY = 'KE' + 'EP'
KEYRX = re.compile(r'(?<![\w$/])\$?(' + KEYS + r')["\']?\]?\s*(=>|===?|!==?|:|=)(?![=>])\s*')
STR = re.compile(r'\'(?:[^\'\\\n]|\\.)*\'|"(?:[^"\\\n]|\\.)*"|[\[\]{}()]|[A-Za-z_]\w*(?=\s*(?:=>|:))')
IDSHAPE = re.compile(r'^[A-Za-z][A-Za-z0-9_.-]{1,40}$')
BYRX = re.compile(r'(?<![\w])by=["\']?([A-Za-z][\w.-]*)')
FILERX = re.compile(r'(?<![\w])(?:records|prefs)-([A-Za-z][A-Za-z0-9_.]*?)\.json')
MAILRX = re.compile(r'(?<![\w.+$\'-])([A-Za-z0-9._+\'-]+)@(?:example\.(?:com|org|net)|x\.com)(?![\w.-])')
SHELLVAL = re.compile(r'[A-Za-z][\w.-]*(?=[\s;&|,)"\'`}\]]|$)')
TYPEOF = re.compile(r'typeof\s*\(?\s*[\w$.\[\]?]*$')
URLPW = re.compile(r'://[^\s/@:]*:$')
PH_ENTRY = re.compile(r'^([a-z][a-z0-9_.-]{1,40})(?:\s+@\s+([^#]*?))?\s+#\s+(\S.*)$')


def parse_placeholders(src):
    """[(handle, globs|None, reason, line)] from placeholder-ids.txt.

    One entry per line: `handle  # why this is not a person` (valid everywhere) or `handle @ glob glob  # why`
    (valid only in paths that match a glob; * also crosses /). Blank lines and lines starting with # are comments.
    A malformed line is an error (exit 2) that names the line and never prints the handle."""
    out, seen = [], set()
    for n, raw in enumerate(src.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        m = PH_ENTRY.match(line)
        where = 'CoreMind/bin/placeholder-ids.txt:%d' % n
        if not m:
            raise Fail('%s: not `handle  # reason` or `handle @ glob...  # reason` (lowercase handle, 2-41 characters of a-z 0-9 _ . -)' % where)
        h, globs, reason = m.group(1), m.group(2), m.group(3).strip()
        if h[-1].isdigit():
            raise Fail('%s: register the stem; a trailing number is ignored when matching' % where)
        if h in seen:
            raise Fail('%s: registered twice' % where)
        if len(reason) < 12 or len(reason.split()) < 3:
            raise Fail('%s: the reason is too short (say what the handle stands for and where it is used)' % where)
        gl = None
        if globs is not None:
            gl = globs.split()
            if not gl:
                raise Fail('%s: `@` needs at least one path glob' % where)
        seen.add(h)
        out.append((h, gl, reason, n))
    return out


def placeholder_table():
    global PH_TABLE
    if PH_TABLE is None:
        with open(os.path.join(HERE, PH_FILE)) as f:
            PH_TABLE = parse_placeholders(f.read())
    return PH_TABLE


def placeholders(path=None):
    """the handles that are placeholders in this path: the global ones plus those scoped to a glob that matches it."""
    return {h for h, globs, _, _ in placeholder_table()
            if globs is None or (path and any(fnmatch.fnmatchcase(path, g) for g in globs))}


def placeholder_needle_hits(S):
    """[(line, needle#)] registry handles that are, or contain, a needle: a real id can never be registered."""
    return sorted({(ln, idx) for h, _, _, ln in placeholder_table() for idx, _, _ in S.line(h)})


def generic_id(v, ph):
    """True for a value that cannot be an account id: a placeholder, a generic word, or only such words joined by
    . _ - and/or ending in digits (guest2, no-reply, user_name, victim0)."""
    def word(s):
        s = s.rstrip('0123456789')
        return len(s) < 2 or s in ph or s in GENERIC
    return word(v) or all(word(s) for s in re.split(r'[._-]+', v) if s) or word(re.sub(r'[._-]+', '', v))


def keep_words(line):
    """the words KEEP is assigned on this line: a quoted shell list, a (...) array, a same-line [...] list or the
    first bare word (a trailing comment is not read; a list continued on later lines is not either)."""
    if line[:1] in ('"', "'"):
        return re.split(r'[\s,]+', line[1:].split(line[0])[0])
    if line[:1] in ('(', '[', '{'):
        return re.split(r'[\s,"\']+', line[1:].split({'(': ')', '[': ']', '{': '}'}[line[0]])[0])
    return re.findall(r'^[^\s;&|#"\'`]+', line)


def literal_ids(text, path=''):
    """[(line, rule, id)] account-like ids in person contexts that are neither placeholders nor generic."""
    ph = placeholders(path)
    found = []

    def add(off, rule, val):
        v = val.strip().strip('\'"').lower()
        if not IDSHAPE.match(v) or generic_id(v, ph):
            return
        found.append((text.count('\n', 0, off) + 1, rule, v))
    for m in KEYRX.finditer(text):
        key, op, a, end = m.group(1), m.group(2), m.start(), m.end()
        if a > 0 and text[a - 1] == '[' and text[m.end(1):m.end(1) + 1] == ']':
            continue                    # acc[$user] = ...: the id is the subscript, not a value
        if TYPEOF.search(text[max(text.rfind('\n', 0, a) + 1, a - 120):a]):
            continue                    # typeof user === 'string': a type name
        lk = key.lower()
        rule = 'literals/' + ('seed' if key.startswith('SEED_') else lk)
        rest = text[end:end + 4000]
        if key == KEEPKEY:
            if op != '=' or text[a:a + 1] == '$' or text[a - 1:a] == '{':
                continue                # $KEEP, ${KEEP:-0}, KEEP: -> a reference or a flag test, not an assignment
            eol = rest.find('\n')
            for w in keep_words(rest if eol < 0 else rest[:eol]):
                if w and not w.startswith('$'):
                    add(end, rule, w)
            continue
        if rest[:1] in ('\'', '"'):
            s = STR.match(rest)
            if s:
                add(end, rule, s.group()[1:-1])
            continue
        if op == '=' and re.search(r'\S=$', m.group()):
            bare = SHELLVAL.match(rest)         # owner=<id>, username=<id>: a shell, env or query assignment
            if bare:
                add(end, rule, bare.group())
                continue
        if rest[:6] == 'array(':
            rest = rest[5:]
        if rest[:1] not in ('[', '{', '('):
            continue
        keys_only = lk in ('users', 'usernames')
        singular = lk in SINGULAR or key.startswith('SEED_')
        depth = 0
        for t in STR.finditer(rest):
            g = t.group()
            if g in '[{(':
                depth += 1
            elif g in ']})':
                depth -= 1
                if depth <= 0:
                    break
            elif g[0] in '\'"':
                after = rest[t.end():t.end() + 4].lstrip()
                is_key = after.startswith('=>') or after.startswith(':')
                if keys_only and not (is_key and depth == 1):
                    continue
                if not keys_only and is_key and (depth > 1 or singular):
                    continue            # a field name of a record, not an id
                add(end + t.start(), rule, g[1:-1])
            elif keys_only and depth == 1:
                add(end + t.start(), rule, g)
    for m in BYRX.finditer(text):
        add(m.start(), 'literals/by', m.group(1))
    for m in FILERX.finditer(text):
        add(m.start(), 'literals/file', m.group(1))
    for m in MAILRX.finditer(text):
        s = m.start(1)
        if URLPW.search(text[max(0, s - 200):s]):
            continue                    # scheme://user:password@example.com
        add(s, 'literals/mail', m.group(1).lstrip('\'').split('+')[0])
    return found


def scan_literals(repo, rev, ok, S=None):
    found = []
    ents = ls_tree(repo, rev, ok)
    for path, _, _ in ents:
        for ln, rule, v in literal_ids(path, path):
            found.append((path, 0, rule, v))
    bypath = {}
    for path, oid, _ in ents:
        bypath.setdefault(oid, []).append(path)
    for oid, typ, data in read_objects(repo, list(bypath)):
        if data is None or b'\0' in data[:8192] or len(data) > 4_000_000:
            continue
        text = data.decode('utf-8', 'replace')
        for path in bypath[oid]:
            for ln, rule, v in literal_ids(text, path):
                found.append((path, ln, rule, v))
    return found


# ---------------------------------------------------------------- commands
def need_s(optional_ok=True):
    ns = load_needles()
    if ns is None:
        if optional_ok and os.environ.get('MIND_NAMES_OPTIONAL') == '1':
            return None
        raise Fail('no needle list (run CoreMind/bin/needles-init.sh, or set MIND_NEEDLES)')
    return Matcher(ns, load_allow(needle_path()))


def resolve(repo, rev):
    if rev == 'auto':
        for ref in ('main', 'origin/main'):
            r = subprocess.run(['git', '-C', repo, 'merge-base', 'HEAD', ref], capture_output=True, env=ENV)
            if r.returncode != 0 or not r.stdout.strip():
                continue
            base = r.stdout.decode().strip()
            head = git(repo, 'rev-parse', 'HEAD').decode().strip()
            if base == head:        # on main itself: compare with the previous commit, never with itself
                r = subprocess.run(['git', '-C', repo, 'rev-parse', '--verify', '-q', 'HEAD^'], capture_output=True, env=ENV)
                if r.returncode == 0 and r.stdout.strip():
                    return r.stdout.decode().strip()
            return base
        raise Fail('--ratchet auto: no main branch to compare with (pass --ratchet REV)')
    return rev


def parse_opts(args):
    ratchet, files_only, spec = None, False, []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--':
            spec = args[i + 1:]
            break
        if a == '--ratchet':
            i += 1
            if i >= len(args):
                raise Fail('--ratchet needs a revision')
            ratchet = args[i]
        elif a == '--files-only':
            files_only = True
        else:
            raise Fail('unknown argument')
        i += 1
    return ratchet, files_only, spec


def report(S, found, files_only=False):
    seen = sorted(set(found))
    if files_only:
        for p in sorted({f[0] for f in seen}):
            print(S.mask(p))
        return
    for path, ln, rule, idx in seen:
        print('  FAIL %s:%d - names/%s #%d' % (S.mask(path), ln, rule, idx))


def cmd_tree(args):
    ratchet, files_only, spec = parse_opts(args)
    S = need_s()
    if S is None:
        print('check-names tree: skipped (no needle list)')
        return 0
    repo = toplevel(CALLER)
    ok = pathspec(spec)
    if ratchet is not None and not strict_mode():
        ok = ratchet_ok(spec)
    head = scan_tree(repo, 'HEAD', ok, S)
    if ratchet is not None and not strict_mode():
        bref = resolve(repo, ratchet)
        base = scan_tree(repo, bref, ok, S)
        a, b = Counter(f[3] for f in base), Counter(f[3] for f in head)
        rose = sorted(i for i in b if b[i] > a.get(i, 0))
        for i in rose:
            print('  FAIL tree ratchet - needle #%d rose from %d to %d' % (i, a.get(i, 0), b[i]))
        print('check-names tree: ratchet against %s (%s), %d hit(s) at HEAD, %d at base, %d needle(s) rose' %
              (ratchet, bref[:12], len(head), len(base), len(rose)))
        return 1 if rose else 0
    report(S, head, files_only)
    print('check-names tree: %d needle(s), %d hit(s) in %d file(s)' % (len(S.needles), len(head), len({f[0] for f in head})))
    return 1 if head else 0


def cmd_literals(args):
    ratchet, _, spec = parse_opts(args)
    repo = toplevel(CALLER)
    ok = pathspec(spec)
    if ratchet is not None and not strict_mode():
        ok = ratchet_ok(spec)
    head = scan_literals(repo, 'HEAD', ok)
    ns = load_needles()
    S = Matcher(ns, load_allow(needle_path())) if ns else None
    mp = S.mask if S else (lambda x: x)
    bad = placeholder_needle_hits(S) if S else []      # a registered handle that is a needle: never allowed
    for ln, idx in bad:
        print('  FAIL CoreMind/bin/placeholder-ids.txt:%d - names/placeholder #%d' % (ln, idx))
    if ratchet is not None and not strict_mode():
        bref = resolve(repo, ratchet)
        base = scan_literals(repo, bref, ok)
        a, b = Counter(f[3] for f in base), Counter(f[3] for f in head)
        rose = [(v, b[v] - a.get(v, 0)) for v in b if b[v] > a.get(v, 0)]
        if rose:
            risen = {v for v, _ in rose}
            for p, ln, rule, v in sorted(set(head)):
                if v in risen:
                    print('  FAIL %s:%d - %s' % (mp(p), ln, rule))
        print('check-names literals: ratchet against %s (%s), %d literal(s) at HEAD, %d at base, %d id(s) rose, %d registered handle(s) are needles' %
              (ratchet, bref[:12], len(head), len(base), len(rose), len(bad)))
        return 1 if rose or bad else 0
    for p, ln, rule, v in sorted(set(head)):
        print('  FAIL %s:%d - %s' % (mp(p), ln, rule))
    print('check-names literals: %d finding(s)%s' % (len(head), ', %d registered handle(s) are needles' % len(bad) if bad else ''))
    return 1 if head or bad else 0


def hits_of_blob(S, path, data):
    c = Counter()
    for _, _, idx in S.blob(path, data):
        c[idx] += 1
    return c


def cmd_staged(args):
    S = need_s()
    if S is None:
        print('check-names staged: skipped (no needle list)')
        return 0
    repo = toplevel(os.getcwd() if os.environ.get('GIT_DIR') else CALLER)
    raw = git(repo, 'diff', '--cached', '--raw', '-z', '-M', '--no-abbrev').split(b'\0')
    ents, i = [], 0
    while i < len(raw) and raw[i]:
        meta = raw[i].decode().lstrip(':').split()
        st = meta[4][0]
        n = 2 if st in 'RC' else 1
        paths = [p.decode('utf-8', 'replace') for p in raw[i + 1:i + 1 + n]]
        ents.append((meta[0], meta[1], meta[2], meta[3], st, paths))
        i += 1 + n
    zero = lambda o: ZERO.match(o)
    oids = set()
    for om, nm, oo, no, st, _ in ents:
        for m, o in ((om, oo), (nm, no)):
            if m != '160000' and not zero(o):
                oids.add(o)
    data = {o: d for o, t, d in read_objects(repo, sorted(oids)) if d is not None}
    net, bad, strict = Counter(), [], strict_mode() or os.environ.get('MIND_NAMES_STRICT') == '1'
    exempt = (lambda p: True) if strict else ratchet_ok([])
    for om, nm, oo, no, st, paths in ents:
        old_path, new_path = paths[0], paths[-1]
        if not exempt(new_path) and not exempt(old_path):
            continue
        cnew, cold = Counter(), Counter()
        if nm != '160000' and not zero(no) and no in data:
            cnew = hits_of_blob(S, new_path, data[no])
        if om != '160000' and not zero(oo) and oo in data:
            cold = hits_of_blob(S, old_path, data[oo])
        if st in 'ARCT' and st != 'T' or st == 'R' or st == 'C':
            for idx, _, _ in S.line(new_path):
                cnew[idx] += 1
                if st in 'AC':
                    bad.append((new_path, 0, 'added-path', idx))
        if st in 'DR':
            for idx, _, _ in S.line(old_path):
                cold[idx] += 1
        for idx in set(cnew) | set(cold):
            d = cnew[idx] - cold[idx]
            net[idx] += d
            if d > 0 or (strict and cnew[idx] > 0):
                for ln, rule, x in S.blob(new_path, data.get(no, b'')) if no in data else []:
                    if x == idx:
                        bad.append((new_path, ln, rule, idx))
    rose = sorted(i for i, v in net.items() if v > 0)
    if strict:
        for p, ln, rule, idx in sorted(set(bad)):
            print('  FAIL %s:%d - names/%s #%d' % (S.mask(p), ln, rule, idx))
        return 1 if bad else 0
    for p, ln, rule, idx in sorted(set(bad)):
        if rule == 'added-path' or idx in rose:
            print('  FAIL %s:%d - names/%s #%d' % (S.mask(p), ln, rule, idx))
    for idx in rose:
        print('  FAIL staged - needle #%d net +%d' % (idx, net[idx]))
    failed = bool(rose) or any(r == 'added-path' for _, _, r, _ in bad)
    print('check-names staged: %d file(s), %d needle(s) rose' % (len(ents), len(rose)))
    return 1 if failed else 0


def known_paths(repo):
    out = set()
    for args in (['diff', '--cached', '--no-renames', '--name-only', '-z'],
                 ['ls-files', '-z', '-m', '-d', '-o', '--exclude-standard']):
        try:
            out.update(p for p in git(repo, *args).decode('utf-8', 'replace').split('\0') if p)
        except Fail:
            pass
    return out


def template_listing(line, known):
    """a '#<TAB>modified:   path' line of git's own editor template naming paths that really exist in the change."""
    if not line.startswith('#\t'):
        return False
    rest = line[2:].strip()
    m = re.match(r'^[a-z][a-z ]*:\s+(.*)$', rest)
    if m:
        rest = m.group(1)
    parts = rest.split(' -> ')
    return all(p.strip() in known for p in parts)


def cmd_message(args):
    if len(args) != 1:
        raise Fail('message needs a file')
    S = need_s()
    if S is None:
        print('check-names message: skipped (no needle list)')
        return 0
    path = args[0] if os.path.isabs(args[0]) else os.path.join(CALLER, args[0])
    try:
        text = open(path, encoding='utf-8', errors='replace').read()
    except OSError:
        raise Fail('cannot read the message file')
    found, known = [], None
    for ln, line in enumerate(text.split('\n'), 1):
        # '#' lines stay in the stored message with -m / -F (cleanup=whitespace), so they are read too; only git's own
        # editor-template file listings (paths in the change, checked as paths elsewhere) are let through.
        if line.startswith('#\t'):
            if known is None:
                known = known_paths(toplevel(CALLER))
            if template_listing(line, known):
                continue
        for idx, _, _ in S.line(line):
            found.append(('message', ln, 'message', idx))
    report(S, found)
    print('check-names message: %d hit(s)' % len(found))
    return 1 if found else 0


def history(repo, revargs, S):
    if not revargs:
        raise Fail('history needs a revision')
    found = []
    log = git(repo, 'log', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x01', *revargs).decode('utf-8', 'replace')
    ncommits = 0
    for rec in log.split('\x01'):
        rec = rec.strip('\n')
        if not rec:
            continue
        ncommits += 1
        parts = rec.split('\0')
        sha_, fields = parts[0][:12], parts[1:5]
        msg = '\0'.join(parts[5:])
        for what, val in zip(('author', 'author', 'committer', 'committer'), fields):
            for idx, _, _ in S.line(val):
                found.append(('commit ' + sha_, 0, what, idx))
        for ln, line in enumerate(msg.split('\n'), 1):
            for idx, _, _ in S.line(line):
                found.append(('commit ' + sha_, ln, 'message', idx))
    names = set()
    for a in revargs:
        if a in ('--all', '--branches', '--tags', '--remotes') or a.startswith(('--remotes=', '--branches=', '--tags=', '--glob=')):
            out = git(repo, 'for-each-ref', '--format=%(refname)').decode('utf-8', 'replace').split('\n')
            names.update(x for x in out if x)
        elif not a.startswith('-'):
            r = subprocess.run(['git', '-C', repo, 'rev-parse', '--symbolic-full-name', a], capture_output=True, env=ENV)
            n = r.stdout.decode('utf-8', 'replace').strip()
            if n.startswith('refs/'):
                names.add(n)
    for n in sorted(names):
        for idx, _, _ in S.line(n):
            found.append(('ref ' + n, 0, 'refname', idx))
    objs = git(repo, 'rev-list', '--objects', *revargs).decode('utf-8', 'replace').split('\n')
    first, paths = {}, set()
    for l in objs:
        if not l:
            continue
        oid, _, path = l.partition(' ')
        first.setdefault(oid, path)
        if path:
            paths.add(path)
    for p in sorted(paths):
        for idx, _, _ in S.line(p):
            found.append((p, 0, 'path', idx))
    for oid, typ, data in read_objects(repo, list(first)):
        if data is None:
            continue
        if typ == 'blob':
            for ln, rule, idx in S.blob(first[oid], data):
                found.append((first[oid] or 'blob ' + oid[:12], ln, rule, idx))
        elif typ == 'tag':
            for ln, line in enumerate(data.decode('utf-8', 'replace').split('\n'), 1):
                for idx, _, _ in S.line(line):
                    found.append(('tag ' + oid[:12], ln, 'tag', idx))
    return found, ncommits, len(first)


def cmd_history(args, repo=None):
    S = need_s()
    if S is None:
        print('check-names history: skipped (no needle list)')
        return 0
    repo = repo or toplevel(CALLER)
    found, nc, no = history(repo, args, S)
    report(S, found)
    print('check-names history: %d commit(s), %d object(s), %d hit(s)' % (nc, no, len(found)))
    return 1 if found else 0


def cmd_mirror(args):
    if len(args) != 1 or not os.path.isdir(args[0]):
        raise Fail('mirror needs a directory')
    return cmd_history(['--all'], os.path.abspath(args[0]))


def main(argv):
    if not argv:
        print(__doc__ if False else 'usage: check-names.sh tree|literals|staged|message|history|mirror|--self-test', file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    try:
        fn = {'tree': cmd_tree, 'literals': cmd_literals, 'staged': cmd_staged, 'message': cmd_message,
              'history': cmd_history, 'mirror': cmd_mirror}.get(cmd)
        if fn is None:
            raise Fail('unknown command')
        return fn(rest)
    except Fail as e:
        print('check-names: %s' % e, file=sys.stderr)
        return 2


# ---------------------------------------------------------------- self test
def self_test():
    global ENV, CALLER, HERE, PH_TABLE, MARKER_DIR
    import io, contextlib
    ok_all = True
    root = tempfile.mkdtemp(prefix='checknames.')
    MARKER_DIR = os.path.join(root, 'marker')
    ENV = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    ENV.update({'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_SYSTEM': os.devnull, 'GIT_AUTHOR_NAME': 'Tester',
                'GIT_AUTHOR_EMAIL': 't@example.com', 'GIT_COMMITTER_NAME': 'Tester', 'GIT_COMMITTER_EMAIL': 't@example.com'})
    nf = os.path.join(root, 'needles.txt')
    open(nf, 'w').write('zqx\nquorvane\n')
    saved = {k: os.environ.get(k) for k in ('MIND_NEEDLES', 'MIND_NEEDLE_ALLOW', 'MIND_NAMES_OPTIONAL', 'MIND_NAMES_STRICT')}
    for k in saved:
        os.environ.pop(k, None)
    os.environ['MIND_NEEDLES'] = nf
    os.environ['MIND_NEEDLE_ALLOW'] = os.path.join(root, 'none.sha256')
    repo = os.path.join(root, 'r')
    os.makedirs(repo)

    def g(*a):
        return subprocess.run(['git', '-C', repo] + list(a), capture_output=True, env=ENV, check=True).stdout.decode()

    def cli(*a):
        buf, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(err):
            rc = main(list(a))
        return rc, buf.getvalue() + err.getvalue()

    def check(name, good):
        nonlocal ok_all
        ok_all = ok_all and bool(good)
        print('  %s %s' % ('ok  ' if good else 'FAIL', name))

    fake = {'@1@': 'zor' + 'bin', '@2@': 'pli' + 'mk', '@3@': 'tav' + 'rel', '@4@': 'oss' + 'gar', '@5@': 'nu' + 'vik', '@6@': 'bre' + 'lt'}

    def put(path, content, mode='w'):
        for k, v in fake.items():
            content = content.replace(k, v)
        fp = os.path.join(repo, path)
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        open(fp, mode).write(content)

    def commit(msg):
        g('add', '-A')
        g('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', msg)

    RZ = 'records-zq' + 'x.json'
    g('init', '-q', '-b', 'main')
    CALLER = repo
    M = Matcher(['zqx', 'quorvane'])

    def n(text):
        return len(M.line(text))
    # matcher
    for name, text, want in [
        ('title case', 'Hello Zqx today', 1), ('upper case', 'by ZQX', 1), ('lower case', 'ask zqx', 1),
        ('possessive', "Zqx's list", 1), ('plural', 'two zqxs here', 1), ('camelCase', 'let byZqx = 1', 1),
        ('upper-case plural', 'ZQXs', 1), ('glued', 'zqxsbookshelf', 1), ('snake', 'owner_zqx_list', 1),
        ('digits split', 'x9zqx', 1), ('AWS-prefix-like uppercase', 'QWRTZQX7SAMPLE', 1),
        ('hyphenated', 'the-zqx-page', 1), ('mid-word is clean', 'azqxb and bazqxo', 0),
        ('long needle inside a word', 'myQuorvaneFoo', 1), ('long needle possessive', "Quorvane's", 1),
        ('long needle upper', 'QUORVANE', 1), ('clean text', 'nothing to see', 0)]:
        check('matcher: ' + name, n(text) == want)
    ma = Matcher(['zqx', 'quorvane'], {sha('zqx'), sha('p.txt\0keep quorvane here')})
    check('allowlist: token', ma.line('zqx here') == [] and len(ma.line('zqx and quorvane')) == 1)
    check('allowlist: path NUL line', ma.line('keep quorvane here', 'p.txt') == [] and len(ma.line('keep quorvane here', 'q.txt')) == 1)
    b64 = base64.b64encode(b'padding padding quorvane padding').decode()
    check('base64 run decoded for long needles', any(r == 'base64' for _, r, _ in M.blob('f', ('x = "%s"\n' % b64).encode())))
    # PNG text chunks
    def chunk(t, b):
        return struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + \
        chunk(b'zTXt', b'Author\0\0' + zlib.compress(b'by Zqx')) + chunk(b'IEND', b'')
    check('PNG zTXt chunk hit (short needle)', any(r == 'blob-text' for _, r, _ in M.blob('i.png', png)))
    png2 = b'\x89PNG\r\n\x1a\n' + chunk(b'tEXt', b'Comment\0quorvane') + chunk(b'IEND', b'')
    check('PNG tEXt chunk hit (long needle)', len(M.blob('i.png', png2)) >= 1)
    check('clean PNG passes', M.blob('i.png', b'\x89PNG\r\n\x1a\n' + chunk(b'tEXt', b'Comment\0hello') + chunk(b'IEND', b'')) == [])
    # repository cases
    put('README.md', 'clean\n')
    put('src/a.txt', 'one\ntwo\n')
    put(RZ, '{}\n')
    put('old/list.txt', 'owner zqx here\nquorvane too\n')
    commit('base')
    g('branch', 'base')
    rc, out = cli('tree')
    check('tree reports hits and exits 1', rc == 1 and 'records-<NAME>.json' in out and '#1' in out and '#2' in out)
    check('output never carries a needle', 'zqx' not in out.lower() and 'quorvane' not in out.lower())
    rc, out = cli('literals', '--', 'records-*')
    check('literals: a path with a needle is printed as <NAME>', rc == 1 and 'zqx' not in out.lower() and '<NAME>' in out)
    rc, out = cli('tree', '--files-only', '--', 'old')
    check('tree --files-only with a pathspec', rc == 1 and out.splitlines()[0] == 'old/list.txt')
    rc, out = cli('tree', '--', 'src', ':!src/zzz')
    check('tree over a clean pathspec is 0', rc == 0)
    g('mv', 'old/list.txt', 'new_list.txt')
    commit('move')
    rc, _ = cli('tree', '--ratchet', 'base')
    check('ratchet: git mv keeps counts equal', rc == 0)
    g('checkout', '-q', '-b', 'copy', 'base')
    put('copy.txt', 'owner zqx here\nquorvane too\n')
    commit('copy only')
    rc, out = cli('tree', '--ratchet', 'base')
    check('ratchet: a copy raises counts', rc == 1 and 'rose' in out)
    os.makedirs(os.path.join(MARKER_DIR, 'bin'))
    open(os.path.join(MARKER_DIR, 'bin', 'names-strict'), 'w').close()
    check('marker: bin/names-strict turns a ratchet run strict', cli('tree', '--ratchet', 'HEAD')[0] == 1)
    os.remove(os.path.join(MARKER_DIR, 'bin', 'names-strict'))
    check('marker: without it the same run is a ratchet', cli('tree', '--ratchet', 'HEAD')[0] == 0)
    exdir = os.path.join(root, 'ex')
    os.makedirs(os.path.join(exdir, 'bin'))
    open(os.path.join(exdir, 'bin', 'names-ratchet-exempt.txt'), 'w').write('# copy\ncopy.txt\n')
    real_here, HERE = HERE, exdir
    rc, out = cli('tree', '--ratchet', 'base')
    check('ratchet: an exempt path is not counted', rc == 0)
    os.environ['MIND_NAMES_STRICT'] = '1'
    check('ratchet: strict ignores the exemption', cli('tree', '--', 'copy.txt')[0] == 1)
    del os.environ['MIND_NAMES_STRICT']
    HERE = real_here
    g('rm', '-q', 'old/list.txt')
    commit('delete original')
    rc, _ = cli('tree', '--ratchet', 'base')
    check('ratchet: copy then delete is level again', rc == 0)
    g('checkout', '-q', 'main')
    # staged
    put('src/a.txt', 'one\ntwo\nhello Zqx\n')
    g('add', 'src/a.txt')
    rc, out = cli('staged')
    check('staged: an added hit fails', rc == 1 and 'zqx' not in out.lower())
    g('reset', '-q')
    g('checkout', '--', 'src/a.txt')
    g('mv', 'new_list.txt', 'moved.txt')
    rc, _ = cli('staged')
    check('staged: a move has net zero', rc == 0)
    g('reset', '-q', '--hard')
    put('zqx-notes.txt', 'x\n')
    g('add', 'zqx-notes.txt')
    rc, out = cli('staged')
    check('staged: an added path with a hit fails', rc == 1 and '<NAME>' in out)
    g('reset', '-q', '--hard')
    os.remove(os.path.join(repo, 'zqx-notes.txt')) if os.path.exists(os.path.join(repo, 'zqx-notes.txt')) else None
    put('new_list.txt', 'owner x here\nclean\n')
    g('add', 'new_list.txt')
    rc, _ = cli('staged')
    check('staged: removing hits is allowed', rc == 0)
    g('reset', '-q', '--hard')
    os.environ['MIND_NAMES_STRICT'] = '1'
    put('src/a.txt', 'one\n')
    g('add', 'src/a.txt')
    rc, _ = cli('staged')
    check('staged: strict passes a clean change', rc == 0)
    put('moved2.txt', 'zqx\n')
    g('add', 'moved2.txt')
    rc, _ = cli('staged')
    check('staged: strict refuses any hit', rc == 1)
    del os.environ['MIND_NAMES_STRICT']
    g('reset', '-q', '--hard')
    # message
    mf = os.path.join(root, 'm.txt')
    open(mf, 'w').write('fix the Zqx list\n# comment mentioning quorvane\n')
    rc, out = cli('message', mf)
    check('commit-msg: a hit is rejected, # lines are read too', rc == 1 and '#1' in out and '#2' in out and 'zqx' not in out.lower())
    open(mf, 'w').write('fix the owner list\n')
    check('commit-msg: a clean message passes', cli('message', mf)[0] == 0)
    open(mf, 'w').write('#167 fix the Zqx list\n')
    rc, out = cli('message', mf)
    check('commit-msg: a ticket-style first line is read', rc == 1 and '#1' in out)
    open(os.path.join(repo, 'rel-msg.txt'), 'w').write('fix the owner list\n')
    check('commit-msg: a relative path resolves against the caller', cli('message', 'rel-msg.txt')[0] == 0)
    open(os.path.join(repo, 'rel-msg.txt'), 'w').write('fix the Zqx list\n')
    check('commit-msg: a relative path with a hit fails', cli('message', 'rel-msg.txt')[0] == 1)
    os.remove(os.path.join(repo, 'rel-msg.txt'))
    tpl = os.path.join(root, 'tpl.txt')
    open(tpl, 'w').write('fix the owner list\n\n# Please enter the commit message\n#\tmodified:   src/a.txt\n')
    check('commit-msg: editor template path listings pass', cli('message', tpl)[0] == 0)
    # history-only hit
    put('gone.txt', 'quorvane\n')
    commit('add old hit')
    g('rm', '-q', 'gone.txt')
    commit('remove old hit')
    g('rm', '-q', '-r', 'old', RZ, 'copy.txt', 'moved.txt', 'new_list.txt', '--ignore-unmatch')
    for p in ('old', 'new_list.txt', 'moved.txt', RZ, 'copy.txt'):
        pass
    g('add', '-A')
    subprocess.run(['git', '-C', repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'clean tree', '--allow-empty'], env=ENV)
    rc, _ = cli('tree')
    check('history: the tree itself is clean', rc == 0)
    rc, out = cli('history', 'HEAD')
    check('history: a hit only in an old commit fails', rc == 1 and 'zqx' not in out.lower() and 'quorvane' not in out.lower())
    g('checkout', '-q', '--orphan', 'fresh')
    g('rm', '-q', '-rf', '.')
    put('x.txt', 'ok\n')
    commit('one root')
    check('history: a clean root commit passes', cli('history', 'HEAD')[0] == 0)
    g('tag', '-a', '-m', 'release Zqx', 'v1')
    rc, out = cli('history', 'refs/tags/v1')
    check('history: an annotated tag message is scanned', rc == 1)
    g('tag', '-d', 'v1')
    g('branch', 'zqx-branch')
    rc, out = cli('history', '--all')
    check('history: --all covers old commits and ref names', rc == 1 and 'zqx' not in out.lower())
    mir = os.path.join(root, 'mir.git')
    subprocess.run(['git', 'clone', '-q', '--mirror', repo, mir], env=ENV, check=True)
    rc, out = cli('mirror', mir)
    check('mirror: scans every ref', rc == 1 and 'zqx' not in out.lower())
    # accents and invisible characters
    check('matcher: accented needle', n('Quorvan\u00e9') == 1 and n('quorvane\u0301') == 1 and n('QUORVAN\u00c9S') == 1)
    check('matcher: zero-width split', n('zq\u200bx') == 1)
    check('matcher: accent fold keeps clean text clean', n('caf\u00e9 r\u00e9sum\u00e9') == 0)
    # auto ratchet needs a main branch
    nm = os.path.join(root, 'nomain')
    os.makedirs(nm)
    subprocess.run(['git', '-C', nm, 'init', '-q', '-b', 'trunk'], env=ENV, check=True)
    open(os.path.join(nm, 'f.txt'), 'w').write('x\n')
    subprocess.run(['git', '-C', nm, 'add', '-A'], env=ENV, check=True)
    subprocess.run(['git', '-C', nm, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one'], env=ENV, check=True)
    keep_caller, CALLER = CALLER, nm
    check('ratchet auto: no main exits 2', cli('tree', '--ratchet', 'auto')[0] == 2)
    CALLER = keep_caller
    # fail closed
    os.environ['MIND_NEEDLES'] = os.path.join(root, 'nonexistent')
    for c in (('staged',), ('message', mf), ('history', 'HEAD'), ('tree',)):
        check('no needle list: %s exits 2' % c[0], cli(*c)[0] == 2)
    os.environ['MIND_NAMES_OPTIONAL'] = '1'
    rc, out = cli('tree')
    check('CI mode: tree says skipped and exits 0', rc == 0 and 'skipped' in out)
    del os.environ['MIND_NAMES_OPTIONAL']
    os.environ['MIND_NEEDLES'] = nf
    # literals
    put('lit/a.php', "<?php\n$cfg = ['owners' => ['alex'], 'users' => [\n  'sam' => ['x' => 1],\n  '@1@' => ['y' => 2],\n]];\n")
    put('lit/b.ts', "const c = { createdBy: 'sam', partner: 'both', updatedBy: '@2@' };\nsend('bob@example.com'); send('@3@@example.com');\n")
    put('lit/c.sh', 'KEEP="alex sam @4@"\ncurl "x?by=alex&by=@5@" records-@6@.json records-alex.json\n')
    commit('literals')
    rc, out = cli('literals', '--', 'lit')
    check('literals: six non-placeholder ids found', rc == 1 and out.count('FAIL') == 6)
    check('literals: findings carry no id', all(x not in out for x in fake.values()))
    rc, out = cli('literals', '--', 'src', 'README.md')
    check('literals: clean files pass', rc == 0)
    # literals, calibrated: what must still fire, what is a syntactic non-literal, the placeholder registry
    fake.update({'@7@': 'dra' + 'vik', '@8@': 'mel' + 'zor', '@9@': 'fen' + 'tra', '@10@': 'kol' + 'bret', '@11@': 'vex' + 'lin',
                 '@12@': 'tor' + 'mak', '@13@': 'quen' + 'lo', '@14@': 'sab' + 'ruk', '@15@': 'wen' + 'dro', '@16@': 'hal' + 'vek',
                 '@17@': 'pel' + 'drix', '@18@': 'gar' + 'moth'})
    ph_dir = os.path.join(root, 'ph')
    os.makedirs(os.path.join(ph_dir, 'bin'))
    reg = os.path.join(ph_dir, 'bin', 'placeholder-ids.txt')
    open(reg, 'w').write('# test registry\nalex   # the owner placeholder in the fixtures\nsam    # the partner placeholder in the fixtures\n'
                         'bob    # a third placeholder person in the fixtures\nviewer # member role value in the fixtures\n'
                         'locky  # throwaway account of the lockout tests\nghost  @ neg/vend/* # dummy name used by a vendored example\n')
    put('pos/login.php', "<?php\n$r = api(['action' => 'login', 'username' => '@7@', 'password' => 'x']);\n$cfg['owner'] = '@8@';\n"
                         "$rec = ['user' => ['id' => '@9@', 'displayName' => 'X']];\n$q = 'to=@10@+tag@example.com';\n"
                         "$z = ['username' => 'ghost'];\n$acc[$user] = ['createdBy' => '@17@'];\n")
    put('pos/login.ts', "await login({ username: '@11@', password: 'x' });\nconst owner = '@12@';\n"
                        "const c = { createdBy: 'sam', partners: ['alex', '@13@'] };\nif (typeof user === 'string') partner = '@18@';\n")
    put('pos/login.sh', 'username="@14@"\nowner=@15@ run\nKEEP=\'alex @16@\'\n')
    put('neg/a.php', "<?php\n$acc[$user] = ['email' => $email, 'hash' => $hash, 'created' => time()];\n"
                     "$users[$username] = ['password' => $pw, 'email' => $e];\n$st[$user] = ['state' => 'pending'];\n"
                     "$w = ['user' => ['id' => b64u($user), 'name' => $user, 'displayName' => $user]];\n"
                     "$m = \"$nickname@x.com\"; $n = \"{$id}@example.com\";\n"
                     "foreach (['guest2@example.com', 'no-reply@example.com', 'a..b@example.com', \"o'x@example.com\", 'guest+tag@example.com'] as $a) {}\n"
                     "$u = 'https://alice:@7@@example.com/work.ics';\n"
                     "$r = ['username' => 'locky', 'to' => 'locky3@example.com', 'by' => 'locky', 'user_name' => 'x'];\n")
    put('neg/b.ts', "if (typeof s.username !== 'string' || typeof user === 'object') return;\nconst routes = { '/users': { get: 1, post: 2 } };\n"
                    "acc[user] = { hash: 1, created: 2 }; st[owner] = 'pending';\n"
                    "const g = { owner: 'alex', partner: 'sam', members: [{ id: 'bob', role: 'viewer' }], users: { alex: { n: 1 } } };\n")
    put('neg/c.sh', '#   KEEP=1 sh tools/x.sh     keep the simulator and logs\n[ "${KEEP:-0}" != 1 ] || rm -rf "$OUT"\n[ "$KEEP" = yes ] && echo kept\n'
                    'KEEP=5   # keep the last 5 builds, @7@ asked for it\nuser=$USER; owner=$(whoami); user=root; owner="$1"\n')
    put('neg/vend/e.md', '{"username": "ghost"}\n')
    commit('literals calibrated')
    real_here, HERE = HERE, ph_dir
    PH_TABLE = None
    rc, out = cli('literals', '--', 'pos')
    check('literals: a real-looking id as a login value fires in PHP, TS and shell forms', rc == 1 and out.count('FAIL') == 13 and
          all('literals/%s' % r in out for r in ('username', 'owner', 'user', 'mail', 'partners', 'keep')))
    check('literals: the PHP, TS and shell positives fire one by one',
          [out.count('pos/login.%s' % e) for e in ('php', 'ts', 'sh')] == [6, 4, 3])
    check('literals: a plus-tagged address and a scoped handle outside its scope still fire', 'pos/login.php:5 - literals/mail' in out and 'pos/login.php:6' in out)
    check('literals: a negative context beside a real-looking id (a subscript, a typeof) does not hide it',
          'pos/login.php:7 - literals/createdby' in out and 'pos/login.ts:4 - literals/partner' in out)
    check('literals: calibrated findings carry no id', all(x not in out for x in fake.values()))
    rc, out = cli('literals', '--', 'neg')
    check('literals: subscripts, typeof, record fields, paths, interpolation, URL passwords, KEEP flags and registered handles pass', rc == 0)
    rc, out = cli('literals', '--', 'neg', 'pos/login.sh')
    check('literals: the calibrated negatives do not hide the positives beside them', rc == 1 and out.count('FAIL') == 3)
    PH_TABLE = None
    open(reg, 'a').write('zqx    # synthetic needle registered on purpose to prove the guard\n')
    rc, out = cli('literals', '--', 'neg')
    check('literals: a registered handle that is a needle fails, unnamed', rc == 1 and 'names/placeholder #1' in out and 'zqx' not in out.lower().replace('names/placeholder', ''))
    rc, out = cli('literals', '--ratchet', 'HEAD', '--', 'neg')
    check('literals: a registered needle fails under the ratchet too', rc == 1 and 'names/placeholder' in out)
    HERE = real_here
    PH_TABLE = None

    def bad_registry(src):
        try:
            parse_placeholders(src)
        except Fail as e:
            return 'kelvorx' not in str(e) and 'placeholder-ids.txt:' in str(e)
        return False
    check('registry: an entry without a reason is refused', bad_registry('kelvorx\n'))
    check('registry: a reason of fewer than three words is refused', bad_registry('kelvorx  # too short\n'))
    check('registry: an uppercase handle, a trailing number and a duplicate are refused',
          bad_registry('Kelvorx  # not lowercase at all\n') and bad_registry('kelvorx3  # trailing number is ignored\n') and
          bad_registry('kelvorx  # first of two lines\nkelvorx  # second of two lines\n'))
    check('registry: a scope without globs is refused', bad_registry('kelvorx @  # scoped to nothing at all\n'))
    good = parse_placeholders('# c\n\nkelvorx  # a throwaway fixture\nsuvlan @ a/* b/c  # scoped fixture here\n')
    check('registry: entries and scopes parse', [(h, g) for h, g, _, _ in good] == [('kelvorx', None), ('suvlan', ['a/*', 'b/c'])])
    with open(os.path.join(real_here, PH_FILE)) as f:
        real_reg = parse_placeholders(f.read())
    real_ids = {h for h, _, _, _ in real_reg}
    check('registry: the tracked file lints and still lists the owner and partner placeholders', {'alex', 'sam', 'owner', 'partner', 'both'} <= real_ids)
    check('registry: no tracked handle is a needle of the self-test list', placeholder_needle_hits(Matcher(['zqx', 'quorvane'])) == [])
    os.environ['MIND_NEEDLES'] = nf
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    shutil.rmtree(root, ignore_errors=True)
    print('check-names self-test: %s' % ('all ok' if ok_all else 'FAILED'))
    return 0 if ok_all else 1


if '--self-test' in sys.argv[1:]:
    sys.exit(self_test())
sys.exit(main(sys.argv[1:]))
PY
