#!/bin/sh
# Does tools/server-config.sh do what it claims, and refuse what it should?
#
# ssh, scp, curl and chgrp are STUBS on PATH: a fake host is a directory (/home/... and /usr/local/bin/... are mapped
# into it), ssh runs the command against that directory, curl answers `health` from a file. No live host, no network,
# no deploy.conf of the real kind. Every refusal is proved by running it and watching the "server" file stay byte for
# byte the same.
#
#   sh tools/test-server-config.sh
set -u
cd "$(dirname "$0")/.."

R=$(mktemp -d "${TMPDIR:-/tmp}/scfgtest.XXXXXX")
trap 'rm -rf "$R"' EXIT
FS="$R/fs"; BIN="$R/bin"; mkdir -p "$BIN" "$R/tmp" "$FS/usr/local/bin"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }

printf 'SSH_DEST="placeholder@ssh.example.test"\n' > "$R/deploy.conf"
printf '#!/bin/sh\necho PHP\n' > "$FS/usr/local/bin/php"; chmod 755 "$FS/usr/local/bin/php"
printf 'not executable\n' > "$FS/usr/local/bin/plain"; chmod 644 "$FS/usr/local/bin/plain"

cat > "$BIN/map" <<EOF
#!/bin/sh
sed -e "s#/home/#$FS/home/#g" -e "s#/usr/local/bin/#$FS/usr/local/bin/#g"
EOF
cat > "$BIN/scp" <<EOF
#!/bin/sh
echo "scp \$*" >> "$R/calls.log"
[ "\$1" = "-q" ] && shift
conv() { case "\$1" in placeholder@*:*) echo "\$1" | sed 's#^[^:]*:##' | $BIN/map ;; *) echo "\$1" ;; esac; }
src=\$(conv "\$1"); dst=\$(conv "\$2")
case "\$1" in placeholder@*:*/config.php)
    n=\$(cat "$R/reads" 2>/dev/null || echo 0); n=\$((n+1)); echo \$n > "$R/reads"
    if [ -f "$R/race" ] && [ "\$n" = 2 ]; then printf '// raced\n' >> "$FS/home/protected/calmind-prod/lib/config.php"; fi ;;
esac
cp "\$src" "\$dst"
EOF
cat > "$BIN/ssh" <<EOF
#!/bin/sh
echo "ssh \$*" >> "$R/calls.log"
shift
cmd=\$(echo "\$*" | $BIN/map)
case "\$cmd" in *"php -l"*) [ -f "$R/fail-lint" ] && exit 1 ;; esac
exec sh -c "\$cmd"
EOF
cat > "$BIN/curl" <<EOF
#!/bin/sh
echo "curl \$*" >> "$R/calls.log"
[ -f "$R/health.json" ] || exit 22
cat "$R/health.json"
EOF
printf '#!/bin/sh\nexit 0\n' > "$BIN/chgrp"
chmod 755 "$BIN"/*

export PATH="$BIN:$PATH" TMPDIR="$R/tmp" CALMIND_DEPLOY_CONF="$R/deploy.conf" CALMIND_SERVER_CONFIG_STATE="$R/state" SERVER_CONFIG_SLEEP=0
SC="sh tools/server-config.sh"
PROD="$FS/home/protected/calmind-prod/lib/config.php"
mkdir -p "$(dirname "$PROD")"
reset_live() {
    cat > "$PROD" <<'PHP'
<?php
return [
    'data_dir' => '/home/protected/calmind-prod/data',
    'data_key' => 'LIVE-KEY-1',
    'mail_enabled' => true,
    'smtp_host' => 'smtp.example.test',
    'smtp_pass' => 'LIVE-SECRET-1',
    'meetreq_user' => 'owner1',
];
PHP
    chmod 640 "$PROD"
    rm -f "$R/reads" "$R/race" "$R/fail-lint"
    printf '{"ok":true,"mailWorker":"ok"}' > "$R/health.json"
}
run() { OUT=$("$@" 2>&1 </dev/null); RC=$?; printf '%s\n' "$OUT" >> "$R/all.out"; }
live_sum() { shasum -a 256 "$PROD" | cut -d' ' -f1; }
val() { php -r '$c = require $argv[1]; echo json_encode($c[$argv[2]] ?? "<unset>", JSON_UNESCAPED_SLASHES);' "$PROD" "$1"; }
refused() {   # label, then the command; the live file must be unchanged
    before=$(live_sum); run "$@"; after=$(live_sum)
    if [ "$RC" -ne 0 ] && [ "$before" = "$after" ]; then ok "refused, nothing changed: $LABEL"; else bad "NOT refused or changed the file (exit $RC): $LABEL — $OUT"; fi
}

reset_live
echo "where / table"
for I in test dev prod; do
    set -- $($SC where $I); LIB=${1%/config.php}; URL=$2
    if grep -q "LIB_DEST=\"$LIB\"" server/deploy.sh && grep -q "SITE_URL=\"$URL\"" server/deploy.sh; then ok "$I: lib and URL match deploy.sh"; else bad "$I: table disagrees with deploy.sh"; fi
done
LABEL="bad instance"; refused $SC where staging

echo "show-keys"
run $SC show-keys prod
[ "$RC" = 0 ] && ok "show-keys exits 0" || bad "show-keys exit $RC: $OUT"
case "$OUT" in *"mail_enabled: bool"*"smtp_pass: string["*) ok "names and shapes" ;; *) bad "shapes missing: $OUT" ;; esac
case "$OUT" in *debug_log_codes*) bad "lists debug_log_codes" ;; *) ok "debug_log_codes is not offered" ;; esac
case "$OUT" in *"not set:"*php_bin*) ok "lists documented keys that are unset" ;; *) bad "unset list missing php_bin: $OUT" ;; esac
case "$OUT" in *LIVE-*|*smtp.example.test*|*owner1*|*calmind-prod/data*) bad "show-keys printed a value" ;; *) ok "no value printed" ;; esac

echo "set-str php_bin"
run $SC set-str php_bin /usr/local/bin/php prod
[ "$RC" = 0 ] && ok "exit 0" || bad "exit $RC: $OUT"
[ "$(val php_bin)" = '"/usr/local/bin/php"' ] && ok "php_bin written" || bad "php_bin is $(val php_bin)"
[ "$(val smtp_host)" = '"smtp.example.test"' ] && [ "$(val data_key)" = '"LIVE-KEY-1"' ] && [ "$(val mail_enabled)" = true ] && ok "every other key kept" || bad "another key changed"
case "$OUT" in *"mailWorker: ok"*) ok "reports the served health" ;; *) bad "no health line: $OUT" ;; esac
ls "$(dirname "$PROD")" | grep -q '\.new$\|\.prev$' && bad "a .new/.prev was left on the host" || ok "no .new/.prev left on the host"
[ "$(stat -f %Lp "$PROD" 2>/dev/null || stat -c %a "$PROD")" = 640 ] && ok "mode 640" || bad "mode changed"
grep -q 'calmind-prod/lib/config.php.new' "$R/calls.log" && ok "prod writes only prod's lib" || bad "wrong target"
grep -q 'calmind/lib\|calmind-dev' "$R/calls.log" && bad "touched another instance's path" || ok "no other instance's path touched"
[ -z "$(ls "$R/tmp")" ] && [ ! -e "$R/state" ] && ok "no pulled copy left on this machine" || bad "left behind: $(ls "$R/tmp")"

echo "mail on, worker still missing"
reset_live; printf '{"ok":true,"mailWorker":"missing"}' > "$R/health.json"
run $SC set-str smtp_host smtp2.example.test prod
[ "$RC" = 3 ] && [ "$(val smtp_host)" = '"smtp2.example.test"' ] && ok "exit 3: applied, and says the worker is missing" || bad "exit $RC: $OUT"
case "$OUT" in *"set-str php_bin"*) ok "names the fix" ;; *) bad "no fix named" ;; esac

echo "set-flag / unset / ints"
reset_live
run $SC set-flag mail_enabled off prod; [ "$RC" = 0 ] && [ "$(val mail_enabled)" = false ] && ok "set-flag off" || bad "set-flag off: $RC $OUT"
run $SC set-flag mail_enabled on prod;  [ "$RC" = 0 ] && [ "$(val mail_enabled)" = true ] && ok "set-flag on" || bad "set-flag on: $RC $OUT"
run $SC set-str smtp_port 465 prod;      [ "$RC" = 0 ] && [ "$(val smtp_port)" = 465 ] && ok "smtp_port stored as an integer" || bad "smtp_port: $RC $OUT"
run $SC unset smtp_port prod;            [ "$RC" = 0 ] && [ "$(val smtp_port)" = '"<unset>"' ] && ok "unset removes the key" || bad "unset: $RC $OUT"

echo "refusals (the live file stays byte for byte the same)"
reset_live
LABEL="php_bin relative";            refused $SC set-str php_bin php prod
LABEL="php_bin with ..";             refused $SC set-str php_bin /usr/local/../bin/php prod
LABEL="php_bin with a space/quote";  refused $SC set-str php_bin "/usr/local/bin/php; id" prod
LABEL="php_bin not on the server";   refused $SC set-str php_bin /usr/local/bin/nope prod
LABEL="php_bin not executable";      refused $SC set-str php_bin /usr/local/bin/plain prod
LABEL="php_bin a Mac path";          refused $SC set-str php_bin /Users/you/php prod
LABEL="unknown key";                 refused $SC set-str not_a_key x prod
LABEL="debug_log_codes";             refused $SC set-flag debug_log_codes on prod
LABEL="unknown key (unset)";         refused $SC unset not_a_key prod
LABEL="set data_key";                refused $SC set-str data_key abc prod
LABEL="unset data_key";              refused $SC unset data_key prod
LABEL="set-flag on a string key";    refused $SC set-flag smtp_host on prod
LABEL="set-str on a flag key";       refused $SC set-str mail_enabled true prod
LABEL="set-flag bad word";           refused $SC set-flag mail_enabled maybe prod
LABEL="smtp_pass as an argument";    refused $SC set-str smtp_pass hunter2-secret prod
LABEL="smtp_port not a number";      refused $SC set-str smtp_port abc prod
LABEL="smtp_port out of range";      refused $SC set-str smtp_port 70000 prod
LABEL="empty value";                 refused $SC set-str smtp_host "" prod
LABEL="newline in a value";          refused $SC set-str mail_from_name "$(printf 'a\nb')" prod
LABEL="mail_from not an address";    refused $SC set-str mail_from nope prod
LABEL="smtp_host not a host";        refused $SC set-str smtp_host "a b" prod
LABEL="meetreq_user not a name";     refused $SC set-str meetreq_user "not a name!" prod
LABEL="timezone not a zone";         refused $SC set-str timezone Mars/Base prod
LABEL="no instance";                 refused $SC set-str php_bin /usr/local/bin/php
LABEL="bad instance";                refused $SC set-str php_bin /usr/local/bin/php staging
LABEL="unknown command";             refused $SC frob prod
LABEL="missing deploy.conf";         refused env CALMIND_DEPLOY_CONF="$R/none.conf" $SC set-flag mail_enabled off prod
LABEL="a SSH_DEST starting with -";  printf 'SSH_DEST="-oProxyCommand=x"\n' > "$R/bad.conf"; refused env CALMIND_DEPLOY_CONF="$R/bad.conf" $SC set-flag mail_enabled off prod

echo "secret by stdin"
reset_live
OUT=$(printf 'SECRETPASS-xyz\n' | $SC set-str smtp_pass - prod 2>&1); RC=$?; printf '%s\n' "$OUT" >> "$R/all.out"
[ "$RC" = 0 ] && [ "$(val smtp_pass)" = '"SECRETPASS-xyz"' ] && ok "smtp_pass set from stdin" || bad "stdin secret: $RC $OUT"

echo "a config that computes a path on this Mac"
reset_live
printf "<?php\nreturn ['data_dir' => __DIR__ . '/data', 'mail_enabled' => false];\n" > "$PROD"
LABEL="__DIR__ in the live file"; refused $SC set-flag mail_enabled on prod
case "$OUT" in *"path on this machine"*) ok "says why" ;; *) bad "no reason: $OUT" ;; esac

echo "stale and raced copies"
reset_live
LABEL="push with no pull"; refused $SC push prod
run $SC pull prod
[ "$RC" = 0 ] && [ -f "$R/state"/prod.php ] && ok "pull writes the local copy" || bad "pull: $RC $OUT"
[ "$(stat -f %Lp "$R/state"/prod.php 2>/dev/null || stat -c %a "$R/state"/prod.php)" = 600 ] && ok "copy is 0600" || bad "copy mode"
printf '// changed by someone else\n' >> "$PROD"
LABEL="live file changed since the pull"; refused $SC push prod
case "$OUT" in *"changed since the pull"*) ok "says so" ;; *) bad "no reason: $OUT" ;; esac
reset_live; rm -rf "$R/state"
run $SC pull prod
sed -i.bak "s/'owner1'/'owner2'/" "$R/state"/prod.php; rm -f "$R/state"/prod.php.bak
run $SC push prod
[ "$RC" = 0 ] && [ "$(val meetreq_user)" = '"owner2"' ] && [ ! -e "$R/state"/prod.php ] && ok "a fresh hand-edited copy pushes, then is deleted" || bad "push: $RC $OUT"
reset_live; : > "$R/race"
run $SC set-flag mail_enabled off prod
if [ "$RC" -ne 0 ] && [ "$(val mail_enabled)" = true ] && grep -q raced "$PROD"; then ok "refused: the file changed between the pull and the upload, and our edit was not written"; else bad "race not caught ($RC): $OUT"; fi
rm -f "$R/race"

echo "a hand-edited copy goes through the same rules as set-*"
pulled_edit() {   # php code run on the pulled copy's array; then push
    reset_live; rm -rf "$R/state"; run $SC pull prod
    php -r '$f = $argv[1]; $c = require $f; '"$1"' file_put_contents($f, "<?php\nreturn " . var_export($c, true) . ";\n");' "$R/state/prod.php"
}
pulled_edit '$c["data_key"] = "K2";';                       LABEL="push changes data_key"; before=$(live_sum); run $SC push prod
[ "$RC" -ne 0 ] && [ "$before" = "$(live_sum)" ] && ok "refused, nothing changed: $LABEL" || bad "NOT refused: $LABEL ($RC) $OUT"
pulled_edit 'unset($c["data_key"]);';                       LABEL="push removes data_key"; before=$(live_sum); run $SC push prod
[ "$RC" -ne 0 ] && [ "$before" = "$(live_sum)" ] && ok "refused, nothing changed: $LABEL" || bad "NOT refused: $LABEL ($RC) $OUT"
pulled_edit '$c["debug_log_codes"] = true;';                LABEL="push adds debug_log_codes"; before=$(live_sum); run $SC push prod
[ "$RC" -ne 0 ] && [ "$before" = "$(live_sum)" ] && ok "refused, nothing changed: $LABEL" || bad "NOT refused: $LABEL ($RC) $OUT"
pulled_edit '$c["surprise_key"] = "x";';                    LABEL="push adds an undocumented key"; before=$(live_sum); run $SC push prod
[ "$RC" -ne 0 ] && [ "$before" = "$(live_sum)" ] && ok "refused, nothing changed: $LABEL" || bad "NOT refused: $LABEL ($RC) $OUT"
pulled_edit '$c["php_bin"] = "php";';                       LABEL="push a relative php_bin"; before=$(live_sum); run $SC push prod
[ "$RC" -ne 0 ] && [ "$before" = "$(live_sum)" ] && ok "refused, nothing changed: $LABEL" || bad "NOT refused: $LABEL ($RC) $OUT"
pulled_edit '$c["php_bin"] = "/usr/local/bin/nope";';       LABEL="push a php_bin not on the server"; before=$(live_sum); run $SC push prod
[ "$RC" -ne 0 ] && [ "$before" = "$(live_sum)" ] && ok "refused, nothing changed: $LABEL" || bad "NOT refused: $LABEL ($RC) $OUT"
pulled_edit '$c["mail_enabled"] = "yes";';                  LABEL="push a non-boolean mail_enabled"; before=$(live_sum); run $SC push prod
[ "$RC" -ne 0 ] && [ "$before" = "$(live_sum)" ] && ok "refused, nothing changed: $LABEL" || bad "NOT refused: $LABEL ($RC) $OUT"
pulled_edit '$c["smtp_port"] = "465";';                     LABEL="push smtp_port as a string"; before=$(live_sum); run $SC push prod
[ "$RC" -ne 0 ] && [ "$before" = "$(live_sum)" ] && ok "refused, nothing changed: $LABEL" || bad "NOT refused: $LABEL ($RC) $OUT"
pulled_edit '$c["timezone"] = "Mars/Base";';                LABEL="push a bad timezone"; before=$(live_sum); run $SC push prod
[ "$RC" -ne 0 ] && [ "$before" = "$(live_sum)" ] && ok "refused, nothing changed: $LABEL" || bad "NOT refused: $LABEL ($RC) $OUT"
pulled_edit '$c["php_bin"] = "/usr/local/bin/php"; $c["smtp_port"] = 587;'; run $SC push prod
[ "$RC" = 0 ] && [ "$(val php_bin)" = '"/usr/local/bin/php"' ] && [ "$(val smtp_port)" = 587 ] && [ "$(val data_key)" = '"LIVE-KEY-1"' ] && ok "valid hand edits (php_bin, smtp_port) push" || bad "valid push: $RC $OUT"
reset_live; rm -rf "$R/state"; run $SC pull prod; rm -f "$R/state/prod.orig"
LABEL="push with the as-pulled record missing"; before=$(live_sum); run $SC push prod
[ "$RC" -ne 0 ] && [ "$before" = "$(live_sum)" ] && ok "refused, nothing changed: $LABEL" || bad "NOT refused: $LABEL"
rm -rf "$R/state"

echo "server refuses / served result broken"
reset_live; : > "$R/fail-lint"
LABEL="server lint fails"; refused $SC set-str smtp_host h.example.test prod
ls "$(dirname "$PROD")" | grep -q '\.new$\|\.prev$' && bad "left a .new/.prev" || ok "nothing left beside the target"
reset_live; rm -f "$R/health.json"
LABEL="the instance does not answer health"; refused $SC set-str smtp_host h.example.test prod
case "$OUT" in *"SERVED RESULT BROKEN"*"put back"*) ok "says it restored" ;; *) bad "no message: $OUT" ;; esac
ls "$(dirname "$PROD")" | grep -q '\.new$\|\.prev$' && bad "left a .new/.prev" || ok "nothing left beside the target"
reset_live; printf '<html>not json</html>' > "$R/health.json"
LABEL="the instance answers garbage"; refused $SC set-str smtp_host h.example.test prod

echo "no secret reached any output or argument list"
if grep -q 'LIVE-SECRET-1\|LIVE-KEY-1\|SECRETPASS-xyz\|hunter2-secret' "$R/all.out"; then bad "a secret appeared in output"; else ok "none in stdout/stderr of any command"; fi
if grep -q 'LIVE-SECRET-1\|LIVE-KEY-1\|SECRETPASS-xyz' "$R/calls.log"; then bad "a secret appeared in an ssh/scp/curl argument"; else ok "none in any ssh/scp/curl argument"; fi

echo
echo "────────────────────────────────"
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
