<?php
// A stand-in for Gemini, served at /mock-gemini.php/models/<model>:<method>.
// The model name picks the behaviour, so one mock covers every case:
//   ok          first reply invalid (exercises the retry), then the real fixture
//   fast        the fixture straight away
//   slow        says nothing for 20 s (the endpoint's deadline must win)
//   busy        free-tier 429 RESOURCE_EXHAUSTED
//   missing     404 model not found
//   badkey      400 API key not valid
//   oldthink    400 if a thinkingLevel is sent (like Gemini 2.5), else fast
//   lines       line-by-line reading: answers overview / line / check requests from the
//               reference transcription; line 1 is first read without its pickup bar and
//               the double-check puts it back
//   daily       429 with Gemini's PerDay quota violation
//   perminute   429 with a RetryInfo retryDelay of 7 s
$model = preg_replace('#^models/#', '', ltrim($_SERVER['PATH_INFO'] ?? '', '/'));
[$model, $method] = array_pad(explode(':', preg_replace('#^models/#', '', $model)), 2, '');
$counter = sys_get_temp_dir() . "/riffi-gemini-$model";
$n = (int) @file_get_contents($counter) + 1;
file_put_contents($counter, (string) $n);
$body = json_decode(file_get_contents('php://input') ?: 'null', true);
file_put_contents(sys_get_temp_dir() . "/riffi-gemini-last-$model.json", json_encode([
    'method' => $method,
    'http_method' => $_SERVER['REQUEST_METHOD'],
    'key' => $_SERVER['HTTP_X_GOOG_API_KEY'] ?? '',
    'roles' => array_column($body['contents'] ?? [], 'role'),
    'images' => count(array_filter($body['contents'][0]['parts'] ?? [], fn ($p) => isset($p['inline_data']))),
    'system' => isset($body['system_instruction']['parts'][0]['text']),
    'mime' => $body['generationConfig']['responseMimeType'] ?? null,
    'thinking' => $body['generationConfig']['thinkingConfig'] ?? null,
]));

function fail(int $status, string $message, string $code): never
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode(['error' => ['code' => $status, 'message' => $message, 'status' => $code]]);
    exit;
}

if ($method === '' && $_SERVER['REQUEST_METHOD'] === 'GET') {
    if ($model === 'missing') fail(404, 'models/missing is not found for API version v1beta.', 'NOT_FOUND');
    header('Content-Type: application/json');
    echo json_encode(['name' => "models/$model", 'displayName' => 'Mock Flash', 'version' => '3.8']);
    exit;
}
if ($model === 'busy') fail(429, 'You exceeded your current quota. Please retry in 41s.', 'RESOURCE_EXHAUSTED');
if ($model === 'daily' || $model === 'perminute') {
    http_response_code(429);
    header('Content-Type: application/json');
    $quota = $model === 'daily' ? 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' : 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier';
    $details = [['@type' => 'type.googleapis.com/google.rpc.QuotaFailure', 'violations' => [['quotaMetric' => 'generativelanguage.googleapis.com/generate_content_free_tier_requests', 'quotaId' => $quota]]]];
    if ($model === 'perminute') {
        $details[] = ['@type' => 'type.googleapis.com/google.rpc.RetryInfo', 'retryDelay' => '7s'];
    }
    echo json_encode(['error' => ['code' => 429, 'message' => 'You exceeded your current quota.', 'status' => 'RESOURCE_EXHAUSTED', 'details' => $details]]);
    exit;
}
if ($model === 'missing') fail(404, 'models/missing is not found for API version v1beta, or is not supported for generateContent.', 'NOT_FOUND');
if ($model === 'badkey') fail(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT');
if ($model === 'oldthink' && isset($body['generationConfig']['thinkingConfig']['thinkingLevel'])) {
    fail(400, 'Invalid JSON payload received. Unknown name "thinkingLevel" at generation_config.thinking_config.', 'INVALID_ARGUMENT');
}
if ($model === 'slow') {
    sleep(20);
}

$ref = json_decode(file_get_contents(__DIR__ . '/../fixtures/sheets/hermans-hornpipe.reference.json'), true);
$page = ['title' => $ref['title'], 'composer' => $ref['composer'], 'tempo' => $ref['tempo'], 'staves' => 1, 'measures' => $ref['measures'],
    'warnings' => ['Bar 10: please check the triplet notes under the highlighter.']];
$text = ($model === 'ok' && $n === 1) ? '{"title": "Herman\'s hornpipe", "measures": [{"n": 1, "s1": "F#5 D5s"}]}' : json_encode($page);

if ($model === 'lines') {
    // Which step is this? The last text part of the user's turn says.
    $parts = $body['contents'][0]['parts'] ?? [];
    $prompt = (string) (end($parts)['text'] ?? '');
    $bars = function (int $line) use ($ref): array {
        [$from, $to] = $ref['lines'][$line - 1];
        return array_values(array_filter($ref['measures'], fn ($m) => $m['n'] >= $from && $m['n'] <= $to));
    };
    if (str_contains($prompt, 'Do NOT transcribe the notes')) {
        $text = json_encode(['title' => $ref['title'], 'composer' => $ref['composer'], 'tempo' => $ref['tempo'], 'key' => 2, 'time' => '4/4', 'clef' => 'treble',
            'staves' => 1, 'pickup' => true, 'pickup_notes' => 'A5e', 'lines' => 7, 'first_bars' => [null, 4, 7, 10, 13, 16, 19], 'changes' => ['repeat from bar 1 to bar 16']]);
    } elseif (preg_match('/ONE line \(system\) of music: line (\d+) of/', $prompt, $m) || preg_match('/are lines (\d+) to (\d+)/', $prompt, $m)) {
        $out = [];
        for ($line = (int) $m[1]; $line <= (int) ($m[2] ?? $m[1]); $line++) {
            $measures = $bars($line);
            if ($line === 1) {
                array_shift($measures); // forgets the pickup
                $measures[0] += ['key' => 2, 'time' => '4/4'];
            }
            $out[] = ['line' => $line, 'measures' => $measures, 'unsure' => $line === 7 ? [21] : []];
        }
        $text = json_encode(['lines' => $out, 'warnings' => []]);
    } elseif (str_contains($prompt, 'computer engraving of our transcription')) {
        preg_match_all('/Line (\d+) transcription \(Riffi Notation\):\n(.*)\n/', $prompt, $all, PREG_SET_ORDER);
        $out = [];
        foreach ($all as [, $line, $json]) {
            $line = (int) $line;
            $sent = json_decode($json, true)['measures'] ?? [];
            $want = $bars($line);
            $same = array_column($sent, 's1') === array_column($want, 's1');
            $out[] = $same
                ? ['line' => $line, 'mismatches' => [], 'measures' => null, 'unsure' => $line === 7 ? [21] : []]
                : ['line' => $line, 'mismatches' => [['bar' => 0, 'what' => 'pickup', 'detail' => 'The A5 eighth-note pickup before the repeat is missing.']], 'measures' => $want, 'unsure' => []];
        }
        $text = json_encode(['lines' => $out]);
    }
}

if ($method === 'generateContent') {
    header('Content-Type: application/json');
    echo json_encode(['candidates' => [['content' => ['parts' => [['text' => '{"ok": true}']]], 'finishReason' => 'STOP']]]);
    exit;
}

header('Content-Type: text/event-stream');
$send = function (array $chunk) {
    echo 'data: ' . json_encode($chunk) . "\r\n\r\n";
    flush();
};
$send(['candidates' => [['content' => ['role' => 'model', 'parts' => [['text' => 'Reading the staves…', 'thought' => true]]]]]]);
foreach (str_split($text, 400) as $piece) {
    $send(['candidates' => [['content' => ['role' => 'model', 'parts' => [['text' => $piece]]]]]]);
    usleep(20_000);
}
$send(['candidates' => [['content' => ['role' => 'model', 'parts' => [['text' => '']]], 'finishReason' => 'STOP']], 'usageMetadata' => ['candidatesTokenCount' => 1200]]);
