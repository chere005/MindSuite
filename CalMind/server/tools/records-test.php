<?php
/**
 * The records seam (lib/records.php) on its own, both drivers, no HTTP:
 * `php server/tools/records-test.php`. The API suites (test.php and friends)
 * prove the handlers over either driver via CALMIND_STORAGE; this proves the
 * seam's own promises — sequence, rollback, sealing, concurrency, and that a
 * JSON store survives the move into the database unchanged.
 */

$root = dirname(__DIR__);
require_once $root . '/lib/records.php';
if (!defined('SYNC_SPACES')) { define('SYNC_SPACES', ['chef']); }   // app.php's list; the JSON walk skips a user's own files by it

$scratch = sys_get_temp_dir() . '/calmind-records-test-' . getmypid();
@mkdir($scratch, 0700, true);
register_shutdown_function(function () use ($scratch) {
    exec('rm -rf ' . escapeshellarg($scratch));
});

$pass = 0; $fail = 0;
function t(string $label, callable $fn): void
{
    global $pass, $fail;
    try { $fn(); $pass++; echo "  \033[32m✓\033[0m $label\n"; }
    catch (Throwable $e) { $fail++; echo "  \033[31m✗ $label — {$e->getMessage()}\033[0m\n"; }
}
function ok($cond, string $why): void { if (!$cond) { throw new RuntimeException($why); } }
function eq($want, $got, string $why = ''): void
{
    if ($want !== $got) { throw new RuntimeException("$why: wanted " . json_encode($want) . ', got ' . json_encode($got)); }
}
function throws(callable $fn, string $why): void
{
    try { $fn(); } catch (Throwable) { return; }
    throw new RuntimeException("$why: did not throw");
}
/** A fresh instance per test: its own data dir (and so its own SQLite file). */
function inst(string $driver): array
{
    global $scratch;
    static $n = 0;
    $dir = $scratch . '/' . $driver . '-' . (++$n);
    @mkdir($dir, 0700, true);
    return ['data_dir' => $dir, 'storage' => $driver, 'data_key' => 'records-test-key'];
}
$rec = fn(string $id, int $updated, $payload = ['t' => 'x'], string $type = 'note') =>
    ['id' => $id, 'type' => $type, 'updated' => $updated, 'deleted' => false, 'payload' => $payload];

foreach (['json', 'sql'] as $d) {
    echo "\n\033[1m$d\033[0m\n";

    t("$d: an empty store has nothing and no sequence", function () use ($d) {
        $cfg = inst($d);
        $rs = rs_view($cfg, 'alex', '');
        eq(0, $rs->seq(), 'seq');
        eq(null, $rs->get('nope'), 'get');
        eq([], $rs->since(0), 'since');
        eq(null, rs_export($cfg, 'alex', ''), 'export of a store that was never written');
    });

    t("$d: put hands out the next seq; since() is the ascending tail; all() filters by type", function () use ($d, $rec) {
        $cfg = inst($d);
        rs_tx($cfg, 'alex', '', function (RecordSet $rs) use ($rec) {
            eq(1, $rs->put($rec('a', 10)), 'first');
            eq(2, $rs->put($rec('b', 10, null, 'folder')), 'second');
            eq(3, $rs->put($rec('a', 11, ['t' => 'é ✓ "q"'])), 'a again');
            eq(3, $rs->seq(), 'seq inside the tx');
            eq(['b', 'a'], array_column($rs->since(0), 'id'), 'tail inside the tx sees its own writes');
        });
        $rs = rs_view($cfg, 'alex', '');
        eq(3, $rs->seq(), 'seq after commit');
        eq(['id' => 'a', 'type' => 'note', 'updated' => 11, 'deleted' => false, 'payload' => ['t' => 'é ✓ "q"'], 'seq' => 3],
           $rs->get('a'), 'the row, rebuilt to the fixed shape');
        eq(['a'], array_column($rs->since(2), 'id'), 'cursor 2');
        eq([], $rs->since(3), 'caught up');
        eq(['b'], array_keys($rs->all('folder')), 'by type');
        eq(null, $rs->get('b')['payload'], 'a null payload survives');
    });

    t("$d: only the fixed keys survive; superseded and deleted round-trip", function () use ($d) {
        $cfg = inst($d);
        rs_tx($cfg, 'alex', '', fn(RecordSet $rs) => $rs->put(
            ['id' => 'x', 'type' => 'note', 'updated' => 5, 'deleted' => 1, 'payload' => [1, 2], 'superseded' => true, 'junk' => 'dropped']));
        eq(['id' => 'x', 'type' => 'note', 'updated' => 5, 'deleted' => true, 'payload' => [1, 2], 'seq' => 1, 'superseded' => true],
           rs_view($cfg, 'alex', '')->get('x'), 'row');
    });

    t("$d: a transaction that throws leaves the store as it was", function () use ($d, $rec) {
        $cfg = inst($d);
        rs_tx($cfg, 'alex', '', fn(RecordSet $rs) => $rs->put($rec('keep', 1)));
        throws(fn() => rs_tx($cfg, 'alex', '', function (RecordSet $rs) use ($rec) {
            $rs->put($rec('lost', 2));
            $rs->put($rec('keep', 3, ['t' => 'changed']));
            throw new RuntimeException('boom');
        }), 'the throw comes back out');
        $rs = rs_view($cfg, 'alex', '');
        eq(1, $rs->seq(), 'seq unchanged');
        eq(null, $rs->get('lost'), 'the new row never landed');
        eq(['t' => 'x'], $rs->get('keep')['payload'], 'the edit never landed');
    });

    t("$d: spaces and owners are separate stores, each with its own sequence", function () use ($d, $rec) {
        $cfg = inst($d);
        rs_tx($cfg, 'alex', '', fn(RecordSet $rs) => $rs->put($rec('cal', 1)));
        rs_tx($cfg, 'alex', 'chef', function (RecordSet $rs) use ($rec) { $rs->put($rec('c1', 1)); $rs->put($rec('c2', 1)); });
        rs_tx($cfg, 'sam', '', fn(RecordSet $rs) => $rs->put($rec('s', 1)));
        eq(['cal'], array_keys(rs_view($cfg, 'alex', '')->all()), 'alex calmind');
        eq(['c1', 'c2'], array_keys(rs_view($cfg, 'alex', 'chef')->all()), 'alex chef');
        eq(2, rs_view($cfg, 'alex', 'chef')->seq(), 'chef seq is its own');
        eq(1, rs_view($cfg, 'sam', '')->seq(), 'sam');
        rs_drop($cfg, 'alex', 'chef');
        eq(null, rs_export($cfg, 'alex', 'chef'), 'dropped');
        eq(['cal'], array_keys(rs_view($cfg, 'alex', '')->all()), 'the other space untouched');
    });

    t("$d: rs_each_with_type visits every other store holding the type, in any space", function () use ($d, $rec) {
        $cfg = inst($d);
        rs_tx($cfg, 'alex', '', fn(RecordSet $rs) => $rs->put($rec('share', 1, ['partners' => ['sam']], 'share')));
        rs_tx($cfg, 'bo', 'chef', fn(RecordSet $rs) => $rs->put($rec('share', 1, ['partners' => ['sam']], 'share')));
        rs_tx($cfg, 'cy', '', fn(RecordSet $rs) => $rs->put($rec('n', 1)));
        rs_tx($cfg, 'sam', '', fn(RecordSet $rs) => $rs->put($rec('share', 1, ['partners' => ['alex']], 'share')));
        $seen = [];
        rs_each_with_type($cfg, 'share', 'sam', function (RecordSet $rs) use (&$seen) {
            foreach ($rs->all('share') as $r) {
                $seen[] = $r['payload']['partners'][0];
                $rs->put(['payload' => ['partners' => []]] + $r);
            }
        });
        eq(['sam', 'sam'], $seen, 'two stores, not the excluded owner, not a store without the type');
        eq([], rs_view($cfg, 'bo', 'chef')->get('share')['payload']['partners'], 'the write landed');
        eq(2, rs_view($cfg, 'bo', 'chef')->seq(), 'under a fresh seq');
        eq(['alex'], rs_view($cfg, 'sam', '')->get('share')['payload']['partners'], 'the excluded owner untouched');
    });

    t("$d: import then export is the identity, seqs included", function () use ($d) {
        $cfg = inst($d);
        $db = ['seq' => 9, 'recs' => [
            'a' => ['id' => 'a', 'type' => 'note', 'updated' => 1, 'deleted' => false, 'payload' => ['t' => 1], 'seq' => 4],
            'b' => ['id' => 'b', 'type' => 'reminder', 'updated' => 2, 'deleted' => true, 'payload' => null, 'seq' => 9, 'superseded' => true],
        ]];
        rs_import($cfg, 'alex', '', $db);
        eq($db, rs_export($cfg, 'alex', ''), 'round trip');
        eq(9, rs_view($cfg, 'alex', '')->seq(), 'the counter, not the highest row, is the seq');
    });

    t("$d: concurrent writers never lose an increment (real processes)", function () use ($d, $root) {
        global $scratch;
        $cfg = inst($d);
        $worker = $scratch . '/worker.php';
        file_put_contents($worker, '<?php
require_once $argv[1] . "/lib/records.php";
$cfg = ["data_dir" => $argv[2], "storage" => $argv[3], "data_key" => "records-test-key"];
for ($i = 0; $i < 30; $i++) {
    rs_tx($cfg, "alex", "", function (RecordSet $rs) {
        $n = (int) (($rs->get("count") ?? [])["payload"]["n"] ?? 0);
        usleep(300);
        $rs->put(["id" => "count", "type" => "note", "updated" => $n + 1, "payload" => ["n" => $n + 1]]);
    });
}');
        // The schema is made before the race so the workers only ever contend for rows.
        rs_view($cfg, 'alex', '');
        $procs = [];
        for ($w = 0; $w < 4; $w++) {
            $procs[] = proc_open([PHP_BINARY, $worker, $root, $cfg['data_dir'], $d], [2 => ['pipe', 'w']], $pipes);
            $errs[] = $pipes[2];
        }
        foreach ($procs as $i => $p) { $err = stream_get_contents($errs[$i]); proc_close($p); ok($err === '', "worker $i: $err"); }
        $rs = rs_view($cfg, 'alex', '');
        eq(120, $rs->get('count')['payload']['n'], 'four writers, thirty each');
        eq(120, $rs->seq(), 'one seq per write');
    });
}

echo "\n\033[1msql only\033[0m\n";

t('sql: a sealed payload is bound to its store and id — moved or altered, it refuses to open', function () use ($rec) {
    $cfg = inst('sql');
    rs_tx($cfg, 'alex', '', fn(RecordSet $rs) => $rs->put($rec('n1', 1, ['t' => 'secret text'])));
    rs_tx($cfg, 'sam', '', fn(RecordSet $rs) => $rs->put($rec('n1', 1, ['t' => 'other'])));
    $pdo = new PDO('sqlite:' . $cfg['data_dir'] . '/records.sqlite');
    $alexSeal = (string) $pdo->query("SELECT payload FROM rs_records WHERE owner = 'alex'")->fetchColumn();
    ok(str_starts_with($alexSeal, 'ENC2:') && !str_contains($alexSeal, 'secret'), 'sealed, no plaintext');
    ok(!str_contains((string) file_get_contents($cfg['data_dir'] . '/records.sqlite'), 'secret text'), 'nowhere in the file');
    $pdo->prepare("UPDATE rs_records SET payload = ? WHERE owner = 'sam'")->execute([$alexSeal]);
    throws(fn() => rs_view($cfg, 'sam', '')->get('n1'), "alex's payload under sam's name");
    $flip = substr($alexSeal, 0, -2) . (substr($alexSeal, -2, 1) === 'A' ? 'B' : 'A') . substr($alexSeal, -1);
    $pdo->prepare("UPDATE rs_records SET payload = ? WHERE owner = 'alex'")->execute([$flip]);
    throws(fn() => rs_view($cfg, 'alex', '')->since(0), 'one altered character');
});

t('sql: owners compare byte for byte, as their files did on a case-sensitive disk', function () use ($rec) {
    $cfg = inst('sql');
    rs_tx($cfg, 'Alex', '', fn(RecordSet $rs) => $rs->put($rec('a', 1)));
    eq(null, rs_export($cfg, 'alex', ''), 'alex is not Alex');
});

t('sql: a read-only view refuses to write', function () use ($rec) {
    $cfg = inst('sql');
    throws(fn() => rs_view($cfg, 'alex', '')->put($rec('a', 1)), 'put through rs_view');
});

t('json → sql: every store moves across unchanged (the migration path)', function () use ($rec) {
    $json = inst('json');
    rs_tx($json, 'alex', '', function (RecordSet $rs) use ($rec) { for ($i = 0; $i < 50; $i++) { $rs->put($rec("r$i", $i + 1, ['i' => $i])); } });
    rs_tx($json, 'alex', 'chef', fn(RecordSet $rs) => $rs->put($rec('recipe', 1, ['title' => 'Soup'])));
    $sql = ['storage' => 'sql'] + $json;
    foreach ([['alex', ''], ['alex', 'chef']] as [$u, $s]) {
        rs_import($sql, $u, $s, rs_export($json, $u, $s));
        eq(rs_export($json, $u, $s), rs_export($sql, $u, $s), "$u/$s identical");
    }
});

echo "\n────────────────────────────────\n$pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
