#!/usr/bin/env bash
# End-to-end tests of api/omr.php against fake Gemini and Claude APIs that
# stream like the real ones. The fake Gemini's behaviour is chosen by model name.
set -euo pipefail
cd "$(dirname "$0")/../.."
TMP=$(mktemp -d)
T="${TMPDIR:-/tmp}"
cleanup() { kill $(jobs -p) 2>/dev/null || true; rm -rf "$TMP" "$T"/riffi-gemini-* "$T/riffi-mock-count"; }
trap cleanup EXIT
rm -f "$T"/riffi-gemini-* "$T/riffi-mock-count"

PORT=8800
start_app() { # name provider model [extra php]
  local name=$1 provider=$2 model=$3 extra=${4:-}
  cat > "$TMP/$name.php" <<PHP
<?php
return [
  'PROVIDER' => '$provider',
  'GEMINI_API_KEY' => 'AIzaTESTKEY-0123456789abcdefghijkl',
  'GEMINI_MODEL' => '$model',
  'ANTHROPIC_API_KEY' => 'sk-ant-test-0123456789',
  'ALLOWED_ORIGIN' => 'https://riffi.example.com',
  'GEMINI_API_URL' => 'http://127.0.0.1:8791/mock-gemini.php',
  'CLAUDE_API_URL' => 'http://127.0.0.1:8791/mock-anthropic.php',
  'RATE_LIMIT_DIR' => '$TMP/rl-$name',
  'LOG_FILE' => '$TMP/logs/$name.log',
  $extra
];
PHP
  PORT=$((PORT + 1))
  RIFFI_CONFIG="$TMP/$name.php" php -S 127.0.0.1:$PORT -t api >/dev/null 2>&1 &
  eval "PORT_$name=$PORT"
}

start_app ok gemini ok
start_app fast gemini fast
start_app slow gemini slow "'REQUEST_SECONDS' => 6,"
start_app busy gemini busy
start_app missing gemini missing
start_app badkey gemini badkey
start_app oldthink gemini oldthink
start_app claude claude claude-sonnet-5-5
php -S 127.0.0.1:8791 -t tests/php >/dev/null 2>&1 &
sleep 1


fail() { echo "FAIL: $1"; exit 1; }
scan() { # port → body, then status on the last line
  curl -s -N -w '\n%{http_code}' -H 'Origin: https://riffi.example.com' -F 'instrument=violin' -F 'page=1' -F 'pages=2' -F "pages[]=@tests/fixtures/sheets/hermans-hornpipe.webp;type=image/webp" "http://127.0.0.1:$1/omr.php"
}
last_line() { echo "$1" | grep -v '^[0-9]*$' | grep -v '"type":"ping"' | tail -1; }
field() { php -r '$j=json_decode(stream_get_contents(STDIN),true); $k=explode(".",$argv[1]); foreach($k as $x){$j=$j[$x]??null;} echo is_scalar($j)?$j:json_encode($j);' "$1"; }

# --- Gemini: a real dense page (the Herman's hornpipe photo), with one retry ---
OUT=$(scan $PORT_ok)
[ "$(echo "$OUT" | tail -1)" = "200" ] || fail "expected a 200 stream: $OUT"
echo "$OUT" | grep -q '"type":"start"' || fail "no start line"
echo "$OUT" | grep -q '"type":"progress","bars":2[0-9]' || fail "no progress lines: $OUT"
RESULT=$(last_line "$OUT")
[ "$(echo "$RESULT" | field type)" = "result" ] || fail "expected a result: $RESULT"
[ "$(echo "$RESULT" | field score.title)" = "Herman's hornpipe" ] || fail "wrong title"
[ "$(echo "$RESULT" | php -r '$j=json_decode(stream_get_contents(STDIN),true); echo count($j["score"]["measures"]);')" = "22" ] || fail "expected 22 measures"
[ "$(echo "$RESULT" | field warnings | grep -c 'highlighter')" = "1" ] || fail "missing warnings"
php -r '$l=json_decode(file_get_contents(sys_get_temp_dir()."/riffi-gemini-last-ok.json"),true); exit($l["method"]==="streamGenerateContent" && $l["key"]==="AIzaTESTKEY-0123456789abcdefghijkl" && $l["roles"]===["user","model","user"] && $l["images"]===1 && $l["system"] && $l["mime"]==="application/json" && $l["thinking"]===["thinkingLevel"=>"low"] ? 0 : 1);' || fail "Gemini request was not shaped as expected"
echo "  ok   gemini: dense page streams progress, retries once on invalid notation, returns 22 bars + warnings"

OUT=$(scan $PORT_fast)
[ "$(last_line "$OUT" | field type)" = "result" ] || fail "fast: no result"
echo "  ok   gemini: page 1 of 2 read in one go"

# --- Deadline: a provider that hangs never outlives REQUEST_SECONDS ---
START=$(date +%s)
OUT=$(scan $PORT_slow)
ELAPSED=$(( $(date +%s) - START ))
[ "$ELAPSED" -le 10 ] || fail "deadline not enforced (took ${ELAPSED}s)"
[ "$(last_line "$OUT" | field code)" = "timeout" ] || fail "expected timeout: $OUT"
[ "$(echo "$OUT" | grep -c '"type":"ping"')" -ge 1 ] || fail "no keep-alive pings while waiting"
echo "  ok   deadline: a hung provider becomes 'timeout' after ${ELAPSED}s, with keep-alive pings meanwhile"

# --- Clear error codes ---
for case in "busy:busy" "missing:model_not_found" "badkey:bad_key"; do
  name=${case%%:*}; code=${case##*:}; port_var="PORT_$name"
  OUT=$(scan ${!port_var})
  [ "$(last_line "$OUT" | field code)" = "$code" ] || fail "$name: expected $code, got $(last_line "$OUT")"
  [ -n "$(last_line "$OUT" | field ref)" ] || fail "$name: no reference code"
done
echo "  ok   errors: free-tier 429 → busy, 404 → model_not_found, bad key → bad_key (each with a ref)"

OUT=$(scan $PORT_oldthink)
[ "$(last_line "$OUT" | field type)" = "result" ] || fail "oldthink: expected a result after dropping thinkingLevel: $OUT"
echo "  ok   gemini: a model that rejects thinkingLevel is retried without it"

# --- Claude (alternative provider) ---
OUT=$(scan $PORT_claude)
RESULT=$(last_line "$OUT")
[ "$(echo "$RESULT" | field score.title)" = "Tiny tune" ] || fail "claude: expected a result: $OUT"
php -r '$l=json_decode(file_get_contents(sys_get_temp_dir()."/riffi-mock-last.json"),true); exit($l["messages"]===3 && $l["stream"]===true && $l["model"]==="claude-sonnet-5-5" && $l["fallbacks"]==="default" && $l["headers"]["x-api-key"]==="sk-ant-test-0123456789" && $l["images"]===1 ? 0 : 1);' || fail "Claude request was not shaped as expected"
echo "  ok   claude: streams, retries once, returns the score"

# --- Private log: useful, and never contains the key ---
grep -q '"event":"scan_ok"' "$TMP/logs/ok.log" || fail "no scan_ok in the log"
grep -q '"code":"busy"' "$TMP/logs/busy.log" || fail "busy not logged"
grep -q 'quota' "$TMP/logs/busy.log" || fail "provider message not logged"
grep -q '"code":"timeout"' "$TMP/logs/slow.log" || fail "timeout not logged"
grep -q 'max_execution_time' "$TMP/logs/ok.log" || fail "PHP limits not logged"
! grep -rq 'AIzaTESTKEY\|sk-ant-test' "$TMP/logs" || fail "a key leaked into the log"
echo "  ok   log: records each failure with its reason and the PHP limits, never the key"

# --- Self-check ---
OUT=$(curl -s -N -H 'Origin: https://riffi.example.com' "http://127.0.0.1:$PORT_fast/omr.php?check=1")
REPORT=$(last_line "$OUT")
[ "$(echo "$REPORT" | field report.model_check.ok)" = "1" ] || fail "self-check: model check: $REPORT"
[ "$(echo "$REPORT" | field report.test_request.ok)" = "1" ] || fail "self-check: test request: $REPORT"
[ "$(echo "$OUT" | grep -c '"type":"ping"')" = "2" ] || fail "self-check: expected two timed pings"
OUT=$(curl -s -N "http://127.0.0.1:$PORT_missing/omr.php?check=1")
[ "$(last_line "$OUT" | field report.model_check.status)" = "404" ] || fail "self-check: missing model not reported"
echo "  ok   self-check: reports model, a test request and streaming pings; spots a missing model"

# --- Request guards ---
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example.com' -F 'instrument=violin' -F "pages[]=@tests/fixtures/sheets/hermans-hornpipe.webp" http://127.0.0.1:$PORT_fast/omr.php)
[ "$CODE" = "403" ] || fail "expected 403 for a foreign origin, got $CODE"
echo "hello" > "$TMP/note.txt"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -F 'instrument=violin' -F "pages[]=@$TMP/note.txt" http://127.0.0.1:$PORT_fast/omr.php)
[ "$CODE" = "400" ] || fail "expected 400 for a non-image, got $CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT http://127.0.0.1:$PORT_fast/omr.php)
[ "$CODE" = "405" ] || fail "expected 405, got $CODE"
echo "  ok   guards: foreign origin 403, non-image 400, wrong method 405"
echo "All PHP integration tests passed"
