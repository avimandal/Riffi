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
start_app lines gemini lines
start_app pace gemini fast "'GEMINI_RPM' => 2,"
start_app daily gemini daily
start_app perminute gemini perminute
start_app admin gemini fast "'ADMIN_PASSWORD' => 'open sesame', 'SETTINGS_FILE' => '$TMP/admin-settings.json',"
php -S 127.0.0.1:8791 -t tests/php >/dev/null 2>&1 &
sleep 1


fail() { # show the private logs so CI failures explain themselves
  echo "FAIL: $1"
  for f in "$TMP"/logs/*.log; do [ -f "$f" ] && { echo "--- $f"; tail -n 20 "$f"; }; done
  exit 1
}
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

# --- Line by line: overview, one line, double-check ---
step() { # port mode [extra curl args…] → body, then status
  local port=$1 mode=$2; shift 2
  curl -s -N -w '\n%{http_code}' -H 'Origin: https://riffi.example.com' -F "mode=$mode" -F 'instrument=violin' "$@" "http://127.0.0.1:$port/omr.php"
}
IMG="pages[]=@tests/fixtures/sheets/hermans-hornpipe.webp;type=image/webp"
OUT=$(step $PORT_lines overview -F "$IMG" -F page=1 -F pages=1)
R=$(last_line "$OUT")
[ "$(echo "$R" | field overview.key)" = "2" ] && [ "$(echo "$R" | field overview.time)" = "4/4" ] && [ "$(echo "$R" | field overview.pickup)" = "1" ] && [ "$(echo "$R" | field overview.pickup_notes)" = "A5e" ] || fail "overview: $R"
[ "$(echo "$R" | field provider)" = "gemini" ] || fail "overview: provider not named"
php -r '$l=json_decode(file_get_contents(sys_get_temp_dir()."/riffi-gemini-last-lines.json"),true); exit($l["thinking"]===["thinkingLevel"=>"low"] && $l["images"]===1 ? 0 : 1);' || fail "overview should think 'low'"
echo "  ok   overview: key, time signature and pickup from the whole page (quick, low thinking)"



OUT=$(step $PORT_lines line -F "$IMG" -F "$IMG" -F "$IMG" -F line=1 -F lines=7 -F key=2 -F time=4/4 -F first_bar=1 -F pickup=yes -F 'hints=["F5 D5 A4 F5","",""]')
R=$(last_line "$OUT")
[ "$(echo "$R" | php -r '$j=json_decode(stream_get_contents(STDIN),true); echo implode(",", array_map(fn($l) => $l["line"].":".count($l["measures"]), $j["line"]["lines"]));')" = "1:3,2:3,3:3" ] || fail "line: expected lines 1-3 with 3 bars each: $R"
echo "$OUT" | grep -q '"type":"progress","bars":' || fail "line: no bar progress"
php -r '$l=json_decode(file_get_contents(sys_get_temp_dir()."/riffi-gemini-last-lines.json"),true); exit($l["thinking"]===["thinkingLevel"=>"low"] && $l["images"]===3 ? 0 : 1);' || fail "line: three pictures, low thinking"
echo "  ok   line: three lines in one request (each its own picture), with the carried key, time and measured note heads"

ENGRAVING="$TMP/engraving.png"
php -r 'echo base64_decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");' > "$ENGRAVING"
L1='{"measures":[{"n":1,"key":2,"time":"4/4","s1":"F#5s D5s A4s F#5s E5s C#5s A4s D5s B4s G4s D4s B4s A4s F#4s D4s F#4s"}]}'
L2=$(php -r '$r=json_decode(file_get_contents("tests/fixtures/sheets/hermans-hornpipe.reference.json"),true); echo json_encode(["measures"=>array_values(array_filter($r["measures"], fn($m)=>$m["n"]>=4&&$m["n"]<=6))]);')
OUT=$(step $PORT_lines check -F "$IMG" -F "pages[]=@$ENGRAVING;type=image/png" -F "$IMG" -F "pages[]=@$ENGRAVING;type=image/png" -F line=1 -F lines=7 -F key=2 -F time=4/4 -F "transcriptions=[$L1,$L2]" -F 'line_numbers=[1,2]' -F 'problems=[["Bar 1: example problem"],[]]' -F round=1)
R=$(last_line "$OUT")
[ "$(echo "$R" | field check.lines.0.mismatches.0.what)" = "pickup" ] || fail "check: expected a pickup mismatch on line 1: $R"
[ "$(echo "$R" | field check.lines.0.measures.0.pickup)" = "1" ] || fail "check: expected corrected bars: $R"
[ "$(echo "$R" | field check.lines.1.mismatches)" = "[]" ] && [ "$(echo "$R" | field check.lines.1.measures)" = "null" ] || fail "check: line 2 was right: $R"
php -r '$l=json_decode(file_get_contents(sys_get_temp_dir()."/riffi-gemini-last-lines.json"),true); exit($l["images"]===4 ? 0 : 1);' || fail "check: photo and engraving of both lines should be sent"
OUT=$(step $PORT_lines check -F "$IMG" -F line=1 -F "transcriptions=[$L1]")
[ "$(echo "$OUT" | tail -1)" = "400" ] || fail "check without the engraving should be refused"
OUT=$(step $PORT_lines check -F "$IMG" -F "pages[]=@$ENGRAVING;type=image/png" -F 'transcriptions=["nope"]')
[ "$(last_line "$OUT" | field code)" = "bad_transcription" ] || fail "check with a broken transcription: $OUT"
echo "  ok   check: photos + engravings + transcriptions + code problems, several lines at once → mismatches and corrected bars"

# --- Pace and the provider's own limits ---
for i in 1 2; do OUT=$(step $PORT_pace line -F "$IMG"); [ "$(echo "$OUT" | tail -1)" = "200" ] || fail "pace: request $i should go through"; done
OUT=$(step $PORT_pace line -F "$IMG")
[ "$(echo "$OUT" | tail -1)" = "429" ] || fail "pace: third request in a minute should wait: $OUT"
[ "$(echo "$OUT" | head -1 | field code)" = "busy" ] && [ "$(echo "$OUT" | head -1 | field retry_after)" -gt 0 ] || fail "pace: expected busy with retry_after: $OUT"
OUT=$(step $PORT_perminute line -F "$IMG")
[ "$(last_line "$OUT" | field code)" = "busy" ] && [ "$(last_line "$OUT" | field retry_after)" = "7" ] || fail "per-minute 429 should pass on Gemini's retryDelay: $OUT"
OUT=$(step $PORT_daily line -F "$IMG")
[ "$(last_line "$OUT" | field code)" = "quota" ] || fail "daily 429 should be 'quota': $OUT"
echo "  ok   pace: GEMINI_RPM spaces requests (busy + retry_after); Gemini's retryDelay passed on; daily quota → quota"

# --- The site-wide music reader: only changed with the admin password ---
last_provider() { grep '"event":"scan_start"' "$TMP/logs/$1.log" | tail -1 | field provider; }
OUT=$(curl -s -N -w '\n%{http_code}' -H 'Origin: https://riffi.example.com' -F 'instrument=violin' -F provider=claude -F "$IMG" "http://127.0.0.1:$PORT_admin/omr.php")
[ "$(last_line "$OUT" | field type)" = "result" ] && [ "$(last_provider admin)" = "gemini" ] || fail "the app must not be able to choose the provider: $OUT"
INFO=$(curl -s "http://127.0.0.1:$PORT_admin/omr.php?info=1")
[ "$(echo "$INFO" | field providers)" = '["gemini","claude"]' ] && [ "$(echo "$INFO" | field provider)" = "gemini" ] && [ "$(echo "$INFO" | field can_change)" = "1" ] && [ "$(echo "$INFO" | field rpm.gemini)" = "8" ] && [ "$(echo "$INFO" | field lines_per_request)" = "8" ] && [ "$(echo "$INFO" | field check_rounds)" = "2" ] || fail "info: $INFO"
! echo "$INFO" | grep -q 'AIza\|sk-ant\|sesame' || fail "info leaked a secret"
[ "$(curl -s "http://127.0.0.1:$PORT_fast/omr.php?info=1" | field can_change)" = "" ] || fail "no ADMIN_PASSWORD should mean no Change button"
admin() { curl -s -w '\n%{http_code}' -H 'Origin: https://riffi.example.com' "$@" "http://127.0.0.1:$PORT_admin/omr.php?admin=1"; }
OUT=$(admin -F 'password=open sesame' -F provider=claude)
[ "$(echo "$OUT" | tail -1)" = "200" ] && [ "$(echo "$OUT" | head -1 | field provider)" = "claude" ] || fail "admin: right password should save the choice: $OUT"
[ "$(curl -s "http://127.0.0.1:$PORT_admin/omr.php?info=1" | field provider)" = "claude" ] || fail "info should show the saved reader"
OUT=$(curl -s -N -H 'Origin: https://riffi.example.com' -F 'instrument=violin' -F "$IMG" "http://127.0.0.1:$PORT_admin/omr.php")
[ "$(last_line "$OUT" | field score.title)" = "Tiny tune" ] && [ "$(last_provider admin)" = "claude" ] || fail "scans should use the saved reader: $OUT"
[ "$(stat -c %a "$TMP/admin-settings.json")" = "600" ] || fail "settings file should be private"
OUT=$(admin -F 'password=open sesame' -F provider=openai)
[ "$(echo "$OUT" | tail -1)" = "400" ] || fail "admin: a reader without a key can't be chosen: $OUT"
# Wrong passwords: 5 per IP per 15 minutes, then a lockout (even for the right one).
for i in 1 2 3 4; do
  OUT=$(admin -F 'password=nope' -F provider=gemini)
  [ "$(echo "$OUT" | tail -1)" = "403" ] && [ "$(echo "$OUT" | head -1 | field attempts_left)" = "$((5 - i))" ] || fail "admin: wrong password $i: $OUT"
done
OUT=$(admin -F 'password=nope')
[ "$(echo "$OUT" | tail -1)" = "429" ] && [ "$(echo "$OUT" | head -1 | field code)" = "locked" ] || fail "admin: 5th wrong password should lock: $OUT"
OUT=$(admin -F 'password=open sesame' -F provider=gemini)
[ "$(echo "$OUT" | tail -1)" = "429" ] && [ "$(echo "$OUT" | head -1 | field retry_after)" -gt 60 ] || fail "admin: locked out even with the right password: $OUT"
[ "$(curl -s "http://127.0.0.1:$PORT_admin/omr.php?info=1" | field provider)" = "claude" ] || fail "a locked-out change must not be saved"
! grep -q 'sesame' "$TMP/logs/admin.log" || fail "the admin password reached the log"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -F 'password=' "http://127.0.0.1:$PORT_fast/omr.php?admin=1")
[ "$CODE" = "403" ] || fail "no ADMIN_PASSWORD: admin must be off, got $CODE"
echo "  ok   music reader: the app can't choose; the admin password changes it site-wide (saved privately); 5 wrong tries lock out; no password = off"

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
