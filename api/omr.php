<?php
/**
 * Riffi sheet-reading endpoint (photo → Riffi Notation).
 *
 * POST multipart/form-data, ONE page per request:
 *   pages[]     the page image
 *   instrument  violin | piano | voice
 *   page, pages (optional) which page this is, e.g. 2 of 3
 *
 * The AI returns Riffi Notation (RN), a compact JSON note list (see
 * src/sheet/notation.ts): about a tenth of the size of MusicXML, so even a
 * dense page reads in seconds. The app turns RN into MusicXML itself.
 *
 * Errors found before the AI is asked (bad origin, too big, rate limit…) are
 * plain JSON with an HTTP status. After that the reply is a stream of JSON
 * lines (application/x-ndjson) so Cloudflare and the host see data flowing:
 *   {"type":"start","ref":"a1b2c3"}  {"type":"ping"}  {"type":"progress","bars":12}
 *   {"type":"result","score":{…},"warnings":[…],"ref":"a1b2c3"}
 *   {"type":"error","code":"timeout","message":"…","ref":"a1b2c3"}
 *
 * GET ?check=1 runs a self-check (PHP limits, config, provider reachability,
 * model, a tiny test request, log file) and streams a report.
 *
 * The AI provider is chosen by PROVIDER in the config: Google Gemini
 * ('gemini', the default) or Anthropic Claude ('claude'), behind one adapter
 * interface with the same prompt, validation and single retry.
 *
 * Images and results are processed in memory and never stored. On disk there
 * is only a per-IP rate-limit counter and a private log (outside the web
 * root) of what went wrong, never images, results or keys.
 *
 * Requires PHP 8.1+ with cURL, DOM, fileinfo and mbstring.
 */

declare(strict_types=1);

const RIFFI_INSTRUMENTS = ['violin', 'piano', 'voice'];
const RIFFI_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const RIFFI_ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const RIFFI_ANTHROPIC_VERSION = '2023-06-01';
const RIFFI_GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** Models that accept the Claude API's server-side refusal fallback ("default" form). */
const RIFFI_FALLBACK_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1'];

final class RiffiHttpError extends Exception
{
    public function __construct(public readonly int $status, public readonly string $errorCode, string $message, public readonly string $detail = '')
    {
        parent::__construct($message);
    }
}

// ---------------------------------------------------------------------------
// Config

function riffi_default_config(): array
{
    return [
        // Which AI reads the music: 'gemini' (default) or 'claude'.
        'PROVIDER' => 'gemini',
        'GEMINI_API_KEY' => '',
        // Google's alias for the current Flash model. Pin an exact ID if you prefer.
        'GEMINI_MODEL' => 'gemini-flash-latest',
        // How hard Gemini thinks before answering: 'low' keeps pages quick. '' = model default.
        'GEMINI_THINKING' => 'low',
        'GEMINI_MAX_TOKENS' => 16384,
        'ANTHROPIC_API_KEY' => '',
        'CLAUDE_MODEL' => 'claude-sonnet-5-5',
        'MAX_PAGES' => 8,
        'MAX_BYTES_PER_PAGE' => 3 * 1024 * 1024,
        'ALLOWED_ORIGIN' => '',
        // Pages read per IP per hour (each page is one request).
        'RATE_LIMIT_PER_HOUR' => 40,
        'RATE_LIMIT_DIR' => null,
        'TRUST_PROXY' => false,
        // Claude only.
        'MAX_TOKENS' => 16384,
        'EFFORT' => 'medium',
        'USE_FALLBACKS' => true,
        // Whole-request deadline. Cloudflare gives up after 100 s, so stay under it.
        'REQUEST_SECONDS' => 85,
        // Private log of failures (no keys, no images). null = a riffi-logs folder
        // next to (outside) the web root, falling back to the system temp folder. false = off.
        'LOG_FILE' => null,
        // Allow GET ?check=1 (the "Check music reader" button in the Parent area).
        'DIAGNOSTICS' => true,
        // Only change these for testing against a mock server.
        'GEMINI_API_URL' => RIFFI_GEMINI_URL,
        'CLAUDE_API_URL' => RIFFI_ANTHROPIC_URL,
    ];
}

/** Where the config came from: 'outside-web-root', 'env' or 'api-folder'. */
$GLOBALS['riffi_config_source'] = null;

/**
 * Load config. Prefers a file outside the web root; falls back to api/config.php
 * (which api/.htaccess blocks from the web).
 */
function riffi_load_config(): array
{
    $candidates = [];
    $env = getenv('RIFFI_CONFIG');
    if (is_string($env) && $env !== '') {
        $candidates[] = [$env, 'env'];
    }
    if (!empty($_SERVER['DOCUMENT_ROOT'])) {
        $candidates[] = [dirname((string) $_SERVER['DOCUMENT_ROOT']) . '/riffi-config.php', 'outside-web-root'];
    }
    $candidates[] = [dirname(__DIR__, 2) . '/riffi-config.php', 'outside-web-root'];
    $candidates[] = [__DIR__ . '/config.php', 'api-folder'];

    foreach ($candidates as [$path, $source]) {
        if (@is_file($path) && @is_readable($path)) {
            $cfg = require $path;
            if (is_array($cfg)) {
                // Older configs used MODEL / API_URL for Claude.
                if (isset($cfg['MODEL']) && !isset($cfg['CLAUDE_MODEL'])) {
                    $cfg['CLAUDE_MODEL'] = $cfg['MODEL'];
                }
                if (isset($cfg['API_URL']) && !isset($cfg['CLAUDE_API_URL'])) {
                    $cfg['CLAUDE_API_URL'] = $cfg['API_URL'];
                }
                $GLOBALS['riffi_config_source'] = $source;
                return $cfg + riffi_default_config();
            }
        }
    }
    throw new RiffiHttpError(500, 'not_configured', 'The music reader is not set up yet.');
}

// ---------------------------------------------------------------------------
// Private log (outside the web root). Never contains keys, images or results.

final class RiffiLog
{
    private static ?string $file = null;
    private static array $secrets = [];
    public static string $ref = '';

    public static function init(array $cfg): void
    {
        self::$ref = bin2hex(random_bytes(3));
        self::$secrets = array_values(array_filter([(string) $cfg['GEMINI_API_KEY'], (string) $cfg['ANTHROPIC_API_KEY']], fn ($k) => strlen($k) >= 8));
        if ($cfg['LOG_FILE'] === false) {
            self::$file = null;
            return;
        }
        $candidates = [];
        if (is_string($cfg['LOG_FILE']) && $cfg['LOG_FILE'] !== '') {
            $candidates[] = $cfg['LOG_FILE'];
        }
        if (!empty($_SERVER['DOCUMENT_ROOT'])) {
            $candidates[] = dirname((string) $_SERVER['DOCUMENT_ROOT']) . '/riffi-logs/omr.log';
        }
        $candidates[] = sys_get_temp_dir() . '/riffi-logs/omr.log';
        foreach ($candidates as $path) {
            $dir = dirname($path);
            if ((is_dir($dir) || @mkdir($dir, 0700, true)) && is_writable($dir)) {
                self::$file = $path;
                return;
            }
        }
    }

    public static function where(): string
    {
        if (self::$file === null) {
            return 'off';
        }
        $root = !empty($_SERVER['DOCUMENT_ROOT']) ? realpath((string) $_SERVER['DOCUMENT_ROOT']) : false;
        $real = realpath(dirname(self::$file)) ?: dirname(self::$file);
        if ($root && str_starts_with($real, $root)) {
            return 'inside the web root (move it!)';
        }
        if (str_starts_with($real, realpath(sys_get_temp_dir()) ?: sys_get_temp_dir())) {
            return 'system temp folder';
        }
        return 'riffi-logs/' . basename(self::$file) . ' (outside the web root)';
    }

    /** Remove anything key-like before it can reach the log. */
    public static function scrub(string $s): string
    {
        foreach (self::$secrets as $k) {
            $s = str_replace($k, '[key]', $s);
        }
        $s = preg_replace('/(AIza[0-9A-Za-z_\-]{20,}|sk-ant-[0-9A-Za-z_\-]{10,})/', '[key]', $s) ?? $s;
        $s = preg_replace('/([?&]key=)[^&\s"]+/', '$1[key]', $s) ?? $s;
        return $s;
    }

    public static function write(string $event, array $fields = []): void
    {
        if (self::$file === null) {
            return;
        }
        $line = json_encode(['t' => gmdate('c'), 'ref' => self::$ref, 'event' => $event] + $fields, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $line = self::scrub((string) $line) . "\n";
        if (@filesize(self::$file) > 1_000_000) {
            @rename(self::$file, self::$file . '.1');
        }
        @file_put_contents(self::$file, $line, FILE_APPEND | LOCK_EX);
        @chmod(self::$file, 0600);
    }
}

function riffi_limits(): array
{
    return [
        'php' => PHP_VERSION,
        'sapi' => PHP_SAPI,
        'server' => substr((string) ($_SERVER['SERVER_SOFTWARE'] ?? ''), 0, 40),
        'max_execution_time' => (int) ini_get('max_execution_time'),
    ];
}

// ---------------------------------------------------------------------------
// Request guards

/** Send a JSON response and stop. */
function riffi_json(int $status, array $body): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
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
        header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type');
        header('Access-Control-Max-Age: 600');
    }
}

function riffi_client_ip(array $cfg): string
{
    if (!empty($cfg['TRUST_PROXY'])) {
        foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR'] as $h) {
            if (!empty($_SERVER[$h])) {
                $first = trim(explode(',', (string) $_SERVER[$h])[0]);
                if (filter_var($first, FILTER_VALIDATE_IP)) {
                    return $first;
                }
            }
        }
    }
    return (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

/**
 * File-based sliding-window rate limit per IP. IPs are stored only as salted hashes.
 */
function riffi_rate_limit(array $cfg): void
{
    $limit = (int) $cfg['RATE_LIMIT_PER_HOUR'];
    if ($limit <= 0) {
        return;
    }
    $dir = $cfg['RATE_LIMIT_DIR'] ?: (sys_get_temp_dir() . '/riffi-ratelimit');
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        RiffiLog::write('rate_limit_dir_unwritable');
        return; // fail open rather than lock kids out
    }
    $salt = hash('sha256', (string) $cfg['GEMINI_API_KEY'] . (string) $cfg['ANTHROPIC_API_KEY'] . 'riffi');
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
            throw new RiffiHttpError(429, 'rate_limited', 'Too many pages read this hour.');
        }
        $hits[] = $now;
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, json_encode($hits));
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
    }
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
            throw new RiffiHttpError(413, 'too_big', 'The photo is too big to upload.');
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

// ---------------------------------------------------------------------------
// Prompt (shared by every provider)

function riffi_system_prompt(): string
{
    return <<<'PROMPT'
You transcribe photographed sheet music for a children's music practice app. The app plays along with the child and checks every note, so the pitches and rhythms must be exactly right.

Reply with ONE JSON object in "Riffi Notation" and nothing else:
{
  "title": "…",            // if printed (page 1 only)
  "composer": "…",         // if printed
  "tempo": {"bpm": 70, "beat": "q", "text": "Brightly"},   // if marked; beat: h, q, e or q. (dotted); null otherwise
  "staves": 1,             // 2 for piano (treble + bass)
  "measures": [
    {"n": 0, "pickup": true, "key": 2, "time": "4/4", "clef": "treble", "s1": "A5e"},
    {"n": 1, "repeat": "start", "s1": "F#5s D5s A4s D5s E5s C#5s A4s C#5s D5q rq"}
  ],
  "warnings": ["Bar 7: the accidental on the third note was hard to read."]
}

Measure fields (leave out what doesn't apply):
- n: the bar number. pickup: true for an incomplete first bar (anacrusis).
- key: key signature as fifths (-7..7, e.g. D major = 2, F major = -1). Required on the first bar, then only when it changes.
- time: "4/4", "6/8"… Required on the first bar, then only when it changes.
- clef / clef2: "treble", "bass", "alto" or "tenor", on the first bar and when it changes (clef2 = piano bass staff).
- repeat: "start", "end" or "both". ending: "1", "2" or "1,2" on bars under a volta bracket; ending_stop: true on the bracket's last bar.
- s1: the notes of staff 1. s2: staff 2 (piano only).

Notes, space-separated, in order:
- A note is letter + accidental + octave + length: C#5q, Bb4e., F#5s~
  accidental: # ## b bb n (natural); octave: C4 is middle C; length: w h q e s t (whole, half, quarter, eighth, 16th, 32nd), then dots; ~ ties to the next note.
- Write the SOUNDING pitch with the key signature already applied: in D major every F and C is F# and C# unless marked otherwise. Accidentals last until the barline.
- Chord or double stop: join with +, length once at the end: D4+A4h
- Rest: r + length (rq, re.). A whole-bar rest is R.
- Tuplets: 3( D5s E5s D5s ) = three 16ths in the time of two.
- Each bar's lengths must add up to its time signature (except a pickup bar).
- Leave out grace notes, lyrics, fingering, bowing marks, dynamics, slurs and chord symbols.
- Ignore anything handwritten: pencil marks, circles, arrows, crossings-out and highlighter.

If something is genuinely unclear, make your best musical guess and add a short, friendly note to "warnings" that a parent can read (at most five).
PROMPT;
}

/**
 * The user's turn: the page, then the instruction.
 * Provider-neutral parts: ['text' => '...'] or ['image' => [mime, base64]].
 */
function riffi_user_parts(array $pages, string $instrument, int $page = 1, int $of = 1): array
{
    $parts = [];
    foreach ($pages as $i => $p) {
        if (count($pages) > 1) {
            $parts[] = ['text' => 'Page ' . ($i + 1) . ':'];
        }
        $parts[] = ['image' => $p];
    }
    $names = ['violin' => 'violin', 'piano' => 'piano (both hands)', 'voice' => 'singing (the vocal melody line)'];
    $text = 'Transcribe this sheet music as Riffi Notation JSON. The child will play it on ' . $names[$instrument] . '. '
        . ($instrument === 'piano' ? 'Use "staves": 2 and keep both staves. ' : 'If there is also a piano accompaniment, transcribe only the ' . $instrument . ' line. ');
    if ($of > 1) {
        $text .= "This is page $page of $of. " . ($page > 1 ? 'Continue the bar numbers from the previous page if they are printed, and give the key and time signature on its first bar. ' : '');
    }
    $parts[] = ['text' => $text];
    return $parts;
}

// ---------------------------------------------------------------------------
// Validation (light; the app does the full conversion)

/** Pull the JSON object out of a reply (tolerates code fences and chatter). */
function riffi_extract_json(string $text): ?array
{
    $start = strpos($text, '{');
    $end = strrpos($text, '}');
    if ($start === false || $end === false || $end < $start) {
        return null;
    }
    $data = json_decode(substr($text, $start, $end - $start + 1), true);
    return is_array($data) ? $data : null;
}

/** Check one staff string's tokens. Returns the first problem, or null. */
function riffi_check_staff(string $src): ?string
{
    $src = preg_replace('/(\d)\(/', ' $1( ', $src) ?? $src;
    $src = preg_replace('/(?<!\d)\(/', ' ( ', $src) ?? $src;
    $src = str_replace(')', ' ) ', $src);
    $note = '[A-G](?:##|#|bb|b|n)?\d';
    $len = '[whqest]\.{0,2}';
    foreach (preg_split('/\s+/', trim($src)) ?: [] as $tok) {
        if ($tok === '' || $tok === '(' || $tok === ')' || $tok === 'R' || preg_match('/^\d\($/', $tok)) {
            continue;
        }
        if (preg_match("/^r$len~?$/", $tok) || preg_match("/^(?:$note(?:$len)?\+)*$note$len~?$/", $tok)) {
            continue;
        }
        return "\"$tok\" isn't a note or rest like C#5q or rq";
    }
    return null;
}

/** Check a Riffi Notation reply. Returns [score, null] or [null, problem]. */
function riffi_validate_score(string $text): array
{
    if (trim($text) === '') {
        return [null, 'The reply was empty.'];
    }
    $score = riffi_extract_json($text);
    if ($score === null) {
        return [null, 'The reply was not a valid JSON object.'];
    }
    if (!isset($score['measures']) || !is_array($score['measures']) || count($score['measures']) === 0) {
        return [null, 'The JSON has no "measures".'];
    }
    $notes = 0;
    foreach ($score['measures'] as $i => $m) {
        if (!is_array($m)) {
            return [null, "Measure $i is not an object."];
        }
        foreach (['s1', 's2'] as $k) {
            if (!isset($m[$k])) {
                continue;
            }
            if (!is_string($m[$k])) {
                return [null, 'Measure ' . ($m['n'] ?? $i) . ": $k must be a string."];
            }
            $problem = riffi_check_staff($m[$k]);
            if ($problem !== null) {
                return [null, 'Measure ' . ($m['n'] ?? $i) . ", $k: $problem."];
            }
            $notes += preg_match_all('/[A-G](?:##|#|bb|b|n)?\d/', $m[$k]);
        }
    }
    if ($notes === 0) {
        return [null, 'There are no notes.'];
    }
    $warnings = [];
    foreach ((array) ($score['warnings'] ?? []) as $w) {
        if (is_string($w) && trim($w) !== '' && count($warnings) < 5) {
            $warnings[] = mb_substr(trim(strip_tags($w)), 0, 200);
        }
    }
    $score['warnings'] = $warnings;
    return [$score, null];
}

// ---------------------------------------------------------------------------
// Streaming reply to the app (keeps Cloudflare and the host from timing out)

final class RiffiOut
{
    private bool $started = false;
    private float $lastSend = 0;

    public function start(): void
    {
        if ($this->started) {
            return;
        }
        $this->started = true;
        @ini_set('zlib.output_compression', '0');
        @ini_set('output_buffering', '0');
        @ini_set('implicit_flush', '1');
        if (function_exists('apache_setenv')) {
            @apache_setenv('no-gzip', '1');
        }
        while (ob_get_level() > 0) {
            @ob_end_clean();
        }
        http_response_code(200);
        header('Content-Type: application/x-ndjson; charset=utf-8');
        header('Cache-Control: no-store, no-transform');
        header('X-Accel-Buffering: no');
        // Some proxies hold the first few KB; padding pushes the stream through.
        $this->send(['type' => 'start', 'ref' => RiffiLog::$ref, 'pad' => str_repeat(' ', 2048)]);
    }

    public function started(): bool
    {
        return $this->started;
    }

    public function send(array $msg): void
    {
        echo json_encode($msg, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
        @flush();
        $this->lastSend = microtime(true);
    }

    /** Keep-alive, at most every few seconds. */
    public function ping(): void
    {
        if ($this->started && microtime(true) - $this->lastSend >= 4) {
            $this->send(['type' => 'ping']);
        }
    }
}

/**
 * One AI call's deadline and progress. Providers call tick() as data arrives
 * (and while waiting) and text() with everything received so far.
 */
final class RiffiCall
{
    private int $bars = -1;

    public function __construct(public readonly float $deadline, private readonly ?RiffiOut $out)
    {
    }

    public function remaining(): float
    {
        return $this->deadline - microtime(true);
    }

    /** Return false to abort (deadline passed). */
    public function tick(): bool
    {
        $this->out?->ping();
        return $this->remaining() > 0;
    }

    public function text(string $soFar): void
    {
        $bars = preg_match_all('/"n"\s*:/', $soFar);
        if ($bars !== $this->bars && $this->out) {
            $this->bars = $bars;
            $this->out->send(['type' => 'progress', 'bars' => $bars]);
        }
    }
}

// ---------------------------------------------------------------------------
// Providers

interface RiffiProvider
{
    /** @return array{0: string, 1: string} [text, stop] where stop is 'end', 'max_tokens' or 'refusal'. */
    public function generate(string $system, array $turns, RiffiCall $call): array;

    /** Short model name for logs and the self-check. */
    public function model(): string;

    /** Self-check: is the model there? [ok, http status, message]. */
    public function checkModel(): array;

    /** Self-check: one tiny request. [ok, http status, message]. */
    public function checkGenerate(): array;
}

/** Turn a provider's HTTP failure into a clear error code (and log the detail). */
function riffi_provider_error(string $provider, int $status, string $body): RiffiHttpError
{
    $msg = '';
    $data = json_decode($body, true);
    if (is_array($data)) {
        $err = $data['error'] ?? ($data[0]['error'] ?? null);
        $msg = is_array($err) ? (string) ($err['message'] ?? '') . ' ' . (string) ($err['status'] ?? ($err['type'] ?? '')) : '';
    }
    if ($msg === '') {
        $msg = substr(trim(strip_tags($body)), 0, 300);
    }
    $msg = RiffiLog::scrub(trim($msg));
    RiffiLog::write('provider_http_error', ['provider' => $provider, 'status' => $status, 'message' => substr($msg, 0, 500)]);
    $lower = strtolower($msg);
    if ($status === 429 || $status === 503 || $status === 529 || str_contains($lower, 'resource_exhausted') || str_contains($lower, 'overloaded')) {
        header('Retry-After: 60');
        return new RiffiHttpError(503, 'busy', "Riffi's music reader is busy, try again in a minute.", $msg);
    }
    if ($status === 404 || str_contains($lower, 'not found') && str_contains($lower, 'model')) {
        return new RiffiHttpError(502, 'model_not_found', 'The music reader model name is wrong.', $msg);
    }
    if ($status === 401 || $status === 403 || str_contains($lower, 'api key') || str_contains($lower, 'api_key') || str_contains($lower, 'authentication')) {
        return new RiffiHttpError(502, 'bad_key', 'The music reader key was not accepted.', $msg);
    }
    if (str_contains($lower, 'location is not supported') || str_contains($lower, 'failed_precondition')) {
        return new RiffiHttpError(502, 'region', "The music reader isn't available from this server's location.", $msg);
    }
    if ($status >= 400 && $status < 500) {
        return new RiffiHttpError(502, 'provider_rejected', 'The music reader refused the request.', $msg);
    }
    return new RiffiHttpError(502, 'provider_error', 'The music reader had a problem.', $msg);
}

/** Turn a cURL failure into a clear error code. */
function riffi_curl_error(string $provider, int $errno, string $error, RiffiCall $call): RiffiHttpError
{
    RiffiLog::write('curl_error', ['provider' => $provider, 'errno' => $errno, 'error' => RiffiLog::scrub($error), 'remaining_s' => round($call->remaining(), 1)]);
    if ($errno === 28 || $errno === 42 || $call->remaining() <= 0) {
        return new RiffiHttpError(504, 'timeout', 'Reading that page took too long.', $error);
    }
    if (in_array($errno, [5, 6, 7], true)) {
        return new RiffiHttpError(502, 'blocked', "This server couldn't reach the music reader (it may block outgoing connections).", $error);
    }
    if (in_array($errno, [35, 51, 53, 58, 60, 77, 83], true)) {
        return new RiffiHttpError(502, 'blocked', "This server couldn't make a secure connection to the music reader.", $error);
    }
    return new RiffiHttpError(502, 'provider_error', 'The connection to the music reader failed.', $error);
}

/**
 * POST JSON and read a server-sent-event stream, calling $onData for each
 * event's data. Honours the call's deadline. Returns [status, errorBody].
 */
function riffi_post_sse(string $provider, string $url, array $headers, array $body, RiffiCall $call, callable $onData): array
{
    $buffer = '';
    $errorBody = '';
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => array_merge(['content-type: application/json', 'accept: text/event-stream'], $headers),
        CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_SLASHES),
        CURLOPT_CONNECTTIMEOUT => 15,
        CURLOPT_TIMEOUT => max(5, (int) ceil($call->remaining())),
        CURLOPT_NOPROGRESS => false,
        CURLOPT_XFERINFOFUNCTION => static fn () => $call->tick() ? 0 : 1,
        CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk) use (&$buffer, &$errorBody, $onData): int {
            if ((int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE) >= 300) {
                $errorBody .= $chunk;
                return strlen($chunk);
            }
            $buffer .= str_replace("\r\n", "\n", $chunk);
            while (($pos = strpos($buffer, "\n\n")) !== false) {
                $event = substr($buffer, 0, $pos);
                $buffer = substr($buffer, $pos + 2);
                $data = '';
                foreach (explode("\n", $event) as $line) {
                    if (str_starts_with($line, 'data:')) {
                        $data .= ltrim(substr($line, 5));
                    }
                }
                if ($data !== '' && $data !== '[DONE]') {
                    $json = json_decode($data, true);
                    if (is_array($json)) {
                        $onData($json);
                    }
                }
            }
            return strlen($chunk);
        },
    ]);
    $ok = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $errno = curl_errno($ch);
    $error = curl_error($ch);
    curl_close($ch);
    if ($ok === false && $status < 300) {
        throw riffi_curl_error($provider, $errno, $error, $call);
    }
    // A redirect or any other non-2xx is a failure too (never an "empty" reply).
    if ($status >= 300 && $status < 400) {
        return [502, $errorBody !== '' ? $errorBody : "Unexpected redirect ($status)"];
    }
    return [$status, $errorBody];
}

/** Plain GET/POST JSON for the self-check. Returns [status, body, ms, curlError]. */
function riffi_http(string $method, string $url, array $headers, ?array $body = null, int $timeout = 20): array
{
    $t0 = microtime(true);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => array_merge(['content-type: application/json'], $headers),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_SLASHES));
    }
    $res = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = $res === false ? curl_error($ch) : '';
    curl_close($ch);
    return [$status, is_string($res) ? $res : '', (int) round((microtime(true) - $t0) * 1000), $err];
}

/** Google Gemini (streamGenerateContent), e.g. the free tier from Google AI Studio. */
final class RiffiGemini implements RiffiProvider
{
    private bool $thinking = true;

    public function __construct(private readonly array $cfg)
    {
    }

    public function model(): string
    {
        return (string) $this->cfg['GEMINI_MODEL'];
    }

    private function base(): string
    {
        return rtrim((string) $this->cfg['GEMINI_API_URL'], '/') . '/models/' . rawurlencode($this->model());
    }

    private function keyHeader(): array
    {
        return ['x-goog-api-key: ' . $this->cfg['GEMINI_API_KEY']];
    }

    /** Gemini 2.5 takes a token budget; Gemini 3 and later take a level. */
    public static function thinkingConfig(string $model, string $level): ?array
    {
        if ($level === '') {
            return null;
        }
        if (str_contains($model, '2.5') || str_contains($model, '2.0')) {
            return ['thinkingBudget' => ['low' => 512, 'medium' => 2048, 'high' => 8192][$level] ?? 512];
        }
        return ['thinkingLevel' => $level];
    }

    /** Build the request body. Pure, for tests. */
    public static function body(string $system, array $turns, int $maxTokens, ?array $thinking = null): array
    {
        $contents = [];
        foreach ($turns as $turn) {
            $parts = [];
            foreach ($turn['parts'] as $p) {
                if (isset($p['image'])) {
                    $parts[] = ['inline_data' => ['mime_type' => $p['image'][0], 'data' => $p['image'][1]]];
                } else {
                    $parts[] = ['text' => (string) $p['text']];
                }
            }
            $contents[] = ['role' => $turn['role'] === 'assistant' ? 'model' : 'user', 'parts' => $parts];
        }
        $config = ['maxOutputTokens' => $maxTokens, 'responseMimeType' => 'application/json', 'temperature' => 0.2];
        if ($thinking) {
            $config['thinkingConfig'] = $thinking;
        }
        return [
            'system_instruction' => ['parts' => [['text' => $system]]],
            'contents' => $contents,
            'generationConfig' => $config,
        ];
    }

    /** Fold one streamed chunk into [text, finishReason, blocked]. Pure, for tests. */
    public static function absorb(array $chunk, string $text, string $finish, bool $blocked): array
    {
        if (!empty($chunk['promptFeedback']['blockReason'])) {
            $blocked = true;
        }
        $cand = $chunk['candidates'][0] ?? null;
        if (is_array($cand)) {
            foreach ($cand['content']['parts'] ?? [] as $part) {
                if (empty($part['thought'])) {
                    $text .= (string) ($part['text'] ?? '');
                }
            }
            if (!empty($cand['finishReason'])) {
                $finish = (string) $cand['finishReason'];
            }
        }
        return [$text, $finish, $blocked];
    }

    public static function stopFor(string $finish, bool $blocked): string
    {
        if ($blocked) {
            return 'refusal';
        }
        return match ($finish) {
            'STOP', '', 'FINISH_REASON_UNSPECIFIED' => 'end',
            'MAX_TOKENS' => 'max_tokens',
            default => 'refusal', // SAFETY, RECITATION, PROHIBITED_CONTENT, BLOCKLIST, SPII, IMAGE_SAFETY, OTHER…
        };
    }

    public function generate(string $system, array $turns, RiffiCall $call): array
    {
        $thinking = $this->thinking ? self::thinkingConfig($this->model(), (string) $this->cfg['GEMINI_THINKING']) : null;
        $text = '';
        $finish = '';
        $blocked = false;
        [$status, $err] = riffi_post_sse(
            'gemini',
            $this->base() . ':streamGenerateContent?alt=sse',
            $this->keyHeader(),
            self::body($system, $turns, (int) $this->cfg['GEMINI_MAX_TOKENS'], $thinking),
            $call,
            function (array $chunk) use (&$text, &$finish, &$blocked, $call) {
                [$text, $finish, $blocked] = self::absorb($chunk, $text, $finish, $blocked);
                $call->text($text);
            },
        );
        if ($status === 400 && $thinking && stripos($err, 'thinking') !== false) {
            // This model doesn't take that thinking setting: try once without it.
            RiffiLog::write('gemini_thinking_unsupported', ['model' => $this->model()]);
            $this->thinking = false;
            return $this->generate($system, $turns, $call);
        }
        if ($status >= 300) {
            throw riffi_provider_error('gemini', $status, $err);
        }
        return [$text, self::stopFor($finish, $blocked)];
    }

    public function checkModel(): array
    {
        [$status, $body, , $err] = riffi_http('GET', $this->base(), $this->keyHeader());
        if ($err !== '') {
            return [false, 0, $err];
        }
        $data = json_decode($body, true);
        if ($status === 200) {
            return [true, 200, trim(($data['displayName'] ?? '') . ' ' . ($data['version'] ?? ''))];
        }
        return [false, $status, RiffiLog::scrub((string) ($data['error']['message'] ?? substr($body, 0, 200)))];
    }

    public function checkGenerate(): array
    {
        $thinking = self::thinkingConfig($this->model(), (string) $this->cfg['GEMINI_THINKING']);
        $body = self::body('Reply in JSON.', [['role' => 'user', 'parts' => [['text' => 'Reply with {"ok": true}.']]]], 256, $thinking);
        [$status, $res, $ms, $err] = riffi_http('POST', $this->base() . ':generateContent', $this->keyHeader(), $body);
        if ($status === 400 && $thinking && stripos($res, 'thinking') !== false) {
            [$status, $res, $ms, $err] = riffi_http('POST', $this->base() . ':generateContent', $this->keyHeader(), self::body('Reply in JSON.', [['role' => 'user', 'parts' => [['text' => 'Reply with {"ok": true}.']]]], 256));
        }
        if ($err !== '') {
            return [false, 0, $err];
        }
        $data = json_decode($res, true);
        return $status === 200 ? [true, 200, "{$ms} ms"] : [false, $status, RiffiLog::scrub((string) ($data['error']['message'] ?? substr($res, 0, 200)))];
    }
}

/** Anthropic Claude (Messages API, streamed). */
final class RiffiClaude implements RiffiProvider
{
    public function __construct(private readonly array $cfg)
    {
    }

    public function model(): string
    {
        return (string) $this->cfg['CLAUDE_MODEL'];
    }

    private function headers(): array
    {
        return ['x-api-key: ' . $this->cfg['ANTHROPIC_API_KEY'], 'anthropic-version: ' . RIFFI_ANTHROPIC_VERSION];
    }

    /** Build the request body (minus streaming/fallback extras). Pure, for tests. */
    public static function body(string $system, array $turns, string $model, int $maxTokens, string $effort): array
    {
        $messages = [];
        foreach ($turns as $turn) {
            $content = [];
            foreach ($turn['parts'] as $p) {
                if (isset($p['image'])) {
                    $content[] = ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => $p['image'][0], 'data' => $p['image'][1]]];
                } else {
                    $content[] = ['type' => 'text', 'text' => (string) $p['text']];
                }
            }
            $messages[] = ['role' => $turn['role'] === 'assistant' ? 'assistant' : 'user', 'content' => $content];
        }
        $body = ['model' => $model, 'max_tokens' => $maxTokens, 'system' => $system, 'messages' => $messages];
        if ($effort !== '') {
            $body['output_config'] = ['effort' => $effort];
        }
        return $body;
    }

    public function generate(string $system, array $turns, RiffiCall $call): array
    {
        $model = $this->model();
        $body = self::body($system, $turns, $model, (int) $this->cfg['MAX_TOKENS'], (string) $this->cfg['EFFORT']);
        $body['stream'] = true;
        $headers = $this->headers();
        if (!empty($this->cfg['USE_FALLBACKS']) && in_array($model, RIFFI_FALLBACK_MODELS, true)) {
            // If the model declines, the API retries on a suitable fallback model in the same call.
            $body['fallbacks'] = 'default';
            $headers[] = 'anthropic-beta: server-side-fallback-2026-07-01';
        }
        $text = '';
        $stop = null;
        $streamError = null;
        [$status, $err] = riffi_post_sse('claude', (string) $this->cfg['CLAUDE_API_URL'], $headers, $body, $call, function (array $ev) use (&$text, &$stop, &$streamError, $call) {
            $type = $ev['type'] ?? '';
            if ($type === 'content_block_delta' && ($ev['delta']['type'] ?? '') === 'text_delta') {
                $text .= (string) $ev['delta']['text'];
                $call->text($text);
            } elseif ($type === 'message_delta' && isset($ev['delta']['stop_reason'])) {
                $stop = (string) $ev['delta']['stop_reason'];
            } elseif ($type === 'error') {
                $streamError = (string) ($ev['error']['type'] ?? 'error');
            }
        });
        if ($status >= 300) {
            throw riffi_provider_error('claude', $status, $err);
        }
        if ($streamError === 'overloaded_error' || $streamError === 'rate_limit_error') {
            throw riffi_provider_error('claude', 529, '{"error":{"message":"' . $streamError . '"}}');
        }
        if ($streamError !== null) {
            throw riffi_provider_error('claude', 500, '{"error":{"message":"' . $streamError . '"}}');
        }
        return [$text, match ($stop) {
            'max_tokens' => 'max_tokens',
            'refusal' => 'refusal',
            default => 'end',
        }];
    }

    private function modelsUrl(): string
    {
        return preg_replace('#/messages$#', '/models/', (string) $this->cfg['CLAUDE_API_URL']) . rawurlencode($this->model());
    }

    public function checkModel(): array
    {
        [$status, $body, , $err] = riffi_http('GET', $this->modelsUrl(), $this->headers());
        if ($err !== '') {
            return [false, 0, $err];
        }
        $data = json_decode($body, true);
        return $status === 200 ? [true, 200, (string) ($data['display_name'] ?? $this->model())] : [false, $status, (string) ($data['error']['message'] ?? substr($body, 0, 200))];
    }

    public function checkGenerate(): array
    {
        $body = self::body('Reply in JSON.', [['role' => 'user', 'parts' => [['text' => 'Reply with {"ok": true}.']]]], $this->model(), 64, 'low');
        [$status, $res, $ms, $err] = riffi_http('POST', (string) $this->cfg['CLAUDE_API_URL'], $this->headers(), $body);
        if ($err !== '') {
            return [false, 0, $err];
        }
        $data = json_decode($res, true);
        return $status === 200 ? [true, 200, "{$ms} ms"] : [false, $status, (string) ($data['error']['message'] ?? substr($res, 0, 200))];
    }
}

/** Pick the provider from config ('gemini' by default) and check it has a key. */
function riffi_provider(array $cfg): RiffiProvider
{
    $name = strtolower((string) $cfg['PROVIDER']);
    if ($name === 'claude') {
        if (empty($cfg['ANTHROPIC_API_KEY'])) {
            throw new RiffiHttpError(500, 'not_configured', 'The music reader is not set up yet (no ANTHROPIC_API_KEY).');
        }
        return new RiffiClaude($cfg);
    }
    if ($name === 'gemini') {
        if (empty($cfg['GEMINI_API_KEY'])) {
            throw new RiffiHttpError(500, 'not_configured', 'The music reader is not set up yet (no GEMINI_API_KEY).');
        }
        return new RiffiGemini($cfg);
    }
    throw new RiffiHttpError(500, 'not_configured', 'Unknown PROVIDER in config.');
}

// ---------------------------------------------------------------------------
// Reading a page

/** Ask the provider, validate, retry once with the problem if there's time. Returns the score. */
function riffi_read(RiffiProvider $provider, array $turns, RiffiCall $call): array
{
    $system = riffi_system_prompt();
    for ($attempt = 1; ; $attempt++) {
        $t0 = microtime(true);
        [$text, $stop] = $provider->generate($system, $turns, $call);
        RiffiLog::write('provider_reply', ['attempt' => $attempt, 'chars' => strlen($text), 'stop' => $stop, 'seconds' => round(microtime(true) - $t0, 1)]);
        if ($stop === 'refusal') {
            throw new RiffiHttpError(422, 'unreadable', "That photo couldn't be read as music.");
        }
        [$score, $problem] = riffi_validate_score($text);
        if ($problem === null && $stop === 'max_tokens') {
            $problem = 'The reply was cut off before the end.';
        }
        if ($problem === null) {
            return $score;
        }
        RiffiLog::write('invalid_reply', ['attempt' => $attempt, 'problem' => $problem, 'start' => substr($text, 0, 200)]);
        if ($attempt >= 2 || $call->remaining() < 25) {
            throw new RiffiHttpError(422, 'unreadable', 'We could not read music from that photo.', $problem);
        }
        $turns[] = ['role' => 'assistant', 'parts' => [['text' => $text !== '' ? $text : '(no output)']]];
        $turns[] = ['role' => 'user', 'parts' => [['text' => 'That reply could not be used: ' . $problem . ' Please send the complete, corrected Riffi Notation JSON only.']]];
    }
}

function riffi_handle_scan(array $cfg): void
{
    $out = new RiffiOut();
    $started = microtime(true);
    $provider = riffi_provider($cfg);
    $instrument = (string) ($_POST['instrument'] ?? 'violin');
    if (!in_array($instrument, RIFFI_INSTRUMENTS, true)) {
        throw new RiffiHttpError(400, 'instrument', 'Unknown instrument.');
    }
    $page = max(1, (int) ($_POST['page'] ?? 1));
    $of = max($page, (int) ($_POST['pages'] ?? 1));
    $pages = riffi_read_pages($cfg);
    riffi_rate_limit($cfg);
    $timeLimitSet = @set_time_limit((int) $cfg['REQUEST_SECONDS'] + 30);
    RiffiLog::write('scan_start', riffi_limits() + [
        'provider' => strtolower((string) $cfg['PROVIDER']),
        'model' => $provider->model(),
        'page' => "$page/$of",
        'bytes' => array_sum(array_map(fn ($p) => (int) (strlen($p[1]) * 3 / 4), $pages)),
        'set_time_limit' => $timeLimitSet,
    ]);

    // From here on, reply as a stream so the connection never sits silent.
    $out->start();
    $call = new RiffiCall($started + (float) $cfg['REQUEST_SECONDS'], $out);
    try {
        $score = riffi_read($provider, [['role' => 'user', 'parts' => riffi_user_parts($pages, $instrument, $page, $of)]], $call);
        $warnings = $score['warnings'] ?? [];
        unset($score['warnings']);
        RiffiLog::write('scan_ok', ['seconds' => round(microtime(true) - $started, 1), 'bars' => count($score['measures'])]);
        $out->send(['type' => 'result', 'score' => $score, 'warnings' => $warnings, 'ref' => RiffiLog::$ref]);
    } catch (RiffiHttpError $e) {
        RiffiLog::write('scan_failed', ['code' => $e->errorCode, 'detail' => RiffiLog::scrub(substr($e->detail, 0, 500)), 'seconds' => round(microtime(true) - $started, 1)]);
        $out->send(['type' => 'error', 'code' => $e->errorCode, 'message' => $e->getMessage(), 'ref' => RiffiLog::$ref]);
    } catch (Throwable $e) {
        RiffiLog::write('crash', ['error' => RiffiLog::scrub($e->getMessage()), 'line' => $e->getLine()]);
        $out->send(['type' => 'error', 'code' => 'server', 'message' => 'Something went wrong.', 'ref' => RiffiLog::$ref]);
    }
}

// ---------------------------------------------------------------------------
// Self-check (GET ?check=1)

function riffi_handle_check(array $cfg): void
{
    if (empty($cfg['DIAGNOSTICS'])) {
        throw new RiffiHttpError(404, 'off', 'The self-check is switched off.');
    }
    riffi_rate_limit($cfg);
    $out = new RiffiOut();
    $out->start();
    // Two timed pings let the app see whether replies stream or arrive all at once.
    usleep(600_000);
    $out->send(['type' => 'ping', 'n' => 1]);
    usleep(1_000_000);
    $out->send(['type' => 'ping', 'n' => 2]);

    $report = riffi_limits() + [
        'ref' => RiffiLog::$ref,
        'time_limit_settable' => @set_time_limit(120),
        'upload_max_filesize' => ini_get('upload_max_filesize'),
        'post_max_size' => ini_get('post_max_size'),
        'curl' => function_exists('curl_init') ? (curl_version()['version'] ?? 'yes') : false,
        'tls' => function_exists('curl_version') ? (curl_version()['ssl_version'] ?? '') : '',
        'config' => $GLOBALS['riffi_config_source'],
        'provider' => strtolower((string) $cfg['PROVIDER']),
        'request_seconds' => (int) $cfg['REQUEST_SECONDS'],
        'log' => RiffiLog::where(),
    ];
    try {
        $provider = riffi_provider($cfg);
        $report['model'] = $provider->model();
        $report['key_set'] = true;
        [$ok, $status, $msg] = $provider->checkModel();
        $report['model_check'] = ['ok' => $ok, 'status' => $status, 'message' => $msg];
        if ($ok) {
            [$ok2, $status2, $msg2] = $provider->checkGenerate();
            $report['test_request'] = ['ok' => $ok2, 'status' => $status2, 'message' => $msg2];
        }
    } catch (RiffiHttpError $e) {
        $report['key_set'] = false;
        $report['model_check'] = ['ok' => false, 'status' => 0, 'message' => $e->getMessage()];
    }
    RiffiLog::write('self_check', $report);
    $out->send(['type' => 'result', 'report' => $report, 'ref' => RiffiLog::$ref]);
}

// ---------------------------------------------------------------------------

function riffi_main(): void
{
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store');
    header('Referrer-Policy: no-referrer');
    $cfg = null;
    try {
        $cfg = riffi_load_config();
        RiffiLog::init($cfg);
        riffi_cors($cfg);
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        if ($method === 'OPTIONS') {
            http_response_code(204);
            exit;
        }
        if ($method === 'GET' && isset($_GET['check'])) {
            riffi_handle_check($cfg);
            return;
        }
        if ($method !== 'POST') {
            header('Allow: POST, OPTIONS');
            throw new RiffiHttpError(405, 'method', 'Use POST.');
        }
        riffi_handle_scan($cfg);
    } catch (RiffiHttpError $e) {
        if ($cfg !== null) {
            RiffiLog::write('request_refused', ['status' => $e->status, 'code' => $e->errorCode]);
        }
        riffi_json($e->status, ['error' => $e->getMessage(), 'code' => $e->errorCode, 'ref' => RiffiLog::$ref]);
    } catch (Throwable $e) {
        if ($cfg !== null) {
            RiffiLog::write('crash', ['error' => RiffiLog::scrub($e->getMessage()), 'line' => $e->getLine()]);
        }
        riffi_json(500, ['error' => 'Something went wrong.', 'code' => 'server', 'ref' => RiffiLog::$ref]);
    }
}

if (PHP_SAPI !== 'cli' || getenv('RIFFI_RUN') === '1') {
    riffi_main();
}
