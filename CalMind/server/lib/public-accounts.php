<?php
/**
 * Public accounts: the sign-in strangers get when CalMind and MealMind are in the App Store. Built, and OFF.
 *
 * WHY A STORE OF THEIR OWN. The household's accounts are the suite's (the site's auth.json): one sign-in that also
 * opens the site, PlanMind, TaskMind and the AcctMind web copy. Opening THAT sign-up to the public would hand every
 * stranger a key to all of them, and a bug in any one app's check would be a door into the rest. A public account lives
 * in these tables instead, which nothing but this API reads, so by construction it can sync and share in CalMind and
 * MealMind (one account, both apps, the `chef` space as today) and can never sign in anywhere else.
 *
 * WHY TABLES. The suite store is one encrypted JSON file holding every account and session, rewritten whole under one
 * lock on every sign-in. That is right for a household and wrong for strangers in numbers. These live in the same
 * database as the records (lib/records.php, rs_pdo): a sign-in is one indexed row, a request one indexed lookup.
 *
 * Public usernames are handles. An immutable owner ID outside the username alphabet identifies a single account
 * lifetime in sync, sharing, sessions and device snapshots. A later account with the same name gets a new owner ID.
 *
 * ON: config `public_accounts` => true (or CALMIND_PUBLIC_ACCOUNTS=1), which also needs the database (`storage` =>
 * 'sql' for the records is the intended pairing; the tables work with either records driver). OFF changes nothing:
 * pa_route() refuses explicit public sign-in and sign-up without opening the database.
 *
 * NOT BUILT (docs/PUBLIC-MODEL.md): email verification, password reset by email, passkeys, per-account storage
 * quota. The actions that would need those features answer 501 for a public account.
 */

require_once __DIR__ . '/records.php';

const PA_SIGNUP_GLOBAL_HOUR = 30;   // public sign-ups, whole site
const PA_SIGNUP_GLOBAL_DAY  = 200;
const PA_SIGNUP_IP_HOUR     = 5;    // per client address (a speed bump on NFSN, where the client picks REMOTE_ADDR)
const PA_LOGIN_FAILS        = 10;   // wrong passwords per account per hour before it locks for the hour
const PA_SEEN_EVERY         = 3600; // last_seen is written at most hourly, so a poll is a read
const PA_FETCH_HOUR         = 60;   // recipe_fetch per account per hour while public accounts are on

function pa_is_owner(string $owner): bool
{
    return preg_match('/\A~p-[a-f0-9]{24}\z/', $owner) === 1;
}

function pa_enabled(array $cfg): bool
{
    return !empty($cfg['public_accounts']) || getenv('CALMIND_PUBLIC_ACCOUNTS') === '1';
}

function pa_pdo(array $cfg): PDO
{
    $pdo = rs_pdo(['storage' => 'sql'] + $cfg);
    static $made = [];
    $key = spl_object_id($pdo);
    if (!isset($made[$key])) {
        $mysql = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql';
        $name  = $mysql ? 'VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL' : 'TEXT NOT NULL';
        $hex   = $mysql ? 'CHAR(64) CHARACTER SET ascii NOT NULL' : 'TEXT NOT NULL';
        $text  = $mysql ? 'VARCHAR(255) NOT NULL' : 'TEXT NOT NULL';
        $tail  = $mysql ? ' ENGINE=InnoDB' : '';
        $pdo->exec("CREATE TABLE IF NOT EXISTS pa_accounts (name $name, email $text, hash $text, created BIGINT NOT NULL,"
            . " PRIMARY KEY (name))$tail");
        $pdo->exec("CREATE TABLE IF NOT EXISTS pa_owners (name $name, owner $name, deleting SMALLINT NOT NULL DEFAULT 0,"
            . " PRIMARY KEY (name), UNIQUE (owner))$tail");
        // The `name` column now carries the owner ID. Earlier rows contain usernames and cannot join to an owner.
        $pdo->exec("CREATE TABLE IF NOT EXISTS pa_tokens (id $hex, name $name, created BIGINT NOT NULL,"
            . " last_seen BIGINT NOT NULL, PRIMARY KEY (id))$tail");
        $has = $mysql && (int) $pdo->query("SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'pa_tokens' AND index_name = 'pa_tokens_name'")->fetchColumn() > 0;
        if (!$has) { $pdo->exec('CREATE INDEX ' . ($mysql ? '' : 'IF NOT EXISTS ') . 'pa_tokens_name ON pa_tokens (name)'); }
        $made[$key] = true;
    }
    return $pdo;
}

function pa_account(PDO $pdo, string $name, bool $lock = false): ?array
{
    $q = $pdo->prepare('SELECT a.name, a.hash, o.owner, o.deleting FROM pa_accounts a'
        . ' LEFT JOIN pa_owners o ON o.name = a.name WHERE a.name = ?'
        . ($lock && $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? ' FOR UPDATE' : ''));
    $q->execute([$name]);
    $row = $q->fetch();
    return $row === false ? null : $row;
}

function pa_new_owner(PDO $pdo, string $name): string
{
    $owner = '~p-' . bin2hex(random_bytes(12));
    $pdo->prepare('INSERT INTO pa_owners (name, owner) VALUES (?, ?)')->execute([$name, $owner]);
    return $owner;
}

/** 0 for active, 1 during deletion, null after the account is gone. */
function pa_owner_state(array $cfg, string $owner): ?int
{
    $q = pa_pdo($cfg)->prepare('SELECT o.deleting FROM pa_owners o JOIN pa_accounts a ON a.name = o.name WHERE o.owner = ?');
    $q->execute([$owner]);
    $state = $q->fetchColumn();
    return $state === false ? null : (int) $state;
}

function pa_require_active(?int $state): void
{
    if ($state === 1) { fail(423, 'account deletion is in progress'); }
    if ($state !== 0) { fail(401, 'account no longer exists'); }
}

/** Is the name taken in the legacy store or the suite's? A public account may never share a name with either. */
function pa_name_elsewhere(array $cfg, string $name): bool
{
    foreach (array_keys(store_read($cfg, accounts_file($cfg))) as $legacy) {
        if (strtolower((string) $legacy) === $name) { return true; }
    }
    $suite = suite_auth($cfg, 'site');
    if ($suite['shared']) {
        if (($suite['auth'] ?? null) === null) { fail_shared(503, 'sign-in unavailable'); }
        if (msa_account_exists(suite_cfg($suite), $name) || msa_account_deleted(suite_cfg($suite), $name)) { return true; }
    }
    return false;
}

/** Issue a token while the caller holds the account lock. */
function pa_issue(PDO $pdo, string $owner): string
{
    $token = bin2hex(random_bytes(32));
    $now = time();
    $pdo->prepare('INSERT INTO pa_tokens (id, name, created, last_seen) VALUES (?, ?, ?, ?)')
        ->execute([hash('sha256', $token), $owner, $now, $now]);
    return $token;
}

/** The bearer identifies one account lifetime. A deleting account can only authenticate a retry of deletion. */
function pa_bearer_account(array $cfg): ?array
{
    if (!preg_match('/\ABearer\s+([a-f0-9]{64})\z/', (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? ''), $m)) { return null; }
    $pdo = pa_pdo($cfg);
    $id = hash('sha256', $m[1]);
    $q = $pdo->prepare('SELECT o.name, o.owner, o.deleting, t.id, t.last_seen FROM pa_tokens t'
        . ' JOIN pa_owners o ON o.owner = t.name JOIN pa_accounts a ON a.name = o.name WHERE t.id = ?');
    $q->execute([$id]);
    $row = $q->fetch();
    if ($row === false) { return null; }
    if ((int) $row['deleting'] === 0 && (int) $row['last_seen'] < time() - PA_SEEN_EVERY) {
        $pdo->prepare('UPDATE pa_tokens SET last_seen = ? WHERE id = ?')->execute([time(), $id]);
    }
    return $row;
}

/** The public-account half of the API: answers (and exits) for what is a public account's, returns for everything else. */
function pa_route(array $cfg, array $in): void
{
    $action = (string) ($in['action'] ?? '');
    $signup = $action === 'public_signup' || ($action === 'signup' && !empty($in['public']));
    $login = $action === 'public_login';
    if (!pa_enabled($cfg)) {
        if ($signup || $login) { fail(403, 'public accounts are unavailable'); }
        return;
    }
    if (($signup || $login) && ($in['account_ids'] ?? null) !== true) {
        fail(409, 'update the app to sign in to a public account');
    }
    if ($signup) { pa_signup($cfg, $in); }
    if ($login) { pa_login($cfg, $in); }
    if ($action === 'signup' || $action === 'login') { return; }
    $who = pa_bearer_account($cfg);
    if ($who === null) { return; }
    if ($action !== 'delete_account') { pa_require_active((int) $who['deleting']); }
    match ($action) {
        'whoami' => reply(200, ['ok' => true, 'username' => $who['name'], 'account_id' => $who['owner'], 'public' => true]),
        'logout' => pa_logout($cfg, $who),
        'delete_account' => pa_delete($cfg, $who),
        'change_password' => pa_change_password($cfg, $who, $in),
        'sync', 'shared_pull', 'shared_put', 'recipe_fetch', 'calsub_fetch', 'calsub_discover',
        'signin_info', 'spaces', 'health', 'meetreq_slots', 'meetreq_create' => null,
        default => fail(501, 'not available for this account yet'),
    };
}

function pa_signup(array $cfg, array $in): never
{
    $name  = strtolower((string) ($in['username'] ?? ''));
    $email = trim((string) ($in['email'] ?? ''));
    $pass  = (string) ($in['password'] ?? '');
    if (!preg_match('/\A[a-z0-9_-]{2,20}\z/', $name)) { fail(400, 'username: 2-20 letters, numbers, - or _'); }
    if (rs_name_reserved($name))                      { fail(400, 'that username is reserved'); }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL))   { fail(400, 'that email address doesn\'t look right'); }
    if (strlen($pass) < 8 || strlen($pass) > 72)      { fail(400, 'password: 8 to 72 characters'); }
    // Caps before any work, and the per-address bump after them (the pattern recover uses).
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '-');
    if (!cap_take($cfg, 'pa-signup', [
            ['key' => 'g', 'max' => PA_SIGNUP_GLOBAL_HOUR, 'window' => 3600],
            ['key' => 'g', 'max' => PA_SIGNUP_GLOBAL_DAY,  'window' => 86400],
        ]) || !abuse_take($cfg, 'pa-signup', [['key' => 'ip:' . hash('sha256', $ip), 'max' => PA_SIGNUP_IP_HOUR]])) {
        fail(429, 'too many sign-ups right now — try again later');
    }
    if (pa_name_elsewhere($cfg, $name)) { fail(409, 'that username is taken'); }
    $pdo = pa_pdo($cfg);
    $hash = password_hash($pass, PASSWORD_BCRYPT);
    try {
        [$owner, $token] = rs_transaction($pdo, function () use ($pdo, $name, $email, $hash) {
            $pdo->prepare('INSERT INTO pa_accounts (name, email, hash, created) VALUES (?, ?, ?, ?)')
                ->execute([$name, $email, $hash, time()]);
            $owner = pa_new_owner($pdo, $name);
            return [$owner, pa_issue($pdo, $owner)];
        });
    } catch (PDOException $e) {
        if ((string) $e->getCode() === '23000') { fail(409, 'that username is taken'); }
        throw $e;
    }
    usage_log($cfg, 'signup_public', $owner);
    pa_reply_session($name, $owner, $token);
}

function pa_reply_session(string $name, string $owner, string $token): never
{
    reply(200, ['ok' => true, 'token' => $token, 'username' => $name, 'account_id' => $owner, 'public' => true]);
}

/** Public sign-in only. The suite can later claim the same handle without affecting either account. */
function pa_login(array $cfg, array $in): never
{
    $name = strtolower((string) ($in['username'] ?? ''));
    if (!preg_match('/\A[a-z0-9_-]{2,20}\z/', $name)) { fail(401, 'wrong username or password'); }
    $pdo = pa_pdo($cfg);
    $acc = pa_account($pdo, $name);
    if ($acc === null || (int) $acc['deleting'] !== 0) { fail(401, 'wrong username or password'); }
    $key = [['key' => 'u:' . hash('sha256', $acc['owner'] ?? 'legacy:' . $name), 'max' => PA_LOGIN_FAILS]];
    // Locked is answered BEFORE the password is looked at, the same for a right and a wrong one, so a locked account
    // tells a guesser nothing. Only failures count toward it.
    if (!abuse_peek($cfg, 'pa-login', $key)) { fail(429, 'too many attempts — try again in an hour'); }
    if (!password_verify((string) ($in['password'] ?? ''), (string) $acc['hash'])) {
        abuse_take($cfg, 'pa-login', $key);
        usage_log($cfg, 'login_fail_public', $acc['owner'] ?? '-');
        fail(401, 'wrong username or password');
    }
    $session = rs_transaction($pdo, function () use ($pdo, $name, $acc) {
        $current = pa_account($pdo, $name, true);
        if ($current === null || (int) $current['deleting'] !== 0 || $current['hash'] !== $acc['hash']
            || ($acc['owner'] !== null && $current['owner'] !== $acc['owner'])) { return null; }
        // An earlier trial account keeps its verified credentials. Its old username-keyed records and tokens
        // are never assigned to the new owner because they cannot prove which identity wrote them.
        $owner = $current['owner'] ?? pa_new_owner($pdo, $name);
        return [$owner, pa_issue($pdo, $owner)];
    });
    if ($session === null) { fail(401, 'wrong username or password'); }
    [$owner, $token] = $session;
    usage_log($cfg, 'login_public', $owner);
    pa_reply_session($name, $owner, $token);
}

/** Would abuse_take() pass these rules now, without counting this look? */
function abuse_peek(array $cfg, string $name, array $rules): bool
{
    $all = store_read($cfg, $cfg['data_dir'] . '/abuse-' . $name . '.json');
    foreach ($rules as $r) {
        $recent = array_filter((array) ($all[$r['key']] ?? []), fn($t) => $t > time() - 3600);
        if (count($recent) >= $r['max']) { return false; }
    }
    return true;
}

function pa_logout(array $cfg, array $who): never
{
    pa_pdo($cfg)->prepare('DELETE FROM pa_tokens WHERE id = ?')->execute([$who['id']]);
    usage_log($cfg, 'logout', $who['owner']);
    reply(200, ['ok' => true]);
}

/** Recheck the token and generation under the name's credential lock. */
function pa_locked_account(PDO $pdo, array $who): ?array
{
    $acc = pa_account($pdo, $who['name'], true);
    if ($acc === null || $acc['owner'] !== $who['owner']) { return null; }
    $q = $pdo->prepare('SELECT 1 FROM pa_tokens WHERE id = ? AND name = ?');
    $q->execute([$who['id'], $who['owner']]);
    return $q->fetchColumn() === false ? null : $acc;
}

function pa_change_password(array $cfg, array $who, array $in): never
{
    $pdo = pa_pdo($cfg);
    $acc = pa_account($pdo, $who['name']);
    $new = (string) ($in['newPassword'] ?? $in['new'] ?? '');
    if ($acc === null || $acc['owner'] !== $who['owner'] || (int) $acc['deleting'] !== 0) { fail(401, 'account no longer exists'); }
    if (!password_verify((string) ($in['password'] ?? $in['old'] ?? ''), (string) $acc['hash'])) { fail(403, 'current password is wrong'); }
    if (strlen($new) < 8 || strlen($new) > 72) { fail(400, 'password: 8 to 72 characters'); }
    $hash = password_hash($new, PASSWORD_BCRYPT);
    $changed = rs_transaction($pdo, function () use ($pdo, $who, $acc, $hash) {
        $current = pa_locked_account($pdo, $who);
        if ($current === null || (int) $current['deleting'] !== 0 || $current['hash'] !== $acc['hash']) { return false; }
        $pdo->prepare('UPDATE pa_accounts SET hash = ? WHERE name = ?')->execute([$hash, $who['name']]);
        $pdo->prepare('DELETE FROM pa_tokens WHERE name = ? AND id <> ?')->execute([$who['owner'], $who['id']]);
        return true;
    });
    if (!$changed) { fail(401, 'account changed; sign in again'); }
    usage_log($cfg, 'change_password_public', $who['owner']);
    reply(200, ['ok' => true]);
}

/**
 * Reserve the name and block ordinary authentication until cleanup is complete. An interrupted cleanup can resume
 * using an existing token on this action only. Every purge and finalisation targets the original owner ID.
 */
function pa_delete(array $cfg, array $who): never
{
    $pdo = pa_pdo($cfg);
    $marked = rs_transaction($pdo, function () use ($pdo, $who) {
        if (pa_locked_account($pdo, $who) === null) { return false; }
        $pdo->prepare('UPDATE pa_owners SET deleting = 1 WHERE owner = ?')->execute([$who['owner']]);
        return true;
    });
    if (!$marked) { fail(401, 'account no longer exists'); }
    try {
        purge_account_data($cfg, $who['owner'], '');
        rs_transaction($pdo, function () use ($pdo, $who) {
            // A concurrent deletion may have finished and released the username while this request was purging.
            if (pa_locked_account($pdo, $who) === null) { return; }
            $pdo->prepare('DELETE FROM pa_tokens WHERE name IN (?, ?)')->execute([$who['owner'], $who['name']]);
            $pdo->prepare('DELETE FROM pa_owners WHERE owner = ?')->execute([$who['owner']]);
            $pdo->prepare('DELETE FROM pa_accounts WHERE name = ?')->execute([$who['name']]);
        });
    } catch (Throwable $e) {
        error_log('public account deletion interrupted: ' . get_class($e));
        fail(503, 'could not finish deleting the account; try again');
    }
    usage_log($cfg, 'delete_account_public', '-');
    reply(200, ['ok' => true]);
}
