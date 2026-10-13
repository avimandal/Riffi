<?php
/**
 * Riffi sheet-reading settings.
 *
 * Copy this file and fill in your key(s). Best place (if your host allows it):
 * one folder ABOVE the web root, named riffi-config.php, e.g.
 *   /home/you/riffi-config.php   (web root: /home/you/public_html/riffi)
 * Otherwise save it as api/config.php next to omr.php; api/.htaccess blocks
 * it from the web. Never commit the real file.
 *
 * The deploy workflow never uploads, overwrites or deletes api/config.php.
 */
return [
    // Which AI reads the music: 'gemini' (default, free tier from Google AI Studio) or 'claude'.
    'PROVIDER' => 'gemini',

    // Google Gemini: get a key at https://aistudio.google.com/ (keep it secret).
    // Free-tier note: Google may use what's sent on the free tier to improve its models.
    'GEMINI_API_KEY' => '',
    // 'gemini-flash-latest' is Google's alias for the current Flash model. Pin an exact
    // model ID here if you'd rather not move to new Flash versions automatically.
    'GEMINI_MODEL' => 'gemini-flash-latest',

    // Anthropic Claude (used when PROVIDER is 'claude'): https://console.anthropic.com/
    'ANTHROPIC_API_KEY' => '',
    'CLAUDE_MODEL' => 'claude-sonnet-5-5',

    // Upload limits (the app already shrinks photos to ≤2000 px JPEGs, ~0.5–1 MB each).
    'MAX_PAGES' => 8,
    'MAX_BYTES_PER_PAGE' => 3 * 1024 * 1024,

    // The app's origin (scheme + host, no trailing slash). Browser calls from anywhere else are refused.
    'ALLOWED_ORIGIN' => 'https://riffi.avimandal.com',

    // Abuse protection: requests per IP per hour (a page is about 3–4 requests, or ~20 at
    // one line per request).
    'RATE_LIMIT_PER_HOUR' => 400,
    // Requests per minute to the AI, shared by everyone using this server. Keep it under
    // your provider's limit (Gemini's free tier allows roughly 10 a minute for Flash; check
    // yours in Google AI Studio → Usage). The app waits its turn instead of failing.
    'GEMINI_RPM' => 8,
    'CLAUDE_RPM' => 40,
    // Where the per-IP counters live. null = the system temp folder. Must not be web-accessible.
    'RATE_LIMIT_DIR' => null,
    // Set true behind Cloudflare or another proxy, so the limit uses the visitor's IP
    // (CF-Connecting-IP / X-Forwarded-For) instead of the proxy's.
    'TRUST_PROXY' => false,

    // Deadline for each request (a page overview, or a few lines), in seconds. Keep it well
    // under Cloudflare's 100-second limit. A line that runs out is read again on its own,
    // and the rest of the page is always kept.
    'REQUEST_SECONDS' => 60,
    // Requests the app sends at once (still within GEMINI_RPM / CLAUDE_RPM). Shared hosts
    // limit PHP processes, so keep this small.
    'PARALLEL_REQUESTS' => 3,

    // Private error log (never contains your API keys). null = a riffi-logs folder next to
    // the web root, e.g. /home/you/riffi-logs/omr.log; set a full path to choose; false = off.
    'LOG_FILE' => null,
    // Settings -> App -> Check music reader. Shows limits and whether the AI answers;
    // never shows keys. Set false to turn the check off.
    'DIAGNOSTICS' => true,

    // Password for Settings -> App -> Music reader -> Change, which switches the music
    // reader (Gemini or Claude) for everyone on the site. Use a long passphrase. The server
    // allows 5 wrong tries per IP per 15 minutes. '' = no Change button; PROVIDER is used.
    'ADMIN_PASSWORD' => '',
    // Where that choice is saved. null = riffi-settings.json next to the private log
    // (outside the web root).
    'SETTINGS_FILE' => null,

    // Double-check rounds per line of music: the AI compares an engraving of what it read
    // with the photo and fixes mismatches. 0 = off (fewest requests), 1 or 2.
    'CHECK_ROUNDS' => 2,

    // Advanced.
    // Lines of music per request (each still its own picture). Fewer lines = shorter
    // requests that never get near the deadline; more = fewer requests. Gemini's free tier
    // allows about 20 requests a day per model: 3 means about 4 requests per page.
    'LINES_PER_REQUEST' => 3,
    // The same for Claude (paid): one line per request is quickest.
    'CLAUDE_LINES_PER_REQUEST' => 1,

    // How hard Gemini "thinks" before answering: 'off', 'minimal', 'low', 'medium', 'high',
    // or '' for the model's default (usually high, slow). Gemini 3 can't switch thinking off,
    // so 'off' means 'minimal' there. 'low' is what the recorded accuracy was measured with;
    // 'medium' can take a minute per request.
    'GEMINI_THINKING' => 'low',
    'GEMINI_THINKING_OVERVIEW' => 'low',
    'GEMINI_MAX_TOKENS' => 65536,
    // Claude only:
    'MAX_TOKENS' => 16384,
    'EFFORT' => 'medium',
    // On a refusal, let the API retry on a fallback model in the same call.
    'USE_FALLBACKS' => true,
];
