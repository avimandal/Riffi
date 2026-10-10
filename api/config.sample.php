<?php
/**
 * Riffi sheet-reading settings.
 *
 * Copy this file and fill in your key. Best place (if your host allows it):
 * one folder ABOVE the web root, named riffi-config.php, e.g.
 *   /home/you/riffi-config.php   (web root: /home/you/public_html/riffi)
 * Otherwise save it as api/config.php next to omr.php; api/.htaccess blocks
 * it from the web. Never commit the real file.
 *
 * The deploy workflow never uploads, overwrites or deletes api/config.php.
 */
return [
    // From https://console.anthropic.com/ (keep it secret).
    'ANTHROPIC_API_KEY' => 'sk-ant-...',

    // Model used to read sheet music.
    'MODEL' => 'claude-sonnet-5-5',

    // Upload limits (the app already shrinks photos to ≤2000 px JPEGs, ~0.5–1 MB each).
    'MAX_PAGES' => 8,
    'MAX_BYTES_PER_PAGE' => 3 * 1024 * 1024,

    // The app's origin (scheme + host, no trailing slash). Browser calls from anywhere else are refused.
    'ALLOWED_ORIGIN' => 'https://riffi.avimandal.com',

    // Abuse protection: scans per IP per hour.
    'RATE_LIMIT_PER_HOUR' => 20,
    // Where the per-IP counters live. null = the system temp folder. Must not be web-accessible.
    'RATE_LIMIT_DIR' => null,
    // Only set true if the site sits behind a proxy/CDN that sets X-Forwarded-For.
    'TRUST_PROXY' => false,

    // Advanced.
    'MAX_TOKENS' => 64000,
    'EFFORT' => 'high',
    // On a refusal, let the API retry on a fallback model in the same call.
    'USE_FALLBACKS' => true,
    'TIMEOUT_SECONDS' => 240,
];
