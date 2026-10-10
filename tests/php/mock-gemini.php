<?php
// A stand-in for Gemini's generateContent, served at /mock-gemini.php/models/<model>:generateContent.
// Call 1: broken XML (to exercise the retry). Call 2: valid MusicXML. Call 3+: free-tier 429.
$state = sys_get_temp_dir() . '/riffi-gemini-count';
$n = (int) @file_get_contents($state) + 1;
file_put_contents($state, (string) $n);
$body = json_decode(file_get_contents('php://input'), true);
file_put_contents(sys_get_temp_dir() . '/riffi-gemini-last.json', json_encode([
    'path' => $_SERVER['PATH_INFO'] ?? '',
    'key' => $_SERVER['HTTP_X_GOOG_API_KEY'] ?? '',
    'roles' => array_column($body['contents'] ?? [], 'role'),
    'images' => count(array_filter($body['contents'][0]['parts'] ?? [], fn ($p) => isset($p['inline_data']))),
    'system' => isset($body['system_instruction']['parts'][0]['text']),
]));
header('Content-Type: application/json');
if ($n >= 3) {
    http_response_code(429);
    echo json_encode(['error' => ['code' => 429, 'status' => 'RESOURCE_EXHAUSTED', 'message' => 'Quota exceeded for free tier.']]);
    exit;
}
$text = $n === 1
    ? '<score-partwise><part id="P1"><measure>'
    : "```xml\n<?xml version=\"1.0\"?><score-partwise version=\"3.1\"><!-- riffi-warning: Bar 1: the clef was faint. --><part-list><score-part id=\"P1\"><part-name>Violin</part-name></score-part></part-list><part id=\"P1\"><measure number=\"1\"><note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>\n```";
echo json_encode([
    'candidates' => [[
        'content' => ['role' => 'model', 'parts' => [['text' => 'Reading the staff…', 'thought' => true], ['text' => $text]]],
        'finishReason' => 'STOP',
    ]],
]);
