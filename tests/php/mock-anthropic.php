<?php
// A stand-in for the Messages API that streams server-sent events.
// First call: invalid notation (to exercise the retry). Second call: a small valid score.
$state = sys_get_temp_dir() . '/riffi-mock-count';
$n = (int) @file_get_contents($state) + 1;
file_put_contents($state, (string) $n);
$body = json_decode(file_get_contents('php://input'), true);
file_put_contents(sys_get_temp_dir() . '/riffi-mock-last.json', json_encode([
    'headers' => ['x-api-key' => $_SERVER['HTTP_X_API_KEY'] ?? '', 'anthropic-version' => $_SERVER['HTTP_ANTHROPIC_VERSION'] ?? '', 'anthropic-beta' => $_SERVER['HTTP_ANTHROPIC_BETA'] ?? ''],
    'model' => $body['model'] ?? null,
    'stream' => $body['stream'] ?? null,
    'fallbacks' => $body['fallbacks'] ?? null,
    'messages' => count($body['messages'] ?? []),
    'images' => count(array_filter($body['messages'][0]['content'] ?? [], fn ($c) => ($c['type'] ?? '') === 'image')),
]));

header('Content-Type: text/event-stream');
$xml = $n === 1
    ? '{"measures": [{"n": 1, "s1": "A4"}]}'
    : "Sure!\n```json\n" . json_encode([
        'title' => 'Tiny tune',
        'staves' => 1,
        'measures' => [['n' => 1, 'key' => 0, 'time' => '4/4', 's1' => 'A4w']],
        'warnings' => ['Bar 2: a note was hard to read.'],
    ]) . "\n```";
$send = function (string $event, array $data) {
    echo "event: $event\ndata: " . json_encode($data) . "\n\n";
    flush();
};
$send('message_start', ['type' => 'message_start', 'message' => ['id' => 'msg_test']]);
$send('content_block_start', ['type' => 'content_block_start', 'index' => 0, 'content_block' => ['type' => 'thinking', 'thinking' => '']]);
$send('content_block_delta', ['type' => 'content_block_delta', 'index' => 0, 'delta' => ['type' => 'thinking_delta', 'thinking' => '']]);
$send('content_block_stop', ['type' => 'content_block_stop', 'index' => 0]);
$send('content_block_start', ['type' => 'content_block_start', 'index' => 1, 'content_block' => ['type' => 'text', 'text' => '']]);
foreach (str_split($xml, 37) as $piece) {
    $send('content_block_delta', ['type' => 'content_block_delta', 'index' => 1, 'delta' => ['type' => 'text_delta', 'text' => $piece]]);
}
$send('content_block_stop', ['type' => 'content_block_stop', 'index' => 1]);
$send('message_delta', ['type' => 'message_delta', 'delta' => ['stop_reason' => 'end_turn']]);
$send('message_stop', ['type' => 'message_stop']);
