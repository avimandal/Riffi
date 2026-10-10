#!/usr/bin/env bash
# End-to-end tests of api/omr.php against fake Gemini and Claude APIs.
set -euo pipefail
cd "$(dirname "$0")/../.."
TMP=$(mktemp -d)
T="${TMPDIR:-/tmp}"
cleanup() { kill $(jobs -p) 2>/dev/null || true; rm -rf "$TMP" "$T/riffi-mock-count" "$T/riffi-gemini-count"; }
trap cleanup EXIT
rm -f "$T/riffi-mock-count" "$T/riffi-gemini-count"

config() { # provider port
  cat > "$TMP/$1.php" <<PHP
<?php
return [
  'PROVIDER' => '$1',
  'GEMINI_API_KEY' => 'g-test',
  'ANTHROPIC_API_KEY' => 'sk-test',
  'ALLOWED_ORIGIN' => 'https://riffi.example.com',
  'GEMINI_API_URL' => 'http://127.0.0.1:8791/mock-gemini.php',
  'CLAUDE_API_URL' => 'http://127.0.0.1:8791/mock-anthropic.php',
  'RATE_LIMIT_DIR' => '$TMP/rl-$1',
  'RATE_LIMIT_PER_HOUR' => 20,
];
PHP
}
config gemini
config claude

# A real (tiny) JPEG so the MIME check passes.
printf '\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9' > "$TMP/page.jpg"

php -S 127.0.0.1:8791 -t tests/php >/dev/null 2>&1 &
RIFFI_CONFIG="$TMP/gemini.php" php -S 127.0.0.1:8790 -t api >/dev/null 2>&1 &
RIFFI_CONFIG="$TMP/claude.php" php -S 127.0.0.1:8792 -t api >/dev/null 2>&1 &
sleep 1

fail() { echo "FAIL: $1"; exit 1; }
scan() { # port → prints body then status on the last line
  curl -s -w '\n%{http_code}' -H 'Origin: https://riffi.example.com' -F 'instrument=violin' -F "pages[]=@$TMP/page.jpg;type=image/jpeg" "http://127.0.0.1:$1/omr.php"
}
expect_ok() { # output, warning text
  local code body
  code=$(echo "$1" | tail -1)
  body=$(echo "$1" | head -n -1)
  [ "$code" = "200" ] || fail "expected 200, got $code: $body"
  W="$2" php -r '$j=json_decode(stream_get_contents(STDIN),true); exit(str_contains($j["musicxml"],"<score-partwise") && !str_contains($j["musicxml"],"riffi-warning") && !str_contains($j["musicxml"],"```") && $j["warnings"]===[getenv("W")] ? 0 : 1);' <<<"$body" || fail "unexpected body: $body"
}

# --- Gemini (default provider) ---
expect_ok "$(scan 8790)" "Bar 1: the clef was faint."
php -r '$l=json_decode(file_get_contents(sys_get_temp_dir()."/riffi-gemini-last.json"),true); exit($l["path"]==="/models/gemini-flash-latest:generateContent" && $l["key"]==="g-test" && $l["roles"]===["user","model","user"] && $l["images"]===1 && $l["system"] ? 0 : 1);' || fail "Gemini request was not shaped as expected"
echo "  ok   gemini: reads music, retries once on invalid XML, skips thoughts, returns warnings"

OUT=$(scan 8790)
CODE=$(echo "$OUT" | tail -1)
[ "$CODE" = "503" ] || fail "expected 503 for a Gemini 429, got $CODE"
echo "$OUT" | head -n -1 | grep -q "music reader is busy, try again in a minute" || fail "missing friendly busy message: $OUT"
echo "  ok   gemini: free-tier 429 becomes a friendly 'busy, try again in a minute'"

# --- Claude (alternative) ---
expect_ok "$(scan 8792)" "Bar 2: a note was hard to read."
php -r '$l=json_decode(file_get_contents(sys_get_temp_dir()."/riffi-mock-last.json"),true); exit($l["messages"]===3 && $l["stream"]===true && $l["model"]==="claude-sonnet-5-5" && $l["fallbacks"]==="default" && $l["headers"]["x-api-key"]==="sk-test" && $l["images"]===1 ? 0 : 1);' || fail "Claude request was not shaped as expected"
echo "  ok   claude: reads music (streamed), retries once on invalid XML, returns warnings"

# --- Shared request handling ---
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example.com' -F 'instrument=violin' -F "pages[]=@$TMP/page.jpg" http://127.0.0.1:8790/omr.php)
[ "$CODE" = "403" ] || fail "expected 403 for a foreign origin, got $CODE"
echo "  ok   refuses other origins"

echo "hello" > "$TMP/note.txt"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -F 'instrument=violin' -F "pages[]=@$TMP/note.txt" http://127.0.0.1:8790/omr.php)
[ "$CODE" = "400" ] || fail "expected 400 for a non-image, got $CODE"
echo "  ok   refuses non-images"

CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/omr.php)
[ "$CODE" = "405" ] || fail "expected 405 for GET, got $CODE"
echo "  ok   only POST"

LEFT=$(find "$TMP"/rl-* -type f | wc -l)
[ "$LEFT" = "2" ] || fail "expected one rate-limit file per server, found $LEFT"
echo "  ok   stores nothing but a hashed rate-limit counter"
echo "All PHP integration tests passed"
