#!/bin/sh
# Build the local needle list for check-names.sh. Prints a count, never a value.
#
#   sh CoreMind/bin/needles-init.sh
#
# Writes ~/Library/Application Support/MindSuite/needles.txt (mode 600, outside every repo) from:
#   - the name rules of the local scrub-rule files (MIND_SCRUB_DIR, default ~/GIT/MindSuite):
#     .local-scrub-rules-usernames.txt and .local-scrub-rules.txt (a boundary-regex rule or a purely
#     alphabetic left-hand side; a 2-word phrase contributes both words, a longer one its first and last word,
#     each of 3+ letters and not an ordinary lowercase dictionary word, plus the glued phrase);
#   - the PERSON_* and PHONE*_PERSON values of every <app>/.local/machine.env there.
# Re-run after the scrub files change. MIND_NEEDLES_OUT overrides the output path.
set -e
cd "$(dirname "$0")/.."
. bin/python.sh
mind_python || exit 1
exec $MIND_PYTHON - "$@" <<'PY'
import glob, os, re, sys

SRC = os.environ.get('MIND_SCRUB_DIR') or os.path.expanduser('~/GIT/MindSuite')
OUT = os.environ.get('MIND_NEEDLES_OUT') or os.path.expanduser('~/Library/Application Support/MindSuite/needles.txt')
STOP = set('the and for of in on at to st rd ave inc llc ltd'.split())
words_ok = set()
try:
    for w in open('/usr/share/dict/words', encoding='utf-8', errors='replace'):
        w = w.strip()
        if w.islower():
            words_ok.add(w)
except OSError:
    pass

needles = []


def add(v):
    v = v.strip().lower()
    if len(v) >= 2 and v not in needles:
        needles.append(v)


def phrase(p):
    ws = [w for w in re.split(r"[\s'\-]+", p) if w]
    if len(ws) == 1:
        add(ws[0])
        return
    # a name phrase: a 2-word phrase gives both words, a longer one its first and last word
    cand = ws if len(ws) == 2 else [ws[0], ws[-1]]
    keep = [w for w in cand if len(w) >= 3 and w.lower() not in STOP and w.lower() not in words_ok]
    for w in keep:
        add(w)
    if len(keep) == len(ws) and len(ws) <= 3 and len(''.join(ws)) >= 5:
        add(''.join(ws))


LAB = re.compile(r'^[A-Za-z]+:\(\?<![^)]*\)(.+?)\(\?![^)]*\)$')
for fn in ('.local-scrub-rules-usernames.txt', '.local-scrub-rules.txt'):
    try:
        lines = open(os.path.join(SRC, fn), encoding='utf-8').read().splitlines()
    except OSError:
        continue
    for l in lines:
        if '==>' not in l or l.lstrip().startswith('#'):
            continue
        lhs = l.split('==>', 1)[0]
        m = LAB.match(lhs)
        if m:
            for alt in m.group(1).split('|'):
                alt = alt.replace('\\', '')
                if re.fullmatch(r"[A-Za-z][A-Za-z0-9' _-]*", alt):
                    phrase(alt)
        elif re.fullmatch(r"[A-Za-z][A-Za-z' \-]*", lhs.strip()):
            phrase(lhs.strip())
for f in sorted(glob.glob(os.path.join(SRC, '*', '.local', 'machine.env'))):
    for l in open(f, encoding='utf-8', errors='replace'):
        l = l.strip()
        if '=' not in l or l.startswith('#'):
            continue
        k, v = l.split('=', 1)
        if re.match(r'^(PERSON_|PHONE[0-9A-Z_]*_PERSON)', k):
            v = v.strip().strip('"').strip("'")
            if ' ' in v:
                for w in v.split():
                    if len(w) >= 3:
                        add(w)
            else:
                add(v)
if not needles:
    print('no needles found; nothing written', file=sys.stderr)
    sys.exit(1)
os.makedirs(os.path.dirname(OUT), mode=0o700, exist_ok=True)
tmp = OUT + '.tmp'
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as fh:
    fh.write('\n'.join(needles) + '\n')
os.chmod(tmp, 0o600)
os.replace(tmp, OUT)
print('%d needle(s) written' % len(needles))
PY
