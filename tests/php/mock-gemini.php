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
if ($model === 'missing') fail(404, 'models/missing is not found for API version v1beta, or is not supported for generateContent.', 'NOT_FOUND');
if ($model === 'badkey') fail(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT');
if ($model === 'oldthink' && isset($body['generationConfig']['thinkingConfig']['thinkingLevel'])) {
    fail(400, 'Invalid JSON payload received. Unknown name "thinkingLevel" at generation_config.thinking_config.', 'INVALID_ARGUMENT');
}
if ($model === 'slow') {
    sleep(20);
}

$fixture = file_get_contents(__DIR__ . '/../fixtures/sheets/hermans-hornpipe.rn.json');
$text = ($model === 'ok' && $n === 1) ? '{"title": "Herman\'s hornpipe", "measures": [{"n": 1, "s1": "F#5 D5s"}]}' : $fixture;

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
