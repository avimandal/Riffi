<?php
/**
 * Riffi sheet-reading endpoint (photo → MusicXML).
 *
 * POST multipart/form-data:
 *   pages[]     one or more images, in page order
 *   instrument  violin | piano | voice
 *
 * Response (JSON): { "musicxml": "...", "warnings": ["..."] }
 *
 * Images and results are processed in memory and never stored. The only
 * thing written to disk is a tiny per-IP counter for rate limiting.
 *
 * Requires PHP 8.1+ with cURL, DOM and fileinfo.
 */

declare(strict_types=1);

const RIFFI_INSTRUMENTS = ['violin', 'piano', 'voice'];
const RIFFI_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const RIFFI_ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const RIFFI_ANTHROPIC_VERSION = '2023-06-01';
/** Models that accept the server-side refusal fallback ("default" form). */
const RIFFI_FALLBACK_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1'];

final class RiffiHttpError extends Exception
{
    public function __construct(public readonly int $status, public readonly string $errorCode, string $message)
    {
        parent::__construct($message);
    }
}

/** Send a JSON response and stop. */
function riffi_json(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * Load config. Prefers a file outside the web root; falls back to api/config.php
 * (which api/.htaccess blocks from the web).
 */
function riffi_load_config(): array
{
    $candidates = [];
    $env = getenv('RIFFI_CONFIG');
    if (is_string($env) && $env !== '') {
        $candidates[] = $env;
    }
    if (!empty($_SERVER['DOCUMENT_ROOT'])) {
        $candidates[] = dirname((string) $_SERVER['DOCUMENT_ROOT']) . '/riffi-config.php';
    }
    $candidates[] = dirname(__DIR__, 2) . '/riffi-config.php';
    $candidates[] = __DIR__ . '/config.php';

    foreach ($candidates as $path) {
        if (@is_file($path) && @is_readable($path)) {
            $cfg = require $path;
            if (is_array($cfg)) {
                return $cfg + riffi_default_config();
            }
        }
    }
    throw new RiffiHttpError(500, 'not_configured', 'The music reader is not set up yet.');
}

function riffi_default_config(): array
{
    return [
        'ANTHROPIC_API_KEY' => '',
        'MODEL' => 'claude-sonnet-5-5',
        'MAX_PAGES' => 8,
        'MAX_BYTES_PER_PAGE' => 3 * 1024 * 1024,
        'ALLOWED_ORIGIN' => '',
        'RATE_LIMIT_PER_HOUR' => 20,
        'RATE_LIMIT_DIR' => null,
        'TRUST_PROXY' => false,
        'MAX_TOKENS' => 64000,
        'EFFORT' => 'high',
        'USE_FALLBACKS' => true,
        'TIMEOUT_SECONDS' => 240,
        // Only change for testing against a mock server.
        'API_URL' => RIFFI_ANTHROPIC_URL,
    ];
}

/** CORS: only the app's own origin may call us from a browser. */
function riffi_cors(array $cfg): void
{
    $allowed = rtrim((string) $cfg['ALLOWED_ORIGIN'], '/');
    $origin = isset($_SERVER['HTTP_ORIGIN']) ? rtrim((string) $_SERVER['HTTP_ORIGIN'], '/') : '';
    header('Vary: Origin');
    if ($origin !== '') {
        if ($allowed === '' || !hash_equals(strtolower($allowed), strtolower($origin))) {
            throw new RiffiHttpError(403, 'origin', 'This origin is not allowed.');
        }
        header('Access-Control-Allow-Origin: ' . $allowed);
        header('Access-Control-Allow-Methods: POST, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type');
        header('Access-Control-Max-Age: 600');
    }
}

function riffi_client_ip(array $cfg): string
{
    if (!empty($cfg['TRUST_PROXY']) && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $first = trim(explode(',', (string) $_SERVER['HTTP_X_FORWARDED_FOR'])[0]);
        if (filter_var($first, FILTER_VALIDATE_IP)) {
            return $first;
        }
    }
    return (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

/**
 * File-based sliding-window rate limit (default 20 scans per hour per IP).
 * IPs are stored only as salted hashes.
 */
function riffi_rate_limit(array $cfg): void
{
    $limit = (int) $cfg['RATE_LIMIT_PER_HOUR'];
    if ($limit <= 0) {
        return;
    }
    $dir = $cfg['RATE_LIMIT_DIR'] ?: (sys_get_temp_dir() . '/riffi-ratelimit');
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        error_log('riffi: cannot create rate limit dir ' . $dir);
        return; // fail open rather than lock kids out
    }
    $salt = hash('sha256', (string) $cfg['ANTHROPIC_API_KEY'] . 'riffi');
    $file = $dir . '/' . hash('sha256', $salt . riffi_client_ip($cfg)) . '.json';
    $fh = @fopen($file, 'c+');
    if (!$fh) {
        return;
    }
    try {
        flock($fh, LOCK_EX);
        $raw = stream_get_contents($fh);
        $now = time();
        $hits = array_values(array_filter(
            is_string($raw) && $raw !== '' ? (json_decode($raw, true) ?: []) : [],
            static fn ($t) => is_int($t) && $t > $now - 3600
        ));
        if (count($hits) >= $limit) {
            $retry = max(60, 3600 - ($now - min($hits)));
            header('Retry-After: ' . $retry);
            throw new RiffiHttpError(429, 'rate_limited', 'Too many scans this hour.');
        }
        $hits[] = $now;
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, json_encode($hits));
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
    }

    // Occasionally tidy up old counters.
    if (random_int(1, 50) === 1) {
        foreach (glob($dir . '/*.json') ?: [] as $f) {
            if (@filemtime($f) < time() - 7200) {
                @unlink($f);
            }
        }
    }
}

/** Validate uploads and return [ [mime, base64], ... ] in page order. */
function riffi_read_pages(array $cfg): array
{
    $files = $_FILES['pages'] ?? null;
    if (!$files || !isset($files['tmp_name'])) {
        $len = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($len > 0) {
            throw new RiffiHttpError(413, 'too_big', 'The photos are too big to upload.');
        }
        throw new RiffiHttpError(400, 'no_pages', 'No pages were sent.');
    }
    $tmp = (array) $files['tmp_name'];
    $errors = (array) $files['error'];
    $sizes = (array) $files['size'];
    $count = count($tmp);
    if ($count < 1) {
        throw new RiffiHttpError(400, 'no_pages', 'No pages were sent.');
    }
    if ($count > (int) $cfg['MAX_PAGES']) {
        throw new RiffiHttpError(413, 'too_many_pages', 'Too many pages.');
    }
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $pages = [];
    for ($i = 0; $i < $count; $i++) {
        $err = (int) ($errors[$i] ?? UPLOAD_ERR_NO_FILE);
        if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) {
            throw new RiffiHttpError(413, 'too_big', 'A photo is too big.');
        }
        if ($err !== UPLOAD_ERR_OK || !is_uploaded_file((string) $tmp[$i])) {
            throw new RiffiHttpError(400, 'upload_failed', 'A photo did not upload properly.');
        }
        if ((int) $sizes[$i] > (int) $cfg['MAX_BYTES_PER_PAGE']) {
            throw new RiffiHttpError(413, 'too_big', 'A photo is too big.');
        }
        $mime = (string) $finfo->file((string) $tmp[$i]);
        if (!in_array($mime, RIFFI_IMAGE_TYPES, true)) {
            throw new RiffiHttpError(400, 'not_an_image', 'Pages must be photos.');
        }
        $data = file_get_contents((string) $tmp[$i]);
        @unlink((string) $tmp[$i]); // don't leave it lying around
        if ($data === false) {
            throw new RiffiHttpError(400, 'upload_failed', 'A photo could not be read.');
        }
        $pages[] = [$mime, base64_encode($data)];
    }
    return $pages;
}

function riffi_system_prompt(): string
{
    return <<<'PROMPT'
You are an expert music engraver transcribing photographed sheet music for a children's music practice app. The app plays along with the child and scores every note, so pitch and rhythm accuracy matter more than anything else.

Output exactly one MusicXML 3.1 document in score-partwise form and nothing else: no prose, no Markdown fences.

Include:
- the title (in <work><work-title>), if printed
- clefs, key signatures and time signatures, including any changes
- a tempo marking if printed, as <direction> with <metronome> and <sound tempo="..."/> in quarter notes per minute
- every note and rest with correct pitch (<step>, <alter>, <octave>), <duration>, <type> and dots
- accidentals as <alter> on the pitch (and <accidental> where printed)
- ties (<tie> plus <notations><tied>), repeats (<barline><repeat>) and first/second endings (<ending>)
- for piano: one part with <staves>2</staves>, treble on staff 1 and bass on staff 2, using <backup> between staves and <chord/> for chords

Leave out lyrics, fingering, chord symbols, dynamics and articulations.

Rules:
- Use one consistent <divisions> value that can express every duration as a whole number.
- Each measure's durations must add up to its time signature, except a pickup measure, which gets implicit="yes".
- Pages are given in order; continue measure numbering across pages.
- If something is genuinely unclear (a smudged accidental, a cut-off bar), make your best musical guess and add an XML comment right after the root element in this exact form: <!-- riffi-warning: Bar 7: the accidental on the third note was hard to read. --> Use short, plain, friendly English that a parent can read, and only for real doubts (at most five).
PROMPT;
}

function riffi_user_content(array $pages, string $instrument): array
{
    $content = [];
    foreach ($pages as $i => [$mime, $b64]) {
        $content[] = ['type' => 'text', 'text' => 'Page ' . ($i + 1) . ':'];
        $content[] = ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => $mime, 'data' => $b64]];
    }
    $names = ['violin' => 'violin', 'piano' => 'piano (both hands)', 'voice' => 'singing (the vocal melody line)'];
    $content[] = [
        'type' => 'text',
        'text' => 'Transcribe these ' . count($pages) . ' page(s) of sheet music, in order, as one MusicXML 3.1 partwise document. '
            . 'The child will play this on ' . $names[$instrument] . '. '
            . ($instrument === 'piano'
                ? 'Keep both staves.'
                : 'If the page has a piano accompaniment as well, put the ' . $instrument . ' line in the first part.'),
    ];
    return $content;
}

/**
 * Call the Messages API with streaming (long outputs, so we avoid HTTP
 * timeouts) and return [text, stop_reason].
 */
function riffi_call_claude(array $cfg, array $messages): array
{
    $model = (string) $cfg['MODEL'];
    $body = [
        'model' => $model,
        'max_tokens' => (int) $cfg['MAX_TOKENS'],
        'stream' => true,
        'system' => riffi_system_prompt(),
        'messages' => $messages,
    ];
    if (!empty($cfg['EFFORT'])) {
        $body['output_config'] = ['effort' => (string) $cfg['EFFORT']];
    }
    $headers = [
        'content-type: application/json',
        'x-api-key: ' . $cfg['ANTHROPIC_API_KEY'],
        'anthropic-version: ' . RIFFI_ANTHROPIC_VERSION,
    ];
    if (!empty($cfg['USE_FALLBACKS']) && in_array($model, RIFFI_FALLBACK_MODELS, true)) {
        // If the model declines, the API retries on a suitable fallback model in the same call.
        $body['fallbacks'] = 'default';
        $headers[] = 'anthropic-beta: server-side-fallback-2026-07-01';
    }

    $text = '';
    $stopReason = null;
    $streamError = null;
    $buffer = '';
    $rawError = '';

    $ch = curl_init((string) $cfg['API_URL']);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_SLASHES),
        CURLOPT_TIMEOUT => (int) $cfg['TIMEOUT_SECONDS'],
        CURLOPT_CONNECTTIMEOUT => 15,
        CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk) use (&$buffer, &$text, &$stopReason, &$streamError, &$rawError): int {
            $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            if ($status >= 400) {
                $rawError .= $chunk;
                return strlen($chunk);
            }
            $buffer .= $chunk;
            // Server-sent events: blocks separated by a blank line.
            while (($pos = strpos($buffer, "\n\n")) !== false) {
                $event = substr($buffer, 0, $pos);
                $buffer = substr($buffer, $pos + 2);
                foreach (explode("\n", $event) as $line) {
                    if (!str_starts_with($line, 'data:')) {
                        continue;
                    }
                    $data = json_decode(trim(substr($line, 5)), true);
                    if (!is_array($data)) {
                        continue;
                    }
                    $type = $data['type'] ?? '';
                    if ($type === 'content_block_delta' && ($data['delta']['type'] ?? '') === 'text_delta') {
                        $text .= (string) $data['delta']['text'];
                    } elseif ($type === 'message_delta' && isset($data['delta']['stop_reason'])) {
                        $stopReason = (string) $data['delta']['stop_reason'];
                    } elseif ($type === 'error') {
                        $streamError = (string) ($data['error']['type'] ?? 'error');
                    }
                }
            }
            return strlen($chunk);
        },
    ]);
    $ok = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($ok === false) {
        error_log('riffi: curl error ' . $curlErr);
        throw new RiffiHttpError(502, 'upstream', 'The music reader could not be reached.');
    }
    if ($status === 429 || $status === 529 || $streamError === 'overloaded_error' || $streamError === 'rate_limit_error') {
        throw new RiffiHttpError(503, 'busy', 'The music reader is busy.');
    }
    if ($status >= 400 || $streamError !== null) {
        error_log('riffi: API error ' . $status . ' ' . substr($rawError, 0, 500) . ' ' . (string) $streamError);
        throw new RiffiHttpError(502, 'upstream', 'The music reader had a problem.');
    }
    return [$text, $stopReason];
}

/** Pull the MusicXML document out of the model's reply. */
function riffi_extract_xml(string $text): string
{
    $text = preg_replace('/^```(?:xml)?\s*|```\s*$/m', '', $text) ?? $text;
    $start = strpos($text, '<?xml');
    if ($start === false) {
        $start = strpos($text, '<score-partwise');
    }
    $end = strrpos($text, '</score-partwise>');
    if ($start === false || $end === false || $end < $start) {
        return trim($text);
    }
    return trim(substr($text, $start, $end - $start + strlen('</score-partwise>')));
}

/** Returns null if valid, otherwise a short description of the problem. */
function riffi_validate_xml(string $xml): ?string
{
    if ($xml === '') {
        return 'The response was empty.';
    }
    $prev = libxml_use_internal_errors(true);
    libxml_clear_errors();
    $dom = new DOMDocument();
    // No network access, no entity substitution: never trust model output blindly.
    $ok = $dom->loadXML($xml, LIBXML_NONET | LIBXML_NOBLANKS);
    $errors = libxml_get_errors();
    libxml_clear_errors();
    libxml_use_internal_errors($prev);
    if (!$ok) {
        $first = $errors[0] ?? null;
        return $first ? sprintf('XML parse error on line %d: %s', $first->line, trim($first->message)) : 'The XML could not be parsed.';
    }
    $root = $dom->documentElement;
    if (!$root || $root->localName !== 'score-partwise') {
        return 'The root element must be <score-partwise>.';
    }
    $xpath = new DOMXPath($dom);
    $pitched = $xpath->query('//note[pitch]');
    if ($pitched === false || $pitched->length < 1) {
        return 'The document has no pitched notes.';
    }
    return null;
}

/** Collect <!-- riffi-warning: ... --> comments (and remove them). */
function riffi_take_warnings(string &$xml): array
{
    $warnings = [];
    $xml = preg_replace_callback('/<!--\s*riffi-warning:\s*(.*?)\s*-->\s*/s', static function (array $m) use (&$warnings) {
        $w = trim(strip_tags($m[1]));
        if ($w !== '' && count($warnings) < 5) {
            $warnings[] = mb_substr($w, 0, 200);
        }
        return '';
    }, $xml) ?? $xml;
    return $warnings;
}

function riffi_main(): void
{
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store');
    header('Referrer-Policy: no-referrer');

    try {
        $cfg = riffi_load_config();
        riffi_cors($cfg);
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        if ($method === 'OPTIONS') {
            http_response_code(204);
            exit;
        }
        if ($method !== 'POST') {
            header('Allow: POST, OPTIONS');
            throw new RiffiHttpError(405, 'method', 'Use POST.');
        }
        if (empty($cfg['ANTHROPIC_API_KEY'])) {
            throw new RiffiHttpError(500, 'not_configured', 'The music reader is not set up yet.');
        }
        $instrument = (string) ($_POST['instrument'] ?? 'violin');
        if (!in_array($instrument, RIFFI_INSTRUMENTS, true)) {
            throw new RiffiHttpError(400, 'instrument', 'Unknown instrument.');
        }
        $pages = riffi_read_pages($cfg);
        riffi_rate_limit($cfg);
        @set_time_limit((int) $cfg['TIMEOUT_SECONDS'] * 2 + 30);

        $messages = [['role' => 'user', 'content' => riffi_user_content($pages, $instrument)]];
        [$text, $stop] = riffi_call_claude($cfg, $messages);
        if ($stop === 'refusal') {
            throw new RiffiHttpError(422, 'unreadable', 'That page could not be read as music.');
        }
        $xml = riffi_extract_xml($text);
        $problem = riffi_validate_xml($xml);
        if ($problem === null && $stop === 'max_tokens') {
            $problem = 'The output was cut off before the end.';
        }

        if ($problem !== null) {
            // One retry, telling the model exactly what was wrong.
            $messages[] = ['role' => 'assistant', 'content' => $text !== '' ? $text : '(no output)'];
            $messages[] = [
                'role' => 'user',
                'content' => 'That MusicXML could not be used: ' . $problem
                    . ' Please send the complete, corrected MusicXML 3.1 partwise document only.',
            ];
            [$text, $stop] = riffi_call_claude($cfg, $messages);
            if ($stop === 'refusal') {
                throw new RiffiHttpError(422, 'unreadable', 'That page could not be read as music.');
            }
            $xml = riffi_extract_xml($text);
            $problem = riffi_validate_xml($xml);
            if ($problem !== null) {
                error_log('riffi: invalid MusicXML after retry: ' . $problem);
                throw new RiffiHttpError(422, 'unreadable', 'We could not read music from those photos.');
            }
        }

        $warnings = riffi_take_warnings($xml);
        riffi_json(200, ['musicxml' => $xml, 'warnings' => $warnings]);
    } catch (RiffiHttpError $e) {
        riffi_json($e->status, ['error' => $e->getMessage(), 'code' => $e->errorCode]);
    } catch (Throwable $e) {
        error_log('riffi: ' . $e->getMessage());
        riffi_json(500, ['error' => 'Something went wrong.', 'code' => 'server']);
    }
}

if (PHP_SAPI !== 'cli' || getenv('RIFFI_RUN') === '1') {
    riffi_main();
}
