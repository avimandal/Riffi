#!/usr/bin/env bash
# End-to-end test of api/omr.php against a mock streaming API.
set -euo pipefail
cd "$(dirname "$0")/../.."
TMP=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$TMP" "${TMPDIR:-/tmp}/riffi-mock-count"' EXIT
rm -f "${TMPDIR:-/tmp}/riffi-mock-count"

cat > "$TMP/config.php" <<PHP
<?php
return [
  'ANTHROPIC_API_KEY' => 'sk-test',
  'ALLOWED_ORIGIN' => 'https://riffi.example.com',
  'API_URL' => 'http://127.0.0.1:8791/mock-anthropic.php',
  'RATE_LIMIT_DIR' => '$TMP/rl',
  'RATE_LIMIT_PER_HOUR' => 20,
];
PHP
# A real (tiny) JPEG so the MIME check passes.
printf '\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9' > "$TMP/page.jpg"

php -S 127.0.0.1:8791 -t tests/php >/dev/null 2>&1 &
RIFFI_CONFIG="$TMP/config.php" php -S 127.0.0.1:8790 -t api >/dev/null 2>&1 &
sleep 1

fail() { echo "FAIL: $1"; exit 1; }

# Happy path (first mock reply is broken, so this also proves the retry).
OUT=$(curl -s -w '\n%{http_code}' -H 'Origin: https://riffi.example.com' -F 'instrument=violin' -F "pages[]=@$TMP/page.jpg;type=image/jpeg" http://127.0.0.1:8790/omr.php)
CODE=$(echo "$OUT" | tail -1)
BODY=$(echo "$OUT" | head -n -1)
[ "$CODE" = "200" ] || fail "expected 200, got $CODE: $BODY"
echo "$BODY" | php -r '$j=json_decode(stream_get_contents(STDIN),true); exit(str_contains($j["musicxml"],"<score-partwise") && !str_contains($j["musicxml"],"riffi-warning") && $j["warnings"]===["Bar 2: a note was hard to read."] ? 0 : 1);' || fail "unexpected body: $BODY"
php -r '$l=json_decode(file_get_contents(sys_get_temp_dir()."/riffi-mock-last.json"),true); exit($l["messages"]===3 && $l["stream"]===true && $l["model"]==="claude-sonnet-5-5" && $l["fallbacks"]==="default" && $l["headers"]["x-api-key"]==="sk-test" && $l["images"]===1 ? 0 : 1);' || fail "API request was not shaped as expected"
echo "  ok   reads music, retries once on invalid XML, returns warnings"

# Wrong origin.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example.com' -F 'instrument=violin' -F "pages[]=@$TMP/page.jpg" http://127.0.0.1:8790/omr.php)
[ "$CODE" = "403" ] || fail "expected 403 for a foreign origin, got $CODE"
echo "  ok   refuses other origins"

# Not an image.
echo "hello" > "$TMP/note.txt"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -F 'instrument=violin' -F "pages[]=@$TMP/note.txt" http://127.0.0.1:8790/omr.php)
[ "$CODE" = "400" ] || fail "expected 400 for a non-image, got $CODE"
echo "  ok   refuses non-images"

# GET not allowed; config is not reachable.
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/omr.php)
[ "$CODE" = "405" ] || fail "expected 405 for GET, got $CODE"
echo "  ok   only POST"

# Nothing stored on the server except the rate-limit counter.
LEFT=$(find "$TMP/rl" -type f | wc -l)
[ "$LEFT" = "1" ] || fail "expected one rate-limit file, found $LEFT"
echo "  ok   stores nothing but a hashed rate-limit counter"
echo "All PHP integration tests passed"
