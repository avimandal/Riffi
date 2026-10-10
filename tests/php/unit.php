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

$good = '<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name/></score-part></part-list>'
    . '<part id="P1"><measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>';

// Extraction
check('extracts XML from fenced output', riffi_extract_xml("Here you go:\n```xml\n$good\n```\nEnjoy!") === $good);
check('extracts XML without a declaration', str_starts_with(riffi_extract_xml('blah <score-partwise version="3.1"></score-partwise> blah'), '<score-partwise'));

// Validation
check('accepts valid MusicXML', riffi_validate_xml($good) === null);
check('rejects empty output', riffi_validate_xml('') !== null);
check('rejects broken XML with a line number', str_contains((string) riffi_validate_xml('<score-partwise><part>'), 'line'));
check('rejects the wrong root', riffi_validate_xml('<score-timewise/>') !== null);
check('rejects a score with no notes', riffi_validate_xml('<score-partwise><part id="P1"><measure><note><rest/></note></measure></part></score-partwise>') !== null);
$xxe = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><score-partwise><part><measure><note><pitch><step>&e;</step></pitch></note></measure></part></score-partwise>';
riffi_validate_xml($xxe);
check('does not expand external entities', true);

// Warnings
$withWarnings = str_replace('<part-list>', '<!-- riffi-warning: Bar 3: <b>smudged</b> sharp. --><part-list>', $good);
$w = riffi_take_warnings($withWarnings);
check('collects warnings', $w === ['Bar 3: smudged sharp.']);
check('removes warning comments from the XML', !str_contains($withWarnings, 'riffi-warning') && riffi_validate_xml($withWarnings) === null);

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
$parts = riffi_user_parts([['image/jpeg', 'AAA'], ['image/png', 'BBB']], 'piano');
check('sends pages in order', $parts[1]['image'][1] === 'AAA' && $parts[3]['image'][1] === 'BBB');
check('asks for both piano staves', str_contains(end($parts)['text'], 'both staves'));
$turns = [
    ['role' => 'user', 'parts' => $parts],
    ['role' => 'assistant', 'parts' => [['text' => 'broken']]],
    ['role' => 'user', 'parts' => [['text' => 'fix it']]],
];

// Gemini adapter
$g = RiffiGemini::body('SYSTEM', $turns, 1000);
check('gemini: system instruction', $g['system_instruction']['parts'][0]['text'] === 'SYSTEM');
check('gemini: images as inline_data', $g['contents'][0]['parts'][1]['inline_data'] === ['mime_type' => 'image/jpeg', 'data' => 'AAA']);
check('gemini: assistant turns become "model"', array_column($g['contents'], 'role') === ['user', 'model', 'user']);
check('gemini: output limit', $g['generationConfig']['maxOutputTokens'] === 1000);
check('gemini: parses text and skips thoughts', RiffiGemini::parse(['candidates' => [['content' => ['parts' => [['text' => 'hmm', 'thought' => true], ['text' => '<a/>']]], 'finishReason' => 'STOP']]]) === ['<a/>', 'end']);
check('gemini: MAX_TOKENS', RiffiGemini::parse(['candidates' => [['content' => ['parts' => [['text' => 'x']]], 'finishReason' => 'MAX_TOKENS']]])[1] === 'max_tokens');
check('gemini: safety stop is a refusal', RiffiGemini::parse(['candidates' => [['finishReason' => 'SAFETY']]])[1] === 'refusal');
check('gemini: blocked prompt is a refusal', RiffiGemini::parse(['promptFeedback' => ['blockReason' => 'OTHER']])[1] === 'refusal');

// Claude adapter
$c = RiffiClaude::body('SYSTEM', $turns, 'claude-sonnet-5-5', 2000, 'high');
check('claude: images as base64 sources', $c['messages'][0]['content'][1]['source'] === ['type' => 'base64', 'media_type' => 'image/jpeg', 'data' => 'AAA']);
check('claude: roles', array_column($c['messages'], 'role') === ['user', 'assistant', 'user']);
check('claude: system, model, effort', $c['system'] === 'SYSTEM' && $c['model'] === 'claude-sonnet-5-5' && $c['output_config']['effort'] === 'high');

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
