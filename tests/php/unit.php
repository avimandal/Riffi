<?php
// Unit tests for api/omr.php helpers. Run: php tests/php/unit.php
declare(strict_types=1);

ob_start(); // keep header() calls quiet under the CLI
require __DIR__ . '/../../api/omr.php';

$failures = 0;
function check(string $name, bool $ok): void
{
    global $failures;
    fwrite(STDOUT, ($ok ? "  ok   " : "  FAIL ") . $name . "\n");
    if (!$ok) {
        $failures++;
    }
}

$fixture = (string) file_get_contents(__DIR__ . '/../fixtures/sheets/hermans-hornpipe.rn.json');

// Riffi Notation validation
[$score, $problem] = riffi_validate_score("Here you go:\n```json\n$fixture\n```");
check('accepts the dense fixture page (in a code fence)', $problem === null && count($score['measures']) === 22);
check('keeps the reader\'s warnings', count($score['warnings']) === 2);
check('rejects an empty reply', riffi_validate_score('')[1] !== null);
check('rejects non-JSON', riffi_validate_score('<score-partwise/>')[1] !== null);
check('rejects a score with no measures', str_contains((string) riffi_validate_score('{"measures": []}')[1], 'measures'));
check('names the bad token and bar', str_contains((string) riffi_validate_score('{"measures":[{"n":7,"s1":"C#5q H4q"}]}')[1], 'Measure 7'));
check('a note needs a length', riffi_check_staff('C#5') !== null);
check('accepts chords, ties, dots, tuplets and rests', riffi_check_staff('D4+A4h. C5q~ C5e 3(D5s E5s D5s) 3( A4e B4e C#5e ) rq R') === null);
check('rejects a score with only rests', riffi_validate_score('{"measures":[{"n":1,"s1":"R"}]}')[1] === 'There are no notes.');

// Log scrubbing
RiffiLog::init(['GEMINI_API_KEY' => 'AIzaSECRET-abcdefghijklmnop123', 'ANTHROPIC_API_KEY' => '', 'LOG_FILE' => false]);
check('scrubs keys from log text', !str_contains(RiffiLog::scrub('x-goog-api-key: AIzaSECRET-abcdefghijklmnop123 ?key=abc'), 'SECRET') && !str_contains(RiffiLog::scrub('?key=abc&x=1'), 'abc'));
check('scrubs key-shaped strings too', RiffiLog::scrub('AIzaZZZZZZZZZZZZZZZZZZZZZZZZZZZ') === '[key]');

// Error classification
check('429 is busy', riffi_provider_error('gemini', 429, '{"error":{"message":"quota","status":"RESOURCE_EXHAUSTED"}}')->errorCode === 'busy');
check('404 is a wrong model name', riffi_provider_error('gemini', 404, '{"error":{"message":"models/x is not found"}}')->errorCode === 'model_not_found');
check('bad key', riffi_provider_error('gemini', 400, '{"error":{"message":"API key not valid. Please pass a valid API key."}}')->errorCode === 'bad_key');
check('unsupported location', riffi_provider_error('gemini', 400, '{"error":{"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}')->errorCode === 'region');
check('Cloudflare-style HTML 502 is a provider error', riffi_provider_error('gemini', 502, '<html>Bad gateway</html>')->errorCode === 'provider_error');
$call = new RiffiCall(microtime(true) + 30, null);
check('could not resolve host is "blocked"', riffi_curl_error('gemini', 6, 'Could not resolve host', $call)->errorCode === 'blocked');
check('TLS failure is "blocked"', riffi_curl_error('gemini', 60, 'SSL certificate problem', $call)->errorCode === 'blocked');
check('curl timeout is "timeout"', riffi_curl_error('gemini', 28, 'Operation timed out', $call)->errorCode === 'timeout');

// CORS
$cfg = riffi_default_config();
$cfg['ALLOWED_ORIGIN'] = 'https://riffi.example.com';
$_SERVER['HTTP_ORIGIN'] = 'https://evil.example.com';
try {
    riffi_cors($cfg);
    check('blocks other origins', false);
} catch (RiffiHttpError $e) {
    check('blocks other origins', $e->status === 403);
}
$_SERVER['HTTP_ORIGIN'] = 'https://riffi.example.com';
try {
    riffi_cors($cfg);
    check('allows the app origin', true);
} catch (RiffiHttpError $e) {
    check('allows the app origin', false);
}
unset($_SERVER['HTTP_ORIGIN']);

// Rate limit
$dir = sys_get_temp_dir() . '/riffi-test-' . bin2hex(random_bytes(4));
$cfg['RATE_LIMIT_DIR'] = $dir;
$cfg['RATE_LIMIT_PER_HOUR'] = 3;
$_SERVER['REMOTE_ADDR'] = '203.0.113.9';
$blocked = false;
for ($i = 0; $i < 4; $i++) {
    try {
        riffi_rate_limit($cfg);
    } catch (RiffiHttpError $e) {
        $blocked = $i === 3 && $e->status === 429;
    }
}
check('rate limits after the hourly allowance', $blocked);
$files = glob($dir . '/*.json');
check('stores only hashed IPs', count($files) === 1 && !str_contains((string) file_get_contents($files[0]), '203.0.113.9') && !str_contains($files[0], '203.0.113.9'));
array_map('unlink', $files);
rmdir($dir);

// Prompt content (provider-neutral)
$parts = riffi_user_parts([['image/jpeg', 'AAA'], ['image/png', 'BBB']], 'piano', 2, 3);
check('sends pages in order', $parts[1]['image'][1] === 'AAA' && $parts[3]['image'][1] === 'BBB');
check('asks for both piano staves', str_contains(end($parts)['text'], 'staves": 2'));
check('says which page this is', str_contains(end($parts)['text'], 'page 2 of 3'));
check('prompt asks to ignore pencil and highlighter', str_contains(riffi_system_prompt(), 'highlighter'));
$turns = [
    ['role' => 'user', 'parts' => $parts],
    ['role' => 'assistant', 'parts' => [['text' => 'broken']]],
    ['role' => 'user', 'parts' => [['text' => 'fix it']]],
];

// Gemini adapter
$g = RiffiGemini::body('SYSTEM', $turns, 1000, RiffiGemini::thinkingConfig('gemini-flash-latest', 'low'));
check('gemini: system instruction', $g['system_instruction']['parts'][0]['text'] === 'SYSTEM');
check('gemini: images as inline_data', $g['contents'][0]['parts'][1]['inline_data'] === ['mime_type' => 'image/jpeg', 'data' => 'AAA']);
check('gemini: assistant turns become "model"', array_column($g['contents'], 'role') === ['user', 'model', 'user']);
check('gemini: JSON output, limit, low thinking', $g['generationConfig']['maxOutputTokens'] === 1000 && $g['generationConfig']['responseMimeType'] === 'application/json' && $g['generationConfig']['thinkingConfig'] === ['thinkingLevel' => 'low']);
check('gemini 2.5 thinks by budget', RiffiGemini::thinkingConfig('gemini-2.5-flash', 'low') === ['thinkingBudget' => 512]);
check('gemini: no thinking setting when off', RiffiGemini::thinkingConfig('gemini-flash-latest', '') === null);
[$txt, $fin, $blk] = RiffiGemini::absorb(['candidates' => [['content' => ['parts' => [['text' => 'hmm', 'thought' => true], ['text' => '{"a"']]]]]], '', '', false);
[$txt, $fin, $blk] = RiffiGemini::absorb(['candidates' => [['content' => ['parts' => [['text' => ':1}']]], 'finishReason' => 'STOP']]], $txt, $fin, $blk);
check('gemini: joins streamed chunks and skips thoughts', $txt === '{"a":1}' && RiffiGemini::stopFor($fin, $blk) === 'end');
check('gemini: MAX_TOKENS', RiffiGemini::stopFor('MAX_TOKENS', false) === 'max_tokens');
check('gemini: safety stop is a refusal', RiffiGemini::stopFor('SAFETY', false) === 'refusal');
check('gemini: blocked prompt is a refusal', RiffiGemini::absorb(['promptFeedback' => ['blockReason' => 'OTHER']], '', '', false)[2] === true);

// Claude adapter
$c = RiffiClaude::body('SYSTEM', $turns, 'claude-sonnet-5-5', 2000, 'medium');
check('claude: images as base64 sources', $c['messages'][0]['content'][1]['source'] === ['type' => 'base64', 'media_type' => 'image/jpeg', 'data' => 'AAA']);
check('claude: roles', array_column($c['messages'], 'role') === ['user', 'assistant', 'user']);
check('claude: system, model, effort', $c['system'] === 'SYSTEM' && $c['model'] === 'claude-sonnet-5-5' && $c['output_config']['effort'] === 'medium');

// Provider choice
$pc = riffi_default_config();
try {
    riffi_provider($pc);
    check('needs a key for the chosen provider', false);
} catch (RiffiHttpError $e) {
    check('needs a key for the chosen provider', $e->errorCode === 'not_configured');
}
$pc['GEMINI_API_KEY'] = 'g';
check('gemini is the default provider', riffi_provider($pc) instanceof RiffiGemini);
$pc['PROVIDER'] = 'claude';
$pc['ANTHROPIC_API_KEY'] = 'a';
check('claude when chosen', riffi_provider($pc) instanceof RiffiClaude);

fwrite(STDOUT, $failures === 0 ? "All PHP unit tests passed\n" : "$failures PHP test(s) failed\n");
exit($failures === 0 ? 0 : 1);
