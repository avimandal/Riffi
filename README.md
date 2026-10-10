# Riffi

A music practice web app for kids. Kids photograph their sheet music, Riffi reads it, then listens through the microphone while they play along to a metronome. It scores each run out of 100, shows what went well and what to try next right on the sheet, and keeps track of practice streaks, minutes and badges.

Instruments: **violin**, **piano** (acoustic, through the mic) and **singing**.

- Installable Progressive Web App. Everything except reading new sheet music works offline.
- Static files plus **one PHP endpoint** (`api/omr.php`). No database.
- Everything a child does stays on the device (IndexedDB). There are no accounts, no analytics and no third-party scripts or fonts.

`SPEC.md` is the build spec. This README covers setup, deployment, tuning and known limits.

---

## Contents

1. [Quick start (development)](#quick-start-development)
2. [Project layout](#project-layout)
3. [Tests](#tests)
4. [Deploying to riffi.avimandal.com](#deploying-to-riffiavimandalcom)
5. [Server setup checklist](#server-setup-checklist)
6. [Tuning notes](#tuning-notes)
7. [How it works](#how-it-works)
8. [Known limits](#known-limits)
9. [Privacy](#privacy)

---

## Quick start (development)

Requirements: Node 22+, npm 10+. For the API: PHP 8.1+ with the `curl`, `dom`, `fileinfo` and `mbstring` extensions.

```bash
npm install          # also copies the Basic Pitch model into public/models/
npm run dev          # http://localhost:5173
```

The microphone needs a secure context. `localhost` counts as secure. To test on a phone or tablet over your network you need HTTPS (for example `npx vite --host` behind a tunnel, or `vite preview` with a certificate).

To try sheet reading locally, run the PHP endpoint with a config file and point the app at it:

```bash
cp api/config.sample.php api/config.php     # add GEMINI_API_KEY (or PROVIDER=claude + ANTHROPIC_API_KEY), set ALLOWED_ORIGIN=http://localhost:5173
php -S 127.0.0.1:8080 -t .                   # serves /api/omr.php
VITE_OMR_ENDPOINT=http://127.0.0.1:8080/api/omr.php npm run dev
```

No API key? Use **Add music → Open a music file** with any `.mxl`, `.musicxml` or `.xml` file (MuseScore's default export is `.mxl`; there are samples in `tests/fixtures/musicxml/`).

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Type-check and build to `dist/` (uses `VITE_BASE_PATH`) |
| `npm run preview` | Serve the production build |
| `npm run typecheck` / `npm run lint` | TypeScript (strict) / ESLint |
| `npm test` | Unit and engine tests (Vitest) |
| `npm run e2e` | Playwright smoke test (builds, serves and drives the app with a fake microphone) |
| `npm run php:lint` | `php -l` on the API |
| `node scripts/build-icons.mjs` | Rebuild the self-hosted icon font subset after adding a new icon |
| `node scripts/render-icons.mjs` | Re-render the PNG app icons from `public/app-icons/favicon.svg` |

### Build-time settings

| Variable | Default | Notes |
|---|---|---|
| `VITE_BASE_PATH` | `/` | Where the app is served from. `/` for a subdomain (what we use), `/practice/` for a subfolder. |
| `VITE_OMR_ENDPOINT` | `<base>api/omr.php` | Only set this if the API lives somewhere else. |

---

## Project layout

```
api/                 omr.php (sheet reading), config.sample.php, .htaccess, .user.ini
public/              .htaccess (SPA fallback, MIME types, cache headers), app-icons, fonts (icon subset), robots.txt
                     models/basic-pitch/ is copied from node_modules on install (not committed)
src/
  app/               App shell, router, state, theme and styles
  screens/           One folder per screen (profiles, home, add, review, practice, results, progress, parent, privacy)
  components/        Buttons, avatar, meter, stars, confetti, sheet view, charts, parent gate…
  audio/             Mic capture (AudioWorklet), metronome scheduler, clicks, latency calibration, DSP
  engines/           mono/ (pitchy) and piano/ (Basic Pitch in a Web Worker), shared NoteEvent type
  sheet/             MusicXML parsing, expected notes, repeats, OSMD wrapper, tap-to-fix editor, OMR client
  follow/            Score follower (online alignment) and learn-mode follower
  scoring/           Pure scoring functions, feedback, and config.ts (all tolerances)
  data/              Dexie schema, repositories, stats/badges, backup
  i18n/              en-AU strings (all copy lives here)
  config.ts          App name and app-wide constants
tests/
  unit/              Vitest: scoring, follower, MusicXML, engines (synthetic audio), data, editor, copy rules
  fixtures/          MusicXML fixtures, synthetic audio generators, NoteEvent streams
  e2e/               Playwright smoke test
  php/               PHP unit tests and integration tests against fake Gemini and Claude APIs
```

---

## Tests

```bash
npm test                     # ~85 unit/engine tests (about 25 s; the piano model runs on the CPU)
npm run e2e                  # Playwright (needs Chromium: npx playwright install chromium)
php tests/php/unit.php       # PHP helpers and both provider adapters
bash tests/php/integration.sh  # PHP endpoint end to end against fake Gemini and Claude APIs
```

What's covered (SPEC §15):

- **Scoring and follower** against synthetic `NoteEvent` streams: perfect run, a skipped note, extra notes, late notes, a player who slows down, octave-off singing, partial piano chords, wrong notes landing on the right bars, issues and positives.
- **Engine fixtures:** generated audio (harmonic tones with vibrato, sung-like glides, repeated notes, piano-like chords, with and without metronome clicks mixed in) is run through the real mono engine and the real Basic Pitch model. The acceptance checks from SPEC §17 that can be automated run here too: a correct performance with vibrato and clicks scores 90+, clicks alone produce no notes, wrong notes are flagged on the right bars, and singing an octave low scores normally.
- **MusicXML:** fixtures with repeats and voltas, ties, two piano staves with chords, key and time changes, and a pickup bar; `.mxl` unzipping.
- **E2E:** create a profile, import a compressed `.mxl` fixture (bypassing OMR), tap-fix a note, practise with a fake microphone stream, see the results saved on Home and My progress. Plus the parent gate and the privacy page.

CI (`.github/workflows/ci.yml`) runs typecheck, lint, unit tests, build, the PHP tests and the Playwright test on every push and pull request.

---

## Deploying to riffi.avimandal.com

Deployment is **manual**: GitHub → **Actions** → **Deploy** → **Run workflow**. The workflow:

1. Runs the full CI workflow first. If anything fails, nothing is uploaded.
2. Builds with `VITE_BASE_PATH=/`.
3. Uploads `dist/` (the app, `.htaccess`, service worker and model files) and `api/` (`omr.php`, `.htaccess`, `.user.ini`, `config.sample.php`) over **FTPS** (explicit TLS on port 21) using [SamKirkland/FTP-Deploy-Action](https://github.com/SamKirkland/FTP-Deploy-Action).

### Repository secrets

Add these in GitHub → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret | What to put in it |
|---|---|
| `FTP_SERVER` | FTP host name, e.g. `ftp.avimandal.com` |
| `FTP_USERNAME` | The FTP account (already scoped to the site root of riffi.avimandal.com) |
| `FTP_PASSWORD` | Its password |
| `FTP_SERVER_DIR` | Folder to upload into, relative to the FTP account's root. Because the account is already scoped to the site root, this is usually `./` (a trailing slash is added if you leave it off). |

### `api/config.php` is never touched

- `config.php` is in `.gitignore`, so it is never in the repository or the build.
- The workflow deletes any stray `config.php` from the upload folder and checks it isn't there.
- `config.php` is also listed in the action's `exclude` patterns.
- The action only ever replaces or removes files that it uploaded itself (it keeps a `.ftp-deploy-sync-state.json` on the server). It has never uploaded `api/config.php`, so it never overwrites or deletes it. `dangerous-clean-slate` is off.

If your host only offers implicit FTPS (port 990), change `protocol: ftps` to `protocol: ftps-legacy` and `port: 21` to `port: 990` in `deploy.yml`.

---

## Server setup checklist

Do this once, before (or right after) the first deploy.

### 1. Create the subdomain

In the hosting control panel (cPanel → Domains, or similar), create `riffi.avimandal.com` with its **own document root** (for example `/home/<you>/riffi.avimandal.com`), separate from WordPress. Riffi never touches WordPress: its `.htaccess` only applies inside its own folder.

### 2. Turn on HTTPS

Issue a certificate for the subdomain (cPanel → SSL/TLS Status → Run AutoSSL, or Let's Encrypt). Then check:

```bash
curl -I https://riffi.avimandal.com/      # expect 200 and a valid certificate
curl -I http://riffi.avimandal.com/       # expect a 301 to https (from public/.htaccess)
```

HTTPS is mandatory: browsers block the microphone and camera on plain HTTP.

### 3. Upload the API config

Copy `api/config.sample.php`, choose the AI provider and fill in its key, and check `ALLOWED_ORIGIN` is `https://riffi.avimandal.com`.

| Key | Default | Notes |
|---|---|---|
| `PROVIDER` | `gemini` | `gemini` (Google Gemini) or `claude` (Anthropic Claude) |
| `GEMINI_API_KEY` | | Free key from [Google AI Studio](https://aistudio.google.com/) → Get API key |
| `GEMINI_MODEL` | `gemini-flash-latest` | Google's alias for its current Flash model, which has a free tier. Pin an exact model ID if you'd rather not move to new Flash versions automatically. |
| `ANTHROPIC_API_KEY` | | Only needed for `PROVIDER => 'claude'` ([console.anthropic.com](https://console.anthropic.com/)) |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | |
| `MAX_PAGES` / `MAX_BYTES_PER_PAGE` | 8 / 3 MB | |
| `RATE_LIMIT_PER_HOUR` | 20 | Scans per IP per hour (Riffi's own limit) |

Both providers get the same prompt, the same validation and the same single retry. If Gemini's free tier runs out of quota (HTTP 429) or either provider is overloaded, kids see "Riffi's music reader is busy, try again in a minute." The free tier has per-minute and per-day request limits, so a busy household may occasionally hit them; switching `PROVIDER` to `claude` (paid) avoids that.

**Privacy on the Gemini free tier:** Google may use what's sent on the free tier (here, the sheet-music photos) to improve its products, and human reviewers may see it. The in-app privacy page says so, and the Add music screen reminds kids to photograph only the music. If you'd rather avoid this, use a paid Gemini API key (billing enabled) or `PROVIDER => 'claude'`, and update the privacy text in `src/i18n/en-AU.ts`.

Where to put the file:

- **Best:** put it **outside the web root**, one level above the subdomain's folder, named `riffi-config.php` (e.g. `/home/<you>/riffi-config.php`). `omr.php` looks there first. (You may need the control panel's File Manager for this, since the FTP account is scoped to the site root.)
- **Otherwise:** upload it as `api/config.php` with FTP. `api/.htaccess` blocks it (and everything except `omr.php`) from the web.

Check it's protected:

```bash
curl -I https://riffi.avimandal.com/api/config.php    # expect 403
curl -s -X POST https://riffi.avimandal.com/api/omr.php   # expect {"error":"No pages were sent.","code":"no_pages"}
```

If you get `"not_configured"`, the config file wasn't found or the key is empty.

### 4. PHP settings

PHP 8.1 or newer with `curl`, `dom`, `fileinfo` and `mbstring`. Upload limits are set in `api/.user.ini` (PHP-FPM hosts) and `api/.htaccess` (mod_php hosts): 4 MB per file, 34 MB per request, 10 files, 600 s execution time. Some hosts ignore these: if reading several pages fails with "too big", raise `upload_max_filesize` / `post_max_size` in the control panel. If long reads time out, raise `max_execution_time` (a few pages can take a minute or two).

The rate limiter writes tiny counter files to the system temp folder by default. If the host's temp folder isn't writable or is shared, set `RATE_LIMIT_DIR` in the config to a private folder outside the web root.

### 5. First run on each device

Open https://riffi.avimandal.com, add a kid, add some music, and press **Start**. The first time, Riffi offers a **10-second sound check**: it measures the room's noise and plays a few clicks to measure the device's audio latency. Do it with the volume up and headphones off. You can redo it any time in **Parents → Settings → Timing check**. Then install it to the home screen (Chrome/Edge/Android: the Install button on Home; iPad/iPhone: Share → Add to Home Screen).

### 6. Cloudflare

The site is proxied through Cloudflare. `public/.htaccess` sends:

| Files | `Cache-Control` |
|---|---|
| `index.html`, every app route (`/home`, `/practice/…`), `sw.js`, `manifest.webmanifest` | `no-cache, no-store, must-revalidate, max-age=0`, plus `CDN-Cache-Control: no-store` |
| Hashed build files (`assets/*-<hash>.js/.css`, `workbox-<hash>.js`) | `public, max-age=31536000, immutable` |
| Icons, icon font, piano model (same names across releases) | `public, max-age=3600, must-revalidate` |
| `api/omr.php` | `no-store` |

(Verified against a local Apache 2.4 with `mod_rewrite` and `mod_headers`.)

**Do I need to purge Cloudflare after deploying? Normally, no.** Cloudflare doesn't cache HTML by default, and it honours `no-store` for `sw.js` and the manifest. Each deploy changes `index.html` and `sw.js`, and those point to new hashed file names that Cloudflare has never seen. So the next visit fetches the new shell, the service worker spots the change, and the app shows "A new version of Riffi is ready" (it never reloads by itself mid-practice).

Check these Cloudflare settings once, or a purge *would* be needed after every deploy:

- **Caching → Configuration → Browser Cache TTL:** set to **Respect Existing Headers**.
- **No "Cache Everything" Cache Rule (or Page Rule)** matching the whole site. If you want one, add a bypass for `/`, `/index.html`, `/sw.js` and `/manifest.webmanifest`, or set its Edge TTL to "Use cache-control header if present".
- **Speed → Optimization:** turn off **Rocket Loader** (it rewrites scripts and can break the service worker and audio worklet). Auto Minify is retired; if your plan still shows it, leave JavaScript minification off.

After the first deploy, check with `curl -sI https://riffi.avimandal.com/sw.js | grep -i -E "cache-control|cf-cache-status"`. You want `no-store` and `cf-cache-status: DYNAMIC` or `BYPASS`, not `HIT`. If you ever see a stale app, **Caching → Configuration → Purge Everything** fixes it immediately, and is harmless.

The app icons live in `app-icons/` rather than `icons/` because many Apache servers alias `/icons/` to Apache's own folder.

---

## Tuning notes

Expect to tune after testing with real kids and instruments. Each kind of setting lives in one place.

### Scoring: `src/scoring/config.ts`

Every scoring and alignment tolerance is in one `SCORING` object.

| Setting | Default | Effect |
|---|---|---|
| `pitchToleranceCents` | violin 40/30/20, voice 60/50/35 (Easy/Normal/Tricky), piano exact | "Correct" pitch window |
| `closeMultiplier`, `closeMaxCents` | 2×, 90 c | How far "close" (half credit, amber) reaches |
| `octaveEquivalent` | voice only | Singing an octave or two away still counts |
| `timing.goodQuarters` / `okQuarters` | 0.25 (a 16th) / 0.5 (an 8th) | Timing windows |
| `timing.goodFloorMs` / `okFloorMs` | 70 / 140 ms | Windows never get tighter than this at fast tempos (phone audio jitters by 30–60 ms) |
| `timing.pianoScale` | 1.5 | Piano timing windows are wider (Basic Pitch onsets are less precise) |
| `timingCredit` | good 1, ok 0.6, early/late 0.2 | Rhythm credit per note |
| `length.minHeldFraction` | 0.6 | Violin/voice: notes must last 60% of their written length |
| `rhythmMix` | 0.8 timing + 0.2 length | How rhythm credit is built for violin/voice |
| `weights` | 60 pitch, 30 rhythm, 10 completion | Score out of 100 |
| `stars` | 50 / 75 / 90 | Star thresholds |
| `pianoDense` | >6 notes/s, missed weight 0.5 | Dense piano passages are scored more leniently |
| `feedback.rushedMs` | 90 ms | Mean early/late in a bar before it's called rushed/behind |
| `feedback.fixTempoFactor` | 0.75 | "Fix it" loops run at 75% speed |
| `follow.*` | | Score follower costs (insert/skip/pitch/time weights, window size) |

If a correct performance scores below 90, look at timing first (calibrate latency, widen the floors), then pitch tolerances.

### Listening engines

- **Violin and voice:** `MONO_ENGINE` in `src/engines/mono/monoEngine.ts`. Clarity threshold (0.9), noise gate (room noise × 3), median filter (5 frames), note change (60 cents held for 60 ms), silence gap (50 ms), glide folding, same-pitch re-attack, and the ±35 ms click mask.
- **Piano:** `PIANO_ENGINE` in `src/engines/piano/config.ts`. Basic Pitch thresholds, shortest note, highest accepted note (C7, to keep clicks out), click suppression, live step size and the "can't keep up" budget that switches a device to play-then-score.

### Per-device settings (Parents → Settings)

Latency (measured or set by hand), metronome sound/visual/vibrate and volume, piano listening mode (automatic, live, or play then score), and theme.

---

## How it works

```
Mic → AudioWorklet → listening engine → NoteEvents ─┐
                     (mono | piano worker)          ▼
Photos → api/omr.php → MusicXML → expected notes → score follower → scorer → results + feedback
                                                    ▲                              │
Metronome (Web Audio lookahead scheduler) → click times                           ▼
                                                                     practice log (IndexedDB)
```

- **Sheet reading:** photos are straightened, cropped and shrunk to ≤2000 px JPEGs (q 0.85) in the browser, then sent to `api/omr.php`. The endpoint has one small adapter per AI provider behind the same interface: **Google Gemini** (`generateContent`, the default) or **Anthropic Claude** (Messages API, streamed). Both get the same prompt asking for MusicXML 3.1 partwise only. The result is validated (it must parse and contain notes). If it isn't valid, the endpoint retries once with the parser error, then gives up with a friendly message. Doubtful spots come back as warnings for the review screen. Nothing is stored on the server. With Claude, the request opts in to the API's server-side refusal fallback (`fallbacks: "default"`); set `USE_FALLBACKS` to `false` to turn that off. You can also open MusicXML files directly (`.mxl` zipped files are unpacked in the browser).
- **Review:** the music is drawn with OpenSheetMusicDisplay next to the photo thumbnails. Tap a note (or use the arrow keys) to move it up or down, change its length, turn it into a rest, delete it, or add a note or rest after it. You can also change the key, time signature and title. "Looks good!" saves it.
- **Metronome:** clicks are scheduled on the audio clock with a lookahead (the timer only wakes the scheduler). There's a one-bar count-in, an accent on beat 1, a short high woodblock click (mostly above 4 kHz), and a big bouncing dot that always shows.
- **Ignoring the metronome**, in layers: exact click times are known, so analysis frames within ±35 ms of a click can't start or end notes; the mono engine band-limits to 60 Hz–3.5 kHz and drops pitches outside the instrument's range; the mic uses echo cancellation but no noise suppression or auto gain; and the app suggests headphones.
- **Mono engine:** `pitchy` (McLeod) with a 2048 window and 256 hop, clarity ≥ 0.9, a calibrated noise gate, and a 5-frame median. Notes are segmented by pitch, not volume, and each note's pitch is the median over its body, so vibrato isn't a mistake.
- **Piano engine:** Spotify's Basic Pitch model in a Web Worker, loaded only when piano is chosen. A streaming version keeps only the frames inside each 2 s window's context, so live output arrives well under a second behind. If the device can't keep up, it switches to **play then score**: it records in memory, analyses at the end with a progress bar, then deletes the recording.
- **Following:** an online, windowed dynamic-programming alignment over pitch and onset time (both absolute and relative to the previous note, so steady tempo drift is tolerated). A missed note costs a skip and an extra note costs an insertion, so one slip doesn't derail everything after it. Learn mode waits on each note (all notes of a piano chord) until it hears it.
- **Scoring:** 60 × pitch accuracy + 30 × rhythm accuracy + 10 × completion, rounded, plus stars. Feedback picks at most three issues (one per bar, most points lost first), each with a **Fix it** that loops the bars around it at 75% speed, or shows the note and a key-signature hint.

---

## Known limits

- **Photo reading is best on clear, printed, flat, well-lit pages.** The free Gemini tier has daily limits and may be busy at peak times. Handwritten music is unlikely to read well. Always check the notes on the review screen; one wrong note affects every score after it.
- **Acoustic piano detection is the least precise of the three.** Dense or fast passages are scored more leniently, and timing windows are wider. On slower tablets Riffi scores piano after the run (play then score) instead of live.
- **Tolerances will need tuning** after testing with real kids and instruments. That's expected, and it's why scoring config lives in one file.
- Live piano listening runs up to about a second behind, so the piano cursor lags a little; the final score uses the complete recording.
- Tempo is a single BPM per run. Tempo changes written mid-piece are not followed, but they don't break anything.
- With repeats, a note that was played differently on each pass shows its trickiest result on the coloured sheet.
- iPhone/iPad Safari has no vibration, so the "vibrate" metronome option only appears where it's supported (Android).
- Sheet reading is tested against fake Gemini and Claude APIs; it hasn't been run against the real services from CI (no keys there).
- Engine and scoring tests use synthetic audio. Real instruments, rooms and microphones vary, so the real-world acceptance checks in SPEC §17 (a phone's speaker at normal volume, a mid-range tablet with two-hand piano, installing on an iPad) still need doing on real devices.
- Data is stored on one device only. Use **Parents → Backup** to move it. Clearing the browser's site data deletes it.

---

## Privacy

There's a plain-language privacy page in the app (written to suit the Australian Privacy Act). In short: audio never leaves the device and isn't recorded (play-then-score recordings are deleted after analysis); sheet photos go only to the reading endpoint and aren't stored there (on Gemini's free tier Google may use them to improve its models, which the privacy page explains); there are no analytics, ads, trackers or external fonts or scripts at runtime.
