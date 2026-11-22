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
 * NAMES. A public name shares the records namespace (records are keyed by username), so sign-up refuses any name the
 * legacy store or the suite store already holds, and a public sign-in is refused if the suite has since taken the name
 * (only the operator can create suite accounts: invite-only). Names that begin `<space>-` are refused everywhere
 * (rs_name_reserved).
 *
 * ON: config `public_accounts` => true (or CALMIND_PUBLIC_ACCOUNTS=1), which also needs the database (`storage` =>
 * 'sql' for the records is the intended pairing; the tables work with either records driver). OFF changes nothing:
 * pa_route() is never called and require_auth() never looks here.
 *
 * NOT BUILT (docs/PUBLIC-MODEL.md): email verification, password reset by email, passkeys, per-account storage
 * quota, the app's sign-up screen for this path. The actions that would need them answer 501 for a public account.
 */

require_once __DIR__ . '/records.php';

const PA_SIGNUP_GLOBAL_HOUR = 30;   // public sign-ups, whole site
const PA_SIGNUP_GLOBAL_DAY  = 200;
const PA_SIGNUP_IP_HOUR     = 5;    // per client address (a speed bump on NFSN, where the client picks REMOTE_ADDR)
const PA_LOGIN_FAILS        = 10;   // wrong passwords per account per hour before it locks for the hour
const PA_SEEN_EVERY         = 3600; // last_seen is written at most hourly, so a poll is a read
const PA_FETCH_HOUR         = 60;   // recipe_fetch per account per hour while public accounts are on

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
        $pdo->exec("CREATE TABLE IF NOT EXISTS pa_tokens (id $hex, name $name, created BIGINT NOT NULL,"
            . " last_seen BIGINT NOT NULL, PRIMARY KEY (id))$tail");
        $has = $mysql && (int) $pdo->query("SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'pa_tokens' AND index_name = 'pa_tokens_name'")->fetchColumn() > 0;
        if (!$has) { $pdo->exec('CREATE INDEX ' . ($mysql ? '' : 'IF NOT EXISTS ') . 'pa_tokens_name ON pa_tokens (name)'); }
        $made[$key] = true;
    }
    return $pdo;
}

function pa_account(array $cfg, string $name): ?array
{
    $q = pa_pdo($cfg)->prepare('SELECT * FROM pa_accounts WHERE name = ?');
    $q->execute([$name]);
    $row = $q->fetch();
    return $row === false ? null : $row;
}

/** Is the name taken in the legacy store or the suite's? A public account may never share a name with either. */
function pa_name_elsewhere(array $cfg, string $name): bool
{
    foreach (array_keys(store_read($cfg, accounts_file($cfg))) as $legacy) {
        if (strtolower((string) $legacy) === $name) { return true; }
    }
    $suite = suite_auth($cfg);
    if ($suite['shared']) {
        if (($suite['auth'] ?? null) === null) { fail_shared(503, 'sign-in unavailable'); }
        if (msa_account_exists(suite_cfg($suite), $name) || msa_account_deleted(suite_cfg($suite), $name)) { return true; }
    }
    return false;
}

function pa_issue(array $cfg, string $name): string
{
    $token = bin2hex(random_bytes(32));
    $now = time();
    pa_pdo($cfg)->prepare('INSERT INTO pa_tokens (id, name, created, last_seen) VALUES (?, ?, ?, ?)')
        ->execute([hash('sha256', $token), $name, $now, $now]);
    return $token;
}

/** The bearer's public account, or null when the request carries no public token (it may be a suite or legacy one). */
function pa_bearer_user(array $cfg): ?string
{
    if (!preg_match('/^Bearer\s+([a-f0-9]{64})$/', (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? ''), $m)) { return null; }
    $pdo = pa_pdo($cfg);
    $id = hash('sha256', $m[1]);
    $q = $pdo->prepare('SELECT t.name, t.last_seen FROM pa_tokens t JOIN pa_accounts a ON a.name = t.name WHERE t.id = ?');
    $q->execute([$id]);
    $row = $q->fetch();
    if ($row === false) { return null; }
    if ((int) $row['last_seen'] < time() - PA_SEEN_EVERY) {
        $pdo->prepare('UPDATE pa_tokens SET last_seen = ? WHERE id = ?')->execute([time(), $id]);
    }
    return (string) $row['name'];
}

/** The public-account half of the API: answers (and exits) for what is a public account's, returns for everything else. */
function pa_route(array $cfg, array $in): void
{
    $action = (string) ($in['action'] ?? '');
    $who = in_array($action, ['signup', 'login'], true) ? null : pa_bearer_user($cfg);
    match (true) {
        $action === 'signup' && !empty($in['public']) => pa_signup($cfg, $in),
        $action === 'login'                           => pa_login_if_public($cfg, $in),
        $who === null                                 => null,
        $action === 'whoami'                          => reply(200, ['ok' => true, 'username' => $who, 'public' => true]),
        $action === 'logout'                          => pa_logout($cfg, $who),
        $action === 'delete_account'                  => pa_delete($cfg, $who),
        $action === 'change_password'                 => pa_change_password($cfg, $who, $in),
        in_array($action, ['recover', 'reset', 'signin_redeem', 'meetreq_day', 'meetreq_mail',
                           'passkey_register_begin', 'passkey_register_finish', 'passkey_list', 'passkey_remove'], true)
                                                      => fail(501, 'not available for this account yet'),
        default                                       => null,   // sync, sharing, recipe_fetch, calsub: require_auth() knows the token
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
    try {
        $pdo->prepare('INSERT INTO pa_accounts (name, email, hash, created) VALUES (?, ?, ?, ?)')
            ->execute([$name, $email, password_hash($pass, PASSWORD_BCRYPT), time()]);
    } catch (PDOException) {
        fail(409, 'that username is taken');   // the primary key decides a race between two sign-ups
    }
    usage_log($cfg, 'signup_public', $name);
    reply(200, ['ok' => true, 'token' => pa_issue($cfg, $name), 'username' => $name, 'public' => true]);
}

/** Signs in a public account; returns (to the household path) for any name that is not one. */
function pa_login_if_public(array $cfg, array $in): void
{
    $name = strtolower((string) ($in['username'] ?? ''));
    $acc = preg_match('/\A[a-z0-9_-]{2,20}\z/', $name) ? pa_account($cfg, $name) : null;
    if ($acc === null) { return; }
    $key = [['key' => 'u:' . hash('sha256', $name), 'max' => PA_LOGIN_FAILS]];
    // Locked is answered BEFORE the password is looked at, the same for a right and a wrong one, so a locked account
    // tells a guesser nothing. Only failures count toward it.
    if (!abuse_peek($cfg, 'pa-login', $key)) { fail(429, 'too many attempts — try again in an hour'); }
    if (!password_verify((string) ($in['password'] ?? ''), (string) $acc['hash'])) {
        abuse_take($cfg, 'pa-login', $key);
        usage_log($cfg, 'login_fail_public', $name);
        fail(401, 'wrong username or password');
    }
    if (pa_name_elsewhere($cfg, $name)) {
        // Only the operator can create suite accounts; one created under a public name is refused rather than merged.
        usage_log($cfg, 'login_conflict_public', $name);
        fail(409, 'this account needs attention — contact support');
    }
    usage_log($cfg, 'login_public', $name);
    reply(200, ['ok' => true, 'token' => pa_issue($cfg, $name), 'username' => $name, 'public' => true]);
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

function pa_logout(array $cfg, string $name): never
{
    preg_match('/([a-f0-9]{64})$/', (string) $_SERVER['HTTP_AUTHORIZATION'], $m);
    pa_pdo($cfg)->prepare('DELETE FROM pa_tokens WHERE id = ?')->execute([hash('sha256', $m[1])]);
    usage_log($cfg, 'logout', $name);
    reply(200, ['ok' => true]);
}

function pa_change_password(array $cfg, string $name, array $in): never
{
    $acc = pa_account($cfg, $name);
    $new = (string) ($in['newPassword'] ?? $in['new'] ?? '');
    if ($acc === null) { fail(401, 'account no longer exists'); }
    if (!password_verify((string) ($in['password'] ?? $in['old'] ?? ''), (string) $acc['hash'])) { fail(403, 'current password is wrong'); }
    if (strlen($new) < 8 || strlen($new) > 72) { fail(400, 'password: 8 to 72 characters'); }
    preg_match('/([a-f0-9]{64})$/', (string) $_SERVER['HTTP_AUTHORIZATION'], $m);
    $pdo = pa_pdo($cfg);
    $pdo->prepare('UPDATE pa_accounts SET hash = ? WHERE name = ?')->execute([password_hash($new, PASSWORD_BCRYPT), $name]);
    // Every other device signs in again; this one keeps its token.
    $pdo->prepare('DELETE FROM pa_tokens WHERE name = ? AND id <> ?')->execute([$name, hash('sha256', $m[1])]);
    usage_log($cfg, 'change_password_public', $name);
    reply(200, ['ok' => true]);
}

/**
 * Deletion: the account and every token first (so nothing can sign in mid-way), then everything the account left
 * behind, by the same purge a legacy deletion runs. The name is then free; a later sign-up under it starts empty,
 * because the purge removed every space's records.
 */
function pa_delete(array $cfg, string $name): never
{
    $acc = pa_account($cfg, $name);
    if ($acc === null) { fail(401, 'account no longer exists'); }
    $pdo = pa_pdo($cfg);
    $pdo->prepare('DELETE FROM pa_tokens WHERE name = ?')->execute([$name]);
    $pdo->prepare('DELETE FROM pa_accounts WHERE name = ?')->execute([$name]);
    purge_account_data($cfg, $name, (string) $acc['email']);
    usage_log($cfg, 'delete_account_public', '-');
    reply(200, ['ok' => true]);
}
