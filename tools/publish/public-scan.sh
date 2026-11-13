#!/bin/sh
# What a stranger could read: a mirror of the public repository, scanned for names and personal data (docs/PUBLISH.md).
# Counts only: no needle, no matched token and no personal value is ever printed.
#
#   sh tools/publish/public-scan.sh --url https://HOST/OWNER/REPO.git   anonymous git clone --mirror (https, no credentials)
#   sh tools/publish/public-scan.sh --mirror DIR                        an existing bare mirror, read only (an authenticated
#                                                                       `gh repo clone OWNER/REPO DIR -- --mirror` of the private repo)
#   sh tools/publish/public-scan.sh --from PATH                         a local repository, mirrored first (the --export of squash-reroot.sh)
#
#   --expect-commits N     the mirror must hold exactly N commits (the first publication: 1)
#   --expect-ref REF       (repeatable) a ref that may exist; a trailing * is a prefix. Default when none is given: refs/heads/main.
#                          Every other ref (a second branch, a tag, refs/pull/*) counts as a hit.
#   --allow-identity RE    every author, committer and tagger, written "Name <email>", must match RE. Default: the identity
#                          squash-reroot.sh makes, ^MindSuite <noreply@users\.noreply\.github\.com>$ (pass the same RE
#                          when PUBLISH_NAME / PUBLISH_EMAIL were set; a name that is not neutral fails even behind a noreply email)
#   --list                 also print the checkers' own FAIL lines (paths masked by check-names, personal values never)
#   --keep                 keep the scratch directory (it holds a copy of the mirror's blobs: delete it yourself)
#   --work DIR             where the scratch directory goes (default: $TMPDIR)
#
# The scan always uses the checkers of THIS checkout, never the mirror's own copies, and always in strict mode:
#   refs      refs outside --expect-ref
#   shape     commit count against --expect-commits
#   identity  author, committer and tagger identities outside --allow-identity
#   history   check-names.sh mirror: every commit identity and message, ref name, tag object, path name and every blob
#             reachable from any ref (the tip's blobs are in here too)
#   tree      check-names.sh tree at the mirror's HEAD
#   literals  check-names.sh literals at the mirror's HEAD
#   personal  check-personal-data.sh over every blob of the mirror (UDIDs, team ids, gmail, home paths, machine values,
#             the local digest list). It needs the local digest list and the local machine files (MIND_PERSONAL_HASHES,
#             MIND_MACHINE_ENV or the untracked files named in docs/PUBLISH.md); without them it cannot run: exit 2.
#
# Exit: 0 nothing found in any class, 1 hits, 2 cannot run (no needle list, no digest list, clone failed, ...).
set -eu
PUBLISH_CALLER_PWD=$(pwd -P)
export PUBLISH_CALLER_PWD
ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
cd "$ROOT"
. CoreMind/bin/python.sh
mind_python || exit 2
exec $MIND_PYTHON - "$ROOT" "$@" <<'PY'
import os, re, shutil, subprocess, sys, tempfile
from collections import Counter

ROOT = sys.argv[1]
ARGS = sys.argv[2:]
CALLER = os.environ.get('PUBLISH_CALLER_PWD') or os.getcwd()
CHECK_NAMES = os.path.join(ROOT, 'CoreMind', 'bin', 'check-names.sh')
CHECK_PD = os.path.join(ROOT, 'CoreMind', 'bin', 'check-personal-data.sh')
PYSH = os.path.join(ROOT, 'CoreMind', 'bin', 'python.sh')
APPS = ('AcctMind', 'CalMind', 'ChefMind', 'CoreMind', 'PlanMind', 'ReadMind', 'TaskMind')
KNOWN = APPS + ('packages', 'tools', 'docs', '.github')
FAIL = re.compile(r'^\s+FAIL (.+):(\d+) - (\S+)(?: #(\d+))?\s*$')
PDFAIL = re.compile(r'^\s+FAIL b/([0-9a-f]+)\.txt:(\d+) — (.*?)\s*$')


class Stop(Exception):
    def __init__(self, msg, code=2):
        Exception.__init__(self, msg)
        self.code = code


def say(msg):
    print('public-scan: ' + msg)


def abspath(p):
    return p if os.path.isabs(p) else os.path.join(CALLER, p)


def run(cmd, cwd=None, env=None, inp=None):
    r = subprocess.run(cmd, cwd=cwd, env=env, input=inp, capture_output=True)
    return r.returncode, r.stdout.decode('utf-8', 'replace'), r.stderr.decode('utf-8', 'replace')


# git for the mirror: no user config (insteadOf, credential helpers, ssh rewriting), never a prompt
GENV = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
GENV.update({'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_SYSTEM': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
             'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': 'false', 'SSH_ASKPASS': 'false'})
# the checkers: strict, and a missing needle list is an error
NENV = dict(os.environ)
NENV.update({'MIND_NAMES_OPTIONAL': '0', 'MIND_NAMES_STRICT': '1'})
for k in list(NENV):
    if k.startswith('GIT_'):
        del NENV[k]


def git(mirror, *args, check=True):
    rc, out, err = run(['git', '-C', mirror] + list(args), env=GENV)
    if rc != 0 and check:
        raise Stop('git %s failed' % (args[0] if args else ''))
    return out


def parse_args(args):
    o = {'url': None, 'mirror': None, 'from': None, 'commits': None, 'refs': [], 'identity': r'^MindSuite <noreply@users\.noreply\.github\.com>$',
         'list': False, 'keep': False, 'work': None}
    i = 0
    while i < len(args):
        a = args[i]
        if a in ('--list', '--keep'):
            o[a[2:]] = True
            i += 1
            continue
        if a not in ('--url', '--mirror', '--from', '--expect-commits', '--expect-ref', '--allow-identity', '--work') or i + 1 >= len(args):
            raise Stop('unknown or incomplete argument: %s' % a)
        v = args[i + 1]
        i += 2
        if a == '--url':
            o['url'] = v
        elif a == '--mirror':
            o['mirror'] = abspath(v)
        elif a == '--from':
            o['from'] = abspath(v)
        elif a == '--expect-commits':
            if not v.isdigit():
                raise Stop('--expect-commits needs a number')
            o['commits'] = int(v)
        elif a == '--expect-ref':
            o['refs'].append(v)
        elif a == '--allow-identity':
            o['identity'] = v
        elif a == '--work':
            o['work'] = abspath(v)
    if sum(1 for k in ('url', 'mirror', 'from') if o[k]) != 1:
        raise Stop('give exactly one of --url, --mirror, --from')
    if not o['refs']:
        o['refs'] = ['refs/heads/main']
    try:
        re.compile(o['identity'])
    except re.error:
        raise Stop('--allow-identity is not a regular expression')
    return o


def ref_allowed(ref, patterns):
    for p in patterns:
        if p.endswith('*'):
            if ref.startswith(p[:-1]):
                return True
        elif ref == p:
            return True
    return False


def app_of(path):
    if '/' not in path:
        return 'root'
    first = path.split('/', 1)[0]
    return first if first in KNOWN else 'other'


def parse_fail(out):
    for line in out.splitlines():
        m = FAIL.match(line)
        if m:
            yield m.group(1), int(m.group(2)), m.group(3), m.group(4)


SUMMARY = {
    'history': re.compile(r'^check-names history: \d+ commit\(s\), \d+ object\(s\), (\d+) hit\(s\)$'),
    'tree': re.compile(r'^check-names tree: \d+ needle\(s\), (\d+) hit\(s\) in \d+ file\(s\)$'),
    'literals': re.compile(r'^check-names literals: (\d+) finding\(s\)'),
}


def summary_hits(kind, out, fallback):
    """the checker's own total (it counts every occurrence; the FAIL lines are distinct file:line:needle pairs)."""
    for l in out.splitlines():
        m = SUMMARY[kind].match(l.strip())
        if m:
            return int(m.group(1))
    return fallback


def history_class(path, rule):
    r = rule.split('/', 1)[-1]
    if path.startswith('commit '):
        return 'identity' if r in ('author', 'committer') else 'message'
    if path.startswith('ref ') and r == 'refname':
        return 'refname'
    if path.startswith('tag ') and r == 'tag':
        return 'tag'
    if r == 'path':
        return 'pathname'
    return 'blob'


def by_app(hits):
    c = Counter(app_of(p) for p in hits)
    return ', '.join('%s %d' % (k, c[k]) for k in sorted(c)) or 'none'


def get_mirror(o, work):
    if o['mirror']:
        m = o['mirror']
        if git(m, 'rev-parse', '--is-bare-repository', check=False).strip() != 'true':
            raise Stop('%s is not a bare mirror (gh repo clone OWNER/REPO DIR -- --mirror)' % m)
        return m, 'existing mirror (read only)'
    dst = os.path.join(work, 'mirror.git')
    if o['url']:
        u = o['url']
        if not u.startswith('https://') or '@' in u.split('/', 3)[2]:
            raise Stop('--url must be an https URL without credentials; clone a private repository yourself and pass --mirror')
        rc, _, _ = run(['git', 'clone', '--mirror', '-q', u, dst], env=GENV)
        if rc != 0:
            raise Stop('anonymous clone failed (private, renamed or offline?)')
        return dst, 'anonymous https mirror clone'
    rc, _, _ = run(['git', 'clone', '--mirror', '--no-hardlinks', '-q', o['from'], dst], env=GENV)
    if rc != 0:
        raise Stop('cannot mirror %s' % o['from'])
    return dst, 'local mirror clone'


def objects(mirror):
    """[(oid, first path)] of every object reachable from any ref."""
    out = git(mirror, 'rev-list', '--objects', '--all')
    first = {}
    for l in out.split('\n'):
        if not l:
            continue
        oid, _, path = l.partition(' ')
        first.setdefault(oid, path)
    return first


def blob_oids(mirror, first):
    inp = ('\n'.join(first) + '\n').encode()
    rc, out, _ = run(['git', '-C', mirror, 'cat-file', '--batch-check=%(objecttype) %(objectname)'], env=GENV, inp=inp)
    if rc != 0:
        raise Stop('git cat-file failed')
    return [l.split()[1] for l in out.split('\n') if l.startswith('blob ')]


def personal_data(mirror, work, first, oids):
    suite = os.path.join(work, 'pd')
    os.makedirs(os.path.join(suite, 'CoreMind', 'bin'))
    os.makedirs(os.path.join(suite, 'b'))
    if run(['git', 'init', '-q', suite], env=GENV)[0] != 0:
        raise Stop('git init failed')
    shutil.copy(CHECK_PD, os.path.join(suite, 'CoreMind', 'bin', 'check-personal-data.sh'))
    shutil.copy(PYSH, os.path.join(suite, 'CoreMind', 'bin', 'python.sh'))
    # the checker finds its inputs next to the suite it scans: link this checkout's untracked ones in
    roots = [ROOT]
    common = git(ROOT, 'rev-parse', '--git-common-dir', check=False).strip()
    if common:
        main = os.path.dirname(os.path.abspath(os.path.join(ROOT, common)))
        if main not in roots:
            roots.append(main)
    rels = ['.local/machine.env', 'deploy.conf', 'server/deploy.conf']
    for r in roots:
        for app in APPS:
            for rel in rels:
                src, dst = os.path.join(r, app, rel), os.path.join(suite, app, rel)
                if os.path.isfile(src) and not os.path.exists(dst):
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    os.symlink(src, dst)
        src, dst = os.path.join(r, 'CoreMind', '.local', 'personal-data.sha256'), os.path.join(suite, 'CoreMind', '.local', 'personal-data.sha256')
        if os.path.isfile(src) and not os.path.exists(dst):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.symlink(src, dst)
    sample = os.path.join(ROOT, 'CoreMind', 'canon', 'tools', 'machine.env.sample')
    if os.path.isfile(sample):
        dst = os.path.join(suite, 'CoreMind', 'canon', 'tools', 'machine.env.sample')
        os.makedirs(os.path.dirname(dst))
        shutil.copy(sample, dst)
    # every blob the checker would read (it skips binary files and files over 4 MB)
    p = subprocess.Popen(['git', '-C', mirror, 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, env=GENV)
    written = 0
    try:
        for oid in oids:
            p.stdin.write(oid.encode() + b'\n')
            p.stdin.flush()
            head = p.stdout.readline().split()
            if len(head) < 3:
                continue
            size = int(head[2])
            data = p.stdout.read(size)
            p.stdout.read(1)
            if size > 4_000_000 or b'\0' in data:
                continue
            with open(os.path.join(suite, 'b', oid + '.txt'), 'wb') as f:
                f.write(data)
            written += 1
    finally:
        p.stdin.close()
        p.stdout.close()
        p.wait()
    if written and run(['git', '-C', suite, 'add', 'b'], env=GENV)[0] != 0:
        raise Stop('git add failed in the scratch suite')
    rc, out, err = run(['sh', os.path.join(suite, 'CoreMind', 'bin', 'check-personal-data.sh')], cwd=suite, env=NENV)
    summary = [l for l in out.split('\n') if l.startswith('check-personal-data:')]
    if rc == 2 or not summary:
        raise Stop('check-personal-data could not run')
    s = summary[-1]
    m = re.match(r'check-personal-data: (\d+) value\(s\) from local machine files compared, (.*), (\d+) finding\(s\)$', s)
    if not m:
        raise Stop('unreadable check-personal-data summary')
    values, note = int(m.group(1)), m.group(2)
    if 'no local hash list' in note:
        raise Stop('the local digest list is missing (CoreMind/.local/personal-data.sha256 or MIND_PERSONAL_HASHES): that rule would be skipped, so nothing is claimed')
    if values == 0:
        raise Stop('no local machine files were found (<App>/.local/machine.env or MIND_MACHINE_ENV): the machine-value rule would be blind, so nothing is claimed')
    hits = []
    for line in out.split('\n'):
        mm = PDFAIL.match(line)
        if mm:
            hits.append((mm.group(1), int(mm.group(2)), mm.group(3)))
    return hits, s, written


def main():
    o = parse_args(ARGS)
    work_parent = o['work'] or os.environ.get('TMPDIR') or '/tmp'
    os.makedirs(work_parent, exist_ok=True)
    work = tempfile.mkdtemp(prefix='public-scan.', dir=work_parent)
    try:
        return scan(o, work)
    finally:
        if o['keep']:
            say('scratch kept at %s (it holds copies of the mirror\'s blobs: delete it)' % work)
        else:
            shutil.rmtree(work, ignore_errors=True)


def scan(o, work):
    # the gate: no needle list means nothing can be claimed
    rc, _, err = run(['sh', CHECK_NAMES, 'message', os.devnull], env=NENV)
    if rc != 0:
        raise Stop('check-names cannot run: %s' % (err.strip().splitlines() or ['no output'])[-1])
    mirror, how = get_mirror(o, work)
    refs = [r for r in git(mirror, 'for-each-ref', '--format=%(refname)').split('\n') if r]
    if not refs:
        raise Stop('the mirror has no refs')
    first = objects(mirror)
    oids = blob_oids(mirror, first)
    commits = len([x for x in git(mirror, 'rev-list', '--all').split('\n') if x])
    roots = len([x for x in git(mirror, 'rev-list', '--all', '--max-parents=0').split('\n') if x])
    tags = len([x for x in git(mirror, 'for-each-ref', '--format=%(objecttype)', 'refs/tags').split('\n') if x == 'tag'])
    say('source: %s; %d ref(s); %d commit(s), %d root(s); %d object(s), %d blob(s), %d tag object(s)' %
        (how, len(refs), commits, roots, len(first), len(oids), tags))
    classes = {}

    out_refs = [r for r in refs if not ref_allowed(r, o['refs'])]
    classes['refs'] = len(out_refs)
    say('refs: %d outside the allowed list' % len(out_refs))

    shape = 0
    if o['commits'] is not None and commits != o['commits']:
        shape = 1
    classes['shape'] = shape
    say('shape: %d commit(s)%s' % (commits, '' if o['commits'] is None else ', expected %d: %s' % (o['commits'], 'MISMATCH' if shape else 'ok')))

    ident = re.compile(o['identity'])
    idents = []
    for line in git(mirror, 'log', '--all', '--format=%an%x00%ae%x00%cn%x00%ce').split('\n'):
        f = line.split('\0')
        if len(f) == 4:
            idents.append('%s <%s>' % (f[0], f[1]))
            idents.append('%s <%s>' % (f[2], f[3]))
    for line in git(mirror, 'for-each-ref', '--format=%(taggername)%00%(taggeremail)', 'refs/tags').split('\n'):
        f = line.split('\0')
        if len(f) == 2 and f[1].strip():
            idents.append('%s <%s>' % (f[0], f[1].strip().strip('<>')))
    bad_ident = sum(1 for e in idents if not ident.search(e))
    classes['identity'] = bad_ident
    say('identity: %d of %d author/committer/tagger identities outside the allowed pattern' % (bad_ident, len(idents)))
    utc = sum(1 for l in git(mirror, 'log', '--all', '--format=%ad', '--date=raw').split('\n') if l and not l.endswith(' +0000'))
    say('info: %d commit timestamp(s) not in UTC' % utc)

    rc, out, err = run(['sh', CHECK_NAMES, 'mirror', mirror], env=NENV)
    if rc == 2:
        raise Stop('check-names mirror cannot run: %s' % (err.strip().splitlines() or ['no output'])[-1])
    hist = list(parse_fail(out))
    hc = Counter(history_class(p, r) for p, _, r, _ in hist)
    total = summary_hits('history', out, len(hist))
    classes['history'] = total
    say('history: %d hit(s) over all refs; %d distinct line/needle pair(s): identity %d, message %d, tag %d, refname %d, pathname %d, blob %d' %
        (total, len(hist), hc['identity'], hc['message'], hc['tag'], hc['refname'], hc['pathname'], hc['blob']))
    say('history per app (distinct pairs in blobs and path names; a blob shared by several paths counts once, at its first path): %s' %
        by_app([p for p, _, r, _ in hist if history_class(p, r) in ('blob', 'pathname')]))
    if o['list']:
        sys.stdout.write(out)

    # the tip: a working-tree-less clone is enough, the checkers read the HEAD tree through git
    tree = os.path.join(work, 'tip')
    rc2, _, _ = run(['git', 'clone', '-q', '-n', '--no-hardlinks', mirror, tree], env=GENV)
    if rc2 != 0 or run(['git', '-C', tree, 'rev-parse', '-q', '--verify', 'HEAD'], env=GENV)[0] != 0:
        raise Stop('the mirror has no HEAD commit to read the tip tree from')
    for name in ('tree', 'literals'):
        rc, out, err = run(['sh', CHECK_NAMES, name], cwd=tree, env=NENV)
        if rc == 2:
            raise Stop('check-names %s cannot run: %s' % (name, (err.strip().splitlines() or ['no output'])[-1]))
        hits = list(parse_fail(out))
        total = summary_hits(name, out, len(hits))
        classes[name] = total
        files = len({p for p, _, _, _ in hits})
        rules = Counter(r.split('/', 1)[-1] for _, _, r, _ in hits)
        say('%s: %d hit(s) at HEAD; %d distinct line/needle pair(s) in %d file(s)%s' % (name, total, len(hits), files,
            '' if name == 'tree' or not rules else ' (' + ', '.join('%s %d' % (k, rules[k]) for k in sorted(rules)) + ')'))
        say('%s per app (distinct pairs): %s' % (name, by_app([p for p, _, _, _ in hits])))
        if o['list']:
            sys.stdout.write(out)

    pd_hits, summary, written = personal_data(mirror, work, first, oids)
    classes['personal'] = len(pd_hits)
    rules = Counter(r for _, _, r in pd_hits)
    say('personal: %d finding(s) in %d blob(s) read (%s)' % (len(pd_hits), written, ', '.join('%s %d' % (k, rules[k]) for k in sorted(rules)) or 'none'))
    say('personal per app: %s' % by_app([first.get(oid, '') for oid, _, _ in pd_hits]))
    say('personal checker summary: ' + summary)
    if o['list']:
        for oid, ln, rule in sorted(pd_hits):
            print('  FAIL blob %s:%d - %s' % (oid[:12], ln, rule))

    bad = {k: v for k, v in classes.items() if v}
    if bad:
        say('RESULT: hits in %d class(es): %s' % (len(bad), ', '.join('%s=%d' % (k, bad[k]) for k in sorted(bad))))
        return 1
    say('RESULT: clean in every class (refs, shape, identity, history, tree, literals, personal)')
    return 0


try:
    sys.exit(main())
except Stop as e:
    print('public-scan: %s' % e, file=sys.stderr)
    sys.exit(e.code)
PY
