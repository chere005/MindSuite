#!/bin/sh
# Owed iOS installs: a phone that was locked, away or refused a lane's install
# gets the build later, without anyone re-running the lane.
#
#   sh tools/retry-installs.sh                          retry every owed install whose phone is reachable now
#   sh tools/retry-installs.sh record <App> <udid> <bundle>   a lane's install failed (or the phone was away)
#   sh tools/retry-installs.sh clear  <App> <udid> <bundle>   a lane's install succeeded
#
# <bundle> is the built .app directory (or an .ipa). `record` keeps a copy of it
# as <dir>/builds/<App>-<version>.app (or .ipa) and writes one entry per
# (app, phone): app, version, bundle id, device id, phone index, saved path,
# time. A newer record replaces the older one for that app and phone; `clear`
# (a successful install of version V) drops every entry for that app and phone
# at or below V; saved copies nothing refers to any more are deleted.
#
# `record` and `clear` take the phone list the lane installs from in
# $IOS_PHONES (udids, comments after # ignored) only to work out the phone's
# 1-based index. Everything printed names the phone by that index; no device
# or person name is ever printed, and no path either (the home directory is
# the owner's name).
#
# The retry: for each entry whose device `devicectl list devices` reports, it
# installs the saved copy (twice at most, like the lanes' helper), reads the
# installed version back with `devicectl device info apps --bundle-id`, and
# drops the entry only when that matches. A phone that is not reported, or
# whose install fails, keeps its entry quietly. It never prompts. Exit 0 when
# nothing is owed or every reachable phone took its build; 1 when an install on
# a reachable phone failed (lanes ignore the status). `record` and `clear`
# always exit 0: a lane must not fail over bookkeeping.
#
# State: $MIND_OWED_DIR, default ~/Library/Application Support/MindSuite
# (owed-installs.json, builds/). A state file that does not parse is copied to
# owed-installs.json.corrupt-<time> (the newest five are kept), the run goes on
# with an empty list, and one line says so.
# MIND_DEVICECTL replaces `xcrun devicectl`, as in build-platforms.sh (tests).
#
# This file is shared byte for byte (tools/shared-files.json; origin CoreMind/bin).
command -v python3 >/dev/null 2>&1 || { echo "retry-installs: python3 not found" >&2; exit 0; }
exec python3 -I - "$@" <<'PY'
import fcntl, glob, json, os, re, shlex, shutil, subprocess, sys, tempfile, time, zipfile, plistlib

DIR = os.environ.get('MIND_OWED_DIR') or os.path.join(os.path.expanduser('~'), 'Library', 'Application Support', 'MindSuite')
STATE = os.path.join(DIR, 'owed-installs.json')
BUILDS = os.path.join(DIR, 'builds')
SAFE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')
REACHABLE = ('connected', 'available', 'disconnected')   # as build-platforms.sh: only 'unavailable' is absent
FIELDS = {'app': str, 'version': str, 'bundle_id': str, 'device': str, 'phone': int, 'path': str, 'time': str}


def say(msg):
    print('retry-installs: ' + msg, flush=True)


def vkey(v):
    return tuple(int(x) for x in re.findall(r'\d+', v))


def valid(e):
    return isinstance(e, dict) and all(isinstance(e.get(k), t) and not isinstance(e.get(k), bool) for k, t in FIELDS.items())


class Lock:
    def __init__(self, name, wait):
        self.name, self.wait, self.f = name, wait, None

    def __enter__(self):
        os.makedirs(DIR, exist_ok=True)
        self.f = open(os.path.join(DIR, self.name), 'a')
        end = time.time() + self.wait
        while True:
            try:
                fcntl.flock(self.f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True
            except OSError:
                if time.time() >= end:
                    return False
                time.sleep(0.1)

    def __exit__(self, *a):
        self.f.close()


def load():
    try:
        with open(STATE, 'rb') as f:
            raw = f.read()
    except FileNotFoundError:
        return []
    try:
        d = json.loads(raw)
        if not (isinstance(d, dict) and isinstance(d.get('owed'), list) and all(valid(e) for e in d['owed'])):
            raise ValueError
        return d['owed']
    except ValueError:
        stamp = time.strftime('%Y%m%dT%H%M%S')
        bak = STATE + '.corrupt-' + stamp
        n = 0
        while os.path.exists(bak):
            n += 1
            bak = STATE + '.corrupt-%s-%d' % (stamp, n)
        shutil.copy2(STATE, bak)
        for old in sorted(glob.glob(STATE + '.corrupt-*'))[:-5]:
            os.unlink(old)
        say('the owed-installs state file did not parse; a backup copy was kept and the list starts empty')
        return []


def save(owed):
    os.makedirs(DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.owed-installs-', dir=DIR)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump({'version': 1, 'owed': owed}, f, indent=1, sort_keys=True)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, STATE)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def managed(path):
    real = os.path.realpath(path)
    return os.path.dirname(real) == os.path.realpath(BUILDS)


def prune(owed):
    if not os.path.isdir(BUILDS):
        return
    keep = {os.path.realpath(e['path']) for e in owed}
    for name in os.listdir(BUILDS):
        p = os.path.join(BUILDS, name)
        if not re.match(r'^[A-Za-z0-9][A-Za-z0-9._-]*-[^/]+\.(app|ipa)$', name) or os.path.realpath(p) in keep:
            continue
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p, ignore_errors=True)
        else:
            os.unlink(p)


def bundle_info(path):
    """(bundle id, short version) of a built .app directory or an .ipa."""
    if os.path.isdir(path):
        with open(os.path.join(path, 'Info.plist'), 'rb') as f:
            p = plistlib.load(f)
    else:
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if re.match(r'^Payload/[^/]+\.app/Info\.plist$', n)]
            p = plistlib.loads(z.read(names[0]))
    return p['CFBundleIdentifier'], p['CFBundleShortVersionString']


def phone_index(udid):
    i = 0
    for line in (os.environ.get('IOS_PHONES') or '').splitlines():
        for w in line.split('#', 1)[0].split():
            i += 1
            if w == udid:
                return i
    return 0


def who(e):
    return 'phone %s' % (e['phone'] or '?')


def devicectl(args, timeout):
    cmd = shlex.split(os.environ.get('MIND_DEVICECTL') or 'xcrun devicectl') + args
    try:
        r = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0


def devicectl_json(args, timeout):
    fd, tmp = tempfile.mkstemp(prefix='retry-installs-')
    os.close(fd)
    try:
        if not devicectl(args + ['--json-output', tmp], timeout):
            return None
        with open(tmp) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None
    finally:
        os.unlink(tmp)


def args_ok(app, udid, bundle):
    if not (SAFE.match(app) and SAFE.match(udid)):
        say('refused: app and device ids must be plain names')
        return False
    return True


def cmd_record(app, udid, bundle):
    if not args_ok(app, udid, bundle):
        return
    bundle_id, version = bundle_info(bundle)
    if not SAFE.match(version):
        say('refused: the bundle version is not a plain version string')
        return
    ext = '.ipa' if bundle.endswith('.ipa') else '.app'
    os.makedirs(BUILDS, exist_ok=True)
    dest = os.path.join(BUILDS, app + '-' + version + ext)
    if os.path.realpath(bundle) != os.path.realpath(dest):
        tmp = tempfile.mkdtemp(prefix='.copy-', dir=BUILDS)
        try:
            part = os.path.join(tmp, 'x' + ext)
            if os.path.isdir(bundle):
                if shutil.which('ditto'):
                    subprocess.run(['ditto', bundle, part], check=True)
                else:
                    shutil.copytree(bundle, part, symlinks=True)
            else:
                shutil.copy2(bundle, part)
            if os.path.isdir(dest) and not os.path.islink(dest):
                shutil.rmtree(dest)
            elif os.path.lexists(dest):
                os.unlink(dest)
            os.rename(part, dest)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    entry = {'app': app, 'version': version, 'bundle_id': bundle_id, 'device': udid, 'phone': phone_index(udid),
             'path': dest, 'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    with Lock('owed-installs.lock', 30) as got:
        if not got:
            say('could not take the state lock; not recorded')
            return
        owed = [e for e in load() if not (e['app'] == app and e['device'] == udid)] + [entry]
        save(owed)
        prune(owed)
    say('%s owes %s %s' % (who(entry), app, version))


def cmd_clear(app, udid, bundle):
    if not args_ok(app, udid, bundle):
        return
    _, version = bundle_info(bundle)
    with Lock('owed-installs.lock', 30) as got:
        if not got:
            return
        owed = load()
        gone = [e for e in owed if e['app'] == app and e['device'] == udid and vkey(e['version']) <= vkey(version)]
        if gone:
            owed = [e for e in owed if e not in gone]
            save(owed)
            prune(owed)
            for e in gone:
                say('%s no longer owes %s %s' % (who(e), app, e['version']))


def cmd_retry():
    if not os.path.exists(STATE):
        return 0
    with Lock('retry-installs.lock', 0) as got:
        if not got:
            return 0   # another retry is running
        with Lock('owed-installs.lock', 30) as got2:
            if not got2:
                return 0
            owed = load()
        if not owed:
            return 0
        listing = devicectl_json(['list', 'devices'], 60)
        seen = set()
        for x in ((listing or {}).get('result') or {}).get('devices') or []:
            hw = x.get('hardwareProperties') or {}
            if hw.get('platform') == 'iOS' and hw.get('udid') and \
               (x.get('connectionProperties') or {}).get('tunnelState') in REACHABLE:
                seen.add(hw['udid'])
        done, dropped, failed = [], [], 0
        for e in owed:
            if e['device'] not in seen:
                continue
            if not (managed(e['path']) and os.path.lexists(e['path'])):
                dropped.append(e)
                say('%s: the saved %s %s is gone; dropped' % (who(e), e['app'], e['version']))
                continue
            ok = devicectl(['device', 'install', 'app', '--device', e['device'], e['path']], 300) or \
                 devicectl(['device', 'install', 'app', '--device', e['device'], e['path']], 300)
            if ok:
                info = devicectl_json(['device', 'info', 'apps', '--device', e['device'], '--bundle-id', e['bundle_id']], 60)
                apps = ((info or {}).get('result') or {}).get('apps') or []
                ok = any(a.get('bundleIdentifier') == e['bundle_id'] and a.get('version') == e['version'] for a in apps)
            if ok:
                done.append(e)
                say('%s took %s %s' % (who(e), e['app'], e['version']))
            else:
                failed += 1
        if done or dropped:
            with Lock('owed-installs.lock', 30) as got3:
                if got3:
                    cur = load()
                    # An entry a lane replaced meanwhile (another version) is not ours to drop.
                    gone = lambda c: any(c['app'] == d['app'] and c['device'] == d['device'] and c['version'] == d['version'] for d in done + dropped)
                    older = lambda c: any(c['app'] == d['app'] and c['device'] == d['device'] and vkey(c['version']) <= vkey(d['version']) for d in done)
                    cur = [c for c in cur if not (gone(c) or older(c))]
                    save(cur)
                    prune(cur)
        return 1 if failed else 0


def main(argv):
    if not argv or argv[0] == 'retry':
        return cmd_retry()
    if argv[0] in ('record', 'clear') and len(argv) == 4:
        try:
            (cmd_record if argv[0] == 'record' else cmd_clear)(*argv[1:])
        except Exception as ex:   # bookkeeping never fails a lane; no paths or names in the message
            say('%s skipped (%s)' % (argv[0], type(ex).__name__))
        return 0
    print('usage: retry-installs.sh [retry | record|clear <App> <udid> <bundle>]', file=sys.stderr)
    return 2


try:
    sys.exit(main(sys.argv[1:]))
except SystemExit:
    raise
except Exception as ex:
    say('stopped (%s)' % type(ex).__name__)
    sys.exit(1)
PY
