#!/bin/sh
# Does any tracked file carry a device, a team, a person or a machine path?
#
#   sh bin/check-personal-data.sh              check the tracked files of this suite checkout
#   sh bin/check-personal-data.sh --self-test  prove the check on a scratch repo (no real data read)
#
# Machine- and person-specific values live in the untracked
# <app>/.local/machine.env (CalMind/tools/machine-env.sh). This check fails when a
# tracked file contains:
#   - a UDID-shaped string (8 hex, a dash, 16 hex) other than the all-zero placeholders
#   - an Apple team id in a team context (DEVELOPMENT_TEAM, appleTeamId, APPLE_TEAM_ID=, <ID>.com.<bundle>)
#   - a gmail address
#   - a /Users/<name>/ path other than the placeholders (alice, example, runner, Shared, you)
#   - any value present in a machine file on this Mac (the app .local/machine.env files of this
#     checkout and of the main checkout a worktree hangs off, plus MIND_MACHINE_ENV; and
#     the values in the apps' deploy.conf files)
#   - any whitespace-free token whose SHA-256 is listed in a LOCAL, untracked hash list
#     (CoreMind/.local/personal-data.sha256 of this checkout or of the main checkout a worktree hangs
#     off, or the file named by MIND_PERSONAL_HASHES). The list is never committed: a tracked list of
#     plain SHA-256 digests of short names is a dictionary-attack oracle, so a checkout without the
#     file (CI, a fresh clone) skips this one rule and says so.
#   - a tracked file that is itself a list of value digests (5 or more lines that are a bare SHA-256)
# Output never prints a matched personal value, only file:line and which rule matched.
set -e
cd "$(dirname "$0")/.."
. bin/python.sh
mind_python || exit 1
exec $MIND_PYTHON - "$@" <<'PY'
import hashlib, os, re, subprocess, sys, tempfile

HERE = os.getcwd()                       # CoreMind
SUITE = os.path.dirname(HERE)
HASH_NAME = os.path.join('CoreMind', '.local', 'personal-data.sha256')
DIGEST_LINE = re.compile(r'^[0-9a-fA-F]{64}(\s|$)')

UDID = re.compile(r'(?<![0-9A-Za-z])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}(?![0-9A-Za-z])')
UDID40 = re.compile(r'(?<![0-9A-Za-z])[0-9A-Fa-f]{40}(?![0-9A-Za-z])')
TEAM = [
    re.compile(r'(?:DEVELOPMENT_TEAM|APPLE_DEVELOPMENT_TEAM|APPLE_TEAM_ID|appleTeamId|developmentTeam)["\']?\s*[=:]\s*["\']?([A-Z0-9]{10})\b'),
    re.compile(r'(?<![A-Za-z0-9])([A-Z0-9]{10})\.com\.[a-z]'),
]
GMAIL = re.compile(r'@gmail' + r'\.com', re.I)
HOMEPATH = re.compile(r'/Users/([A-Za-z0-9._-]+)')
OK_HOME = {'alice', 'example', 'runner', 'Shared', 'you', 'me', 'name', 'user', 'username'}
OK_TEAM = {'TEAMID0000'}
TOKEN = re.compile(r'[A-Za-z0-9_\-]+')


def tracked(root):
    out = subprocess.run(['git', '-C', root, 'ls-files', '-z'], capture_output=True, check=True).stdout
    return [p for p in out.decode('utf-8', 'replace').split('\0') if p]


def read_text(root, p):
    fp = os.path.join(root, p)
    if not os.path.isfile(fp) or os.path.islink(fp) or os.path.getsize(fp) > 4_000_000:
        return None
    b = open(fp, 'rb').read()
    if b'\0' in b:
        return None
    return b.decode('utf-8', 'replace')


def env_values(path, only=None):
    vals = []
    try:
        for line in open(path, encoding='utf-8'):
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            v = v.strip().strip('"').strip("'")
            if k.endswith('_PHONES') or len(v) < 5 or (only and not only(k)):
                continue
            vals.append(v)
    except OSError:
        pass
    return vals


def local_roots(root):
    roots = [os.path.dirname(root) if os.path.basename(root) == 'CoreMind' else root]
    try:
        common = subprocess.run(['git', '-C', root, 'rev-parse', '--git-common-dir'], capture_output=True, text=True).stdout.strip()
        if common:
            main = os.path.dirname(os.path.abspath(os.path.join(root, common)))
            if main not in roots:
                roots.append(main)
    except Exception:
        pass
    return roots


def local_value_files(root):
    files = []
    for r in local_roots(root):
        for app in ('CalMind', 'ChefMind', 'AcctMind', 'PlanMind', 'TaskMind', 'ReadMind', 'CoreMind'):
            files.append(os.path.join(r, app, '.local', 'machine.env'))
            files.append(os.path.join(r, app, 'deploy.conf'))
            files.append(os.path.join(r, app, 'server', 'deploy.conf'))
    if os.environ.get('MIND_MACHINE_ENV'):
        files.append(os.environ['MIND_MACHINE_ENV'])
    return files


def hash_files(root):
    files = [os.path.join(r, HASH_NAME) for r in local_roots(root)]
    if os.environ.get('MIND_PERSONAL_HASHES'):
        files.append(os.environ['MIND_PERSONAL_HASHES'])
    return files


def load_hashes(root):
    found, hashes = [], set()
    for f in hash_files(root):
        try:
            got = {l.split()[0] for l in open(f) if l.strip() and not l.startswith('#')}
        except OSError:
            continue
        found.append(f)
        hashes |= got
    return hashes, found


def scan(root, local_values, hashes, skip=()):
    findings = []
    for p in tracked(root):
        if p in skip:
            continue
        text = read_text(root, p)
        if text is None:
            continue
        digests = [n for n, line in enumerate(text.split('\n'), 1) if DIGEST_LINE.match(line)]
        if len(digests) >= 5:
            findings.append((p, digests[0], 'a tracked list of value digests'))
        for n, line in enumerate(text.split('\n'), 1):
            def hit(rule):
                findings.append((p, n, rule))
            for m in UDID.finditer(line):
                if not m.group(0).startswith('00000000-'):
                    hit('UDID-shaped string')
            for rx in TEAM:
                for m in rx.finditer(line):
                    if m.group(1) not in OK_TEAM:
                        hit('Apple team id')
            if GMAIL.search(line):
                hit('gmail address')
            for m in HOMEPATH.finditer(line):
                if m.group(1) not in OK_HOME and not m.group(1).startswith('<'):
                    hit('home-directory path')
            low = line.lower()
            if UDID40.search(line) and re.search(r'udid|device', low):
                hit('UDID-shaped string (40 hex)')
            for v in local_values:
                if v.lower() in low:
                    hit('a value from a local machine file')
            if hashes:
                for t in TOKEN.findall(line):
                    if len(t) >= 4 and (hashlib.sha256(t.encode()).hexdigest() in hashes
                                        or hashlib.sha256(t.lower().encode()).hexdigest() in hashes):
                        hit('a scrubbed value (hash list)')
    return findings


def run(root):
    values = set()
    for f in local_value_files(root):
        deploy = os.path.basename(f) == 'deploy.conf'
        values.update(env_values(f, (lambda k: k == 'SSH_DEST' or k.endswith('_DEPLOY_HOST')) if deploy else None))
    # a value the placeholder sample also carries is not personal
    sample = os.path.join(root, 'CalMind', 'tools', 'machine.env.sample')
    values -= set(env_values(sample))
    values = {v for v in values if 'example' not in v and 'your-existing' not in v and 'region' not in v}
    hashes, found = load_hashes(root)
    findings = scan(root, values, hashes)
    seen = sorted(set(findings))
    for p, n, rule in seen:
        print('  FAIL %s:%d — %s' % (p, n, rule))
    note = '%d digest(s) from %d local hash list(s)' % (len(hashes), len(found)) if found else 'no local hash list here, that rule skipped'
    print('check-personal-data: %d value(s) from local machine files compared, %s, %d finding(s)' % (len(values), note, len(seen)))
    return 1 if seen else 0


def self_test():
    tmp = tempfile.mkdtemp(prefix='personaldata.')
    subprocess.run(['git', 'init', '-q', tmp], check=True)
    ok = True

    def case(name, content, want, local=(), hashes=()):
        nonlocal ok
        fp = os.path.join(tmp, 'f.txt')
        open(fp, 'w').write(content)
        subprocess.run(['git', '-C', tmp, 'add', 'f.txt'], check=True)
        got = bool(scan(tmp, set(local), set(hashes)))
        good = got == want
        ok = ok and good
        print('  %s %s' % ('ok  ' if good else 'FAIL', name))

    hexs = '0123' + 'ABCD' + '-' + '0123456789ABCDEF'
    case('a UDID-shaped string is refused', 'phone ' + hexs + '\n', True)
    case('the zero placeholder UDID is allowed', 'phone 00000000-0000000000000001\n', False)
    case('a team id in DEVELOPMENT_TEAM is refused', 'DEVELOPMENT_TEAM = ' + 'ABCDE12345' + ';\n', True)
    case('a team id in an appID is refused', '"' + 'ABCDE12345' + '.com.example.app"\n', True)
    case('the placeholder team id is allowed', 'APPLE_TEAM_ID=TEAMID0000\n', False)
    case('a gmail address is refused', 'mail me at x' + '@gmail' + '.com\n', True)
    case('a home path is refused', 'cd /Users/' + 'bob' + '/code\n', True)
    case('the placeholder home path is allowed', 'cd /Users/alice/code\n', False)
    case('a value from a local machine file is refused', 'name: Some Phone Name\n', True, local=['Some Phone Name'])
    case('a value not in the local file passes', 'name: Other\n', False, local=['Some Phone Name'])
    h = hashlib.sha256(b'Quuxington').hexdigest()
    case('a token on the hash list is refused', 'about Quuxington today\n', True, hashes=[h])
    case('a token on the hash list is refused in any letter case', 'about quuxington today\n', True, hashes=[hashlib.sha256(b'quuxington').hexdigest()])
    case('a local value is refused in any letter case', 'name: SOME PHONE NAME\n', True, local=['Some Phone Name'])
    case('a tracked list of value digests is refused', ''.join(hashlib.sha256(b'v%d' % i).hexdigest() + '\n' for i in range(5)), True)
    case('a few digests in a file are allowed', ''.join(hashlib.sha256(b'v%d' % i).hexdigest() + '\n' for i in range(4)), False)
    case('a 40-hex UDID on a device line is refused', 'udid ' + 'a1' * 20 + '\n', True)
    case('a 40-hex commit hash alone passes', 'commit ' + 'a1' * 20 + '\n', False)
    case('a token off the hash list passes', 'about Quuxingtons today\n', False, hashes=[h])
    # the hash list is local: found beside a checkout (or named by the environment), absent means skipped
    home = tempfile.mkdtemp(prefix='personaldata.home.')
    subprocess.run(['git', 'init', '-q', home], check=True)
    os.makedirs(os.path.join(home, 'CoreMind', '.local'))
    got, found = load_hashes(home)
    good = not got and not found
    ok = ok and good
    print('  %s %s' % ('ok  ' if good else 'FAIL', 'no local hash list: nothing loaded, nothing fails'))
    open(os.path.join(home, 'CoreMind', '.local', 'personal-data.sha256'), 'w').write('# comment\n' + h + '  Quuxington\n')
    got, found = load_hashes(home)
    good = got == {h} and len(found) == 1
    ok = ok and good
    print('  %s %s' % ('ok  ' if good else 'FAIL', 'a local hash list is loaded, comments skipped'))
    # the findings never print the value
    fp = os.path.join(tmp, 'f.txt')
    open(fp, 'w').write('x ' + hexs + '\n')
    subprocess.run(['git', '-C', tmp, 'add', 'f.txt'], check=True)
    printed = repr(scan(tmp, set(), set()))
    good = hexs not in printed
    ok = ok and good
    print('  %s findings carry no matched value' % ('ok  ' if good else 'FAIL'))
    return 0 if ok else 1


if '--self-test' in sys.argv[1:]:
    sys.exit(self_test())
sys.exit(run(SUITE))
PY
