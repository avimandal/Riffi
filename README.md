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
  screens/           One folder per screen (profiles, home, add, review, practice, results, progress, gadget, settings, privacy)
  components/        Buttons, avatar, meter, stars, confetti, sheet view, charts, confirm dialog, piece menu…
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
npm test                     # ~200 unit/engine tests (about 25 s; the piano model runs on the CPU)
npm run e2e                  # Playwright (needs Chromium: npx playwright install chromium)
php tests/php/unit.php       # PHP helpers and both provider adapters
bash tests/php/integration.sh  # PHP endpoint end to end against fake Gemini and Claude APIs

# Sheet-reading accuracy against the real AI (not run in CI; needs a key in the environment only):
GEMINI_API_KEY=… npx playwright test -c playwright.live.config.ts
```

**Sheet-reading accuracy.** Every photo in `tests/fixtures/sheets/` with a hand-made `<name>.reference.json` beside it is a fixture. The live run reads each one with the real pipeline (staff detection and engravings in Chromium, the real `api/omr.php`, the real AI) and prints a per-bar table of pitch and rhythm accuracy plus whether the key, time signature and pickup are right, for the **first read only** and **after the double-check**. It saves every reply (no key, no images) to `tests/fixtures/sheets/recordings/`, and the unit tests replay those recordings through the pipeline in CI, so the numbers can't drift unnoticed. To add a fixture: drop in a photo and write its reference (sounding pitches, as in `hermans-hornpipe.reference.json`), then run the live test. Options: `GEMINI_MODEL`, `GEMINI_RPM` (raise for a paid key), `RIFFI_PROVIDER=claude` with `ANTHROPIC_API_KEY`.

What's covered (SPEC §15):

- **Scoring and follower** against synthetic `NoteEvent` streams: perfect run, a skipped note, extra notes, late notes, a player who slows down, octave-off singing, partial piano chords, wrong notes landing on the right bars, issues and positives.
- **Engine fixtures:** generated audio (harmonic tones with vibrato, sung-like glides, repeated notes, piano-like chords, with and without metronome clicks mixed in) is run through the real mono engine and the real Basic Pitch model. The acceptance checks from SPEC §17 that can be automated run here too: a correct performance with vibrato and clicks scores 90+, clicks alone produce no notes, wrong notes are flagged on the right bars, and singing an octave low scores normally.
- **MusicXML:** fixtures with repeats and voltas, ties, two piano staves with chords, key and time changes, and a pickup bar; `.mxl` unzipping.
- **E2E:** create a profile, import a compressed `.mxl` fixture (bypassing OMR), tap-fix a note, practise with a fake microphone stream, see the results saved on Home and My progress. Plus Settings (no gate, the password-protected music reader choice, "Are you sure?" before deleting), the bottom tabs and player switcher, editing a saved piece against its photo, downloading it as MusicXML and opening it again, and the privacy page.

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
| `FTP_SERVER` | FTP host name, with no `ftp://` and no port. **It must not go through Cloudflare's proxy** (see below): use your host's server name from the control panel (e.g. `serverNN.yourhost.com`), or a DNS record like `ftp.avimandal.com` set to **DNS only** (grey cloud). |
| `FTP_USERNAME` | The FTP account (already scoped to the site root of riffi.avimandal.com) |
| `FTP_PASSWORD` | Its password |
| `FTP_SERVER_DIR` | Folder to upload into, relative to the FTP account's root. Because the account is already scoped to the site root, this is usually `./` (a trailing slash is added if you leave it off). |

### `api/config.php` is never touched

- `config.php` is in `.gitignore`, so it is never in the repository or the build.
- The workflow deletes any stray `config.php` from the upload folder and checks it isn't there.
- `config.php` is also listed in the action's `exclude` patterns.
- The action only ever replaces or removes files that it uploaded itself (it keeps a `.ftp-deploy-sync-state.json` on the server). It has never uploaded `api/config.php`, so it never overwrites or deletes it. `dangerous-clean-slate` is off.

Optional **repository variables** (Settings → Secrets and variables → Actions → **Variables** tab), only if the defaults don't suit your host:

| Variable | Default | When to set it |
|---|---|---|
| `FTP_PROTOCOL` | `ftps` (explicit TLS) | `ftps-legacy` if your host only offers implicit FTPS |
| `FTP_PORT` | `21` (`990` for `ftps-legacy`) | Your host uses a non-standard FTP port |
| `FTP_TLS_SECURITY` | `strict` | `loose` if the server's certificate is for a different name than `FTP_SERVER` (still encrypted, but the name isn't checked) |

### When the upload can't connect

Before uploading, the **Check the FTP connection** step (`scripts/ftp-preflight.sh`) tests DNS, the port, the FTP greeting, TLS, the login and the upload folder. It stops with a plain-English error that names the problem: a Cloudflare-proxied host name, a closed or firewalled port, no FTPS, a bad certificate, a rejected login, or a missing folder. Secrets stay masked in the log (the host name shows as `***`), but the resolved IP addresses, port and FTP reply codes are shown.

**Cloudflare and FTP:** when `riffi.avimandal.com` (or `avimandal.com`) is proxied by Cloudflare (orange cloud), its DNS points at Cloudflare's servers, and Cloudflare only passes web traffic. FTP to that name times out. Use a name that resolves to your hosting server's real IP instead (DNS only / grey cloud, or the host's own server name).

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
| `RATE_LIMIT_PER_HOUR` | 400 | Requests per IP per hour (Riffi's own limit) |
| `GEMINI_RPM` / `CLAUDE_RPM` | 8 / 40 | Requests per minute to the AI, shared by the whole server. Keep under your provider's limit |
| `TRUST_PROXY` | `false` | Set `true` behind Cloudflare so the limit counts each visitor, not Cloudflare |
| `REQUEST_SECONDS` | 60 | Deadline for each request (an overview, or a few lines). Well under Cloudflare's 100 s; the app gives each request its own deadline just over this |
| `PARALLEL_REQUESTS` | 2 | Requests the app sends at once, still within `GEMINI_RPM` / `CLAUDE_RPM`. Shared hosts limit PHP processes, and Gemini's free tier often answers "high demand", so keep it small |
| `LOG_FILE` | `null` | Private error log; `null` = `riffi-logs/omr.log` next to the web root, `false` = off |
| `DIAGNOSTICS` | `true` | Allows **Settings → App → Check music reader** |
| `ADMIN_PASSWORD` | `''` | Lets a grown-up change the music reader for the whole site in **Settings → App → Music reader → Change**. The server checks it (constant-time) and allows 5 wrong tries per IP per 15 minutes. Empty = no Change button, `PROVIDER` is always used. Use a long passphrase |
| `CHECK_ROUNDS` | 0 | Double-check rounds per line (0 = off, 1 or 2). Each round costs one more request per batch of lines; on the recorded run it didn't improve accuracy, so it's off by default |
| `SETTINGS_FILE` | `null` | Where the site-wide music reader choice is saved; `null` = `riffi-settings.json` next to the private log, outside the web root |
| `LINES_PER_REQUEST` | 4 | Lines of music per request with Gemini (each still its own picture). Measured on the free tier: about 7 s for 4 lines; a 7-line page is 3 requests (the free tier allows 20 a day per model) |
| `CLAUDE_LINES_PER_REQUEST` | 1 | The same with Claude: one line per request is quickest |
| `GEMINI_THINKING` | `low` | `off`, `minimal`, `low`, `medium`, `high`, or `''` (the model's default, usually high and slow). Gemini 3 can't switch thinking off, so `off` = `minimal` there; on Gemini 2.5 Flash `off` really is off. If a model refuses a level, the server falls back to `low`, then to no setting. The recorded accuracy was measured with `low`; `medium` can take a minute per request |
| `GEMINI_THINKING_OVERVIEW` | `low` | Thinking level for the quick look at the whole page |

**Choosing the music reader.** Every scan uses the same reader, for everyone: the one chosen in **Settings → App → Music reader** (saved on the server, in `riffi-settings.json` next to the log), or `PROVIDER` if nothing was chosen. Everyone sees which reader is in use; only someone with `ADMIN_PASSWORD` can change it, and only to a reader whose key is in the config. The app never sends a choice itself.

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

PHP 8.1 or newer with `curl`, `dom`, `fileinfo` and `mbstring`. Upload limits are set in `api/.user.ini` (PHP-FPM hosts) and `api/.htaccess` (mod_php/LiteSpeed hosts): 4 MB per file, 34 MB per request, 10 files. Some hosts ignore these: if reading fails with "too big", raise `upload_max_filesize` / `post_max_size` in the control panel.

**Time limits.** Each request (a page overview, or a few lines) has its own deadline (`REQUEST_SECONDS`, 60 s), and the endpoint calls `set_time_limit` itself, so a host's 30 s `max_execution_time` only matters if the host forbids `set_time_limit`. The self-check (below) tells you if it does. A typical page takes 15–40 s.

The rate limiter writes tiny counter files to the system temp folder by default. If the host's temp folder isn't writable or is shared, set `RATE_LIMIT_DIR` in the config to a private folder outside the web root.

### Checking and troubleshooting sheet reading

**Settings → App → Check music reader** asks the server for a report (it never shows keys):

- whether the config was found and which provider and model it uses;
- whether the model name exists for your key (catches a wrong `GEMINI_MODEL` or a bad key);
- a tiny test request to the AI (catches a host that blocks outgoing connections);
- PHP's time limit and whether `set_time_limit` works;
- whether the reply **streams** (if a proxy or LiteSpeed buffers it, Cloudflare's 100 s limit can still cut long pages off);
- where the private log is.

**Copy report** puts it on the clipboard, ready to paste into an issue or email.

When reading fails, the message says why, in plain words, and ends with a **Reference** code:

| Category | What it means | What to do |
|---|---|---|
| Busy | The AI's limit (e.g. Gemini free tier per-minute quota) or it's overloaded | Wait a minute |
| Took too long | The page hit the deadline, or Cloudflare cut it off (524) | Try a clearer, tighter crop; run the check |
| Can't reach the AI | The host blocked the outgoing connection or TLS failed | Ask the host to allow outgoing HTTPS to `generativelanguage.googleapis.com` (or `api.anthropic.com`) |
| Settings problem | Bad key, unknown model name, region not supported | Check `GEMINI_API_KEY` / `GEMINI_MODEL` |
| Not set up | No config file or empty key | See step 3 |
| Couldn't read the music | The AI's answer wasn't usable music, twice | Retake the photo |

The **private log** is `riffi-logs/omr.log` in the folder *above* the web root (e.g. `/home/<you>/riffi-logs/omr.log`; open it with the control panel's File Manager, since FTP is scoped to the site root). Each line is JSON with the reference code, the stage, the provider's HTTP status and its error message, with API keys scrubbed. It rotates at 1 MB. If that folder isn't writable, the check tells you where the log went instead (set `LOG_FILE` to choose).

### 5. First run on each device

Open https://riffi.avimandal.com, add a kid, add some music, and press **Start**. The first time, Riffi offers a **10-second sound check**: it measures the room's noise and plays a few clicks to measure the device's audio latency. Do it with the volume up and headphones off. You can redo it any time in **Settings → App → Timing check**. Then install it to the home screen (Chrome/Edge/Android: the Install button on Home; iPad/iPhone: Share → Add to Home Screen).

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

### Per-device settings (Settings → App)

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

- **Sheet reading, line by line** (`src/sheet/reader.ts`):
  1. **Find the lines.** In the browser, each photo is straightened and cropped by the parent, then kept at full resolution (up to 4096 px). `src/sheet/staffDetect.ts` finds every staff (five evenly spaced lines, followed across the page so tilt and curl don't matter, and checked to be the real five lines, not four plus a run of ledger lines) and groups them into systems: two staves joined by a brace or by bar lines running through both are a **grand staff** (right hand over left hand), cropped and read as ONE line, with both hands in the same bars. Single-staff music stays one staff per line. Each staff's clef is read as printed (beginner piano music often has both hands in treble clef), and the note heads measured on each staff are named by that clef.
  2. **Look at the whole page once** (a small picture): title, composer, key, time signature, tempo, pickup bar and repeats.
  3. **Measure the note heads** (`src/sheet/noteHeads.ts`): once the staff lines are known, which line or space each filled note head sits on is simple geometry, and it's exactly where AI models slip on small, dense photos (they tend to "hear" a plausible tune instead of reading it). The measured positions go to the reader as hints.
  4. **Read each line from its own crop** (up to 1600 px wide), with the key, time signature, pickup and printed bar numbers from the page overview. Lines go in small batches (`LINES_PER_REQUEST`, 4 for Gemini, 1 for Claude), several requests at once (`PARALLEL_REQUESTS`) within the per-minute limit, each with its own deadline. Lines show up on the review screen as they arrive. Afterwards a key or time change on one line is carried to the next in order.
     - **Never fail the whole page:** a request that fails or times out is tried once more, smaller (its lines one by one; a lone line with a smaller picture). A line that still fails is listed on the review screen with its part of the photo and **Read this line again** (and **Retry all failed lines**); its bars go back exactly where they belong. Only a problem no retry can fix (no key, the day's free quota used up, offline) stops sending, and every line already read is still kept.
  5. **Free code checks** (`src/sheet/checks.ts`): every bar adds up to the time signature (pickups and a closing short bar excepted), the key signature is there and actually applied (an F in D major without its sharp is caught), notes are within the instrument's range, tuplets have the right number of notes, and the pitches agree with the measured note heads.
  6. **Double-check** (up to two rounds per line, stopping early when nothing is wrong): the line's transcription is engraved with the app's own renderer (OSMD, one system, every bar numbered) and a fresh request gets only the photo of the line, that engraving, the transcription and the code checks' problems. It lists mismatches (pitch, direction, accidentals, rhythm, beaming, triplets, ties, rests, pickup) and returns a corrected line. A correction is kept unless it breaks more bars than it fixes.
  7. **Review highlights:** bars that still fail a check, or that the reader said it wasn't sure about, are outlined on the review screen with the reason, so you know where to look.
  - **Pacing:** the app paces itself (`GEMINI_RPM` per minute, told to it by `?info`) and the server keeps a shared per-minute count too. When the AI says it's busy (HTTP 429), the app waits as long as Gemini's `retryDelay` asks (counting down on screen) and tries again. If the free tier's *daily* quota is used up, it says so instead.
  - **Notation:** the AI answers in *Riffi Notation*, a compact JSON format (one string of tokens per bar, e.g. `"D5e. E5s 3( F#5e G5e A5e ) B5q"`); the browser builds the MusicXML itself (`src/sheet/notation.ts`).
  - **Timings:** the app sends each read's timings (getting photos ready, measuring note heads, every request, engravings, time spent waiting for the per-minute limit) to the private log, and the server logs every request with its time and outcome. **Settings → App → Check music reader** shows the last read on this device and a summary of recent requests from the log (median and slowest per kind, timeouts).
  - **Streaming:** each request streams (keep-alive pings, "bars so far" progress, then the result or a categorised error with a reference code), with a hard deadline (`REQUEST_SECONDS`).
  - **Providers:** **Google Gemini** (the default) or **Anthropic Claude**, behind one interface. If the server has keys for both, **Settings → App → Music reader → Change** (with `ADMIN_PASSWORD`) chooses which one reads every scan on the site. With Claude, the request opts in to the API's server-side refusal fallback (`fallbacks: "default"`); set `USE_FALLBACKS` to `false` to turn that off.
  - Nothing is stored on the server except the private error log (no images, no music). You can also open MusicXML files directly (`.mxl` zipped files are unpacked in the browser).
  - **Instrument:** adding and practising default to the current kid's main instrument.
- **Review:** the music is drawn with OpenSheetMusicDisplay next to the photo thumbnails. Tap a note (or use the arrow keys) to move it up or down, change its length, turn it into a rest, delete it, or add a note or rest after it. You can also change the key, time signature and title. "Looks good!" saves it.
- **Editing later and downloading:** every saved piece has a … menu (on its card on Home, and in the Practice screen's header) with **Edit music** and **Download music file**. Edit music opens the same editor. Pieces read from photos keep a 1600 px copy of each photo (on the device only) and where each line of music sits on it, so selecting a note shows the line of the photo that bar came from, right by the editing tools (the whole page is under "Show photo"). The editor also says which music reader read it. "Save changes" keeps the piece's id, so the kid's scores and history stay, and adds "Music edited" (with the date) to My progress; past results drawn on the old version no longer colour the notes. "Cancel" asks first if anything changed. Downloads are `.musicxml` files named after the title (e.g. `Hermans-hornpipe.musicxml`); on iPhone and iPad they go through the share sheet (Save to Files), elsewhere they download. They open again through Add music → Open a music file.
- **Navigation:** bottom tabs Home, My progress, Tools (the Tuner & Metronome) and Settings. The avatar and greeting at the top of each of those is the **Switch player** button. Settings has no gate; deleting a kid, restoring a backup and deleting everything each ask "Are you sure?" first.
- **Metronome:** clicks are scheduled on the audio clock with a lookahead (the timer only wakes the scheduler). There's a one-bar count-in, an accent on beat 1, a short high woodblock click (mostly above 4 kHz), and a big bouncing dot that always shows.
- **iPhone silent switch and loudspeaker** (`src/audio/session.ts`): Safari normally mutes web audio when the ringer switch is on silent. Where Safari has the Audio Session API (iOS 16.4+/17), Riffi sets `navigator.audioSession.type` to `playback` when sound starts, and to `play-and-record` just before the mic opens (that also plays through the switch, and keeps output on the loudspeaker rather than the earpiece). It goes back to `playback` when the mic closes. On older iOS it plays a silent looping `<audio>` element from the same tap instead, re-kicks it after the mic opens, and pauses it when the app is hidden so it doesn't linger in Now Playing. This covers the practice metronome, the Tuner & Metronome (clicks, reference tone, chime) and the note preview on the review screen. Android and desktop are left alone.
- **Ignoring the metronome**, in layers: exact click times are known, so analysis frames within ±35 ms of a click can't start or end notes; the mono engine band-limits to 60 Hz–3.5 kHz and drops pitches outside the instrument's range; the mic uses echo cancellation but no noise suppression or auto gain (the tuner turns echo cancellation off too, unless the metronome is clicking); and the app suggests headphones.
- **Mono engine:** `pitchy` (McLeod) with a 2048 window and 256 hop, clarity ≥ 0.9, a calibrated noise gate, and a 5-frame median. Notes are segmented by pitch, not volume, and each note's pitch is the median over its body, so vibrato isn't a mistake.
- **Piano engine:** Spotify's Basic Pitch model in a Web Worker, loaded only when piano is chosen. A streaming version keeps only the frames inside each 2 s window's context, so live output arrives well under a second behind. If the device can't keep up, it switches to **play then score**: it records in memory, analyses at the end with a progress bar, then deletes the recording.
- **Tuner & Metronome** (`/gadget`, the Tools tab): a standalone handheld-style device that needs no sheet music.
  - **Metronome:** 30–250 BPM with hold-to-repeat, tap tempo, seven time signatures, five sounds (woodblock, click, beep, cowbell, soft), accent, subdivisions, a 5/10/15-minute practice timer with a chime (and vibration where supported), and per-kid presets.
  - **Shared scheduler:** it runs on the same lookahead scheduler as the practice metronome (`src/audio/scheduler.ts`), and settings apply live from the next click.
  - **Tuner:** reuses the mono pitch engine, with Violin (G D A E string buttons), Voice and Piano/chromatic presets, A = 438–445 Hz, and a reference tone to tune by ear.
  - **Count my practice:** uses the mic to log minutes actually played (as a "metronome" practice session, which counts towards streaks, weekly minutes and badges).
  - **Never hearing itself:** every click is registered with the engine as a mask from 25 ms before it to 25 ms after its sound ends, and all five sounds are 30 ms or shorter. Pitch detection is muted while the reference tone plays. Unit tests mix each sound at every subdivision into synthetic playing.
  - **Limit:** with dense subdivisions at very fast tempos (clicks under about 75 ms apart, e.g. semiquavers above ~200 BPM), the masks cover almost all the time, so counting pauses rather than risk counting clicks.
 an online, windowed dynamic-programming alignment over pitch and onset time (both absolute and relative to the previous note, so steady tempo drift is tolerated). A missed note costs a skip and an extra note costs an insertion, so one slip doesn't derail everything after it. Learn mode waits on each note (all notes of a piano chord) until it hears it.
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
- Sheet reading is tested in CI against fake Gemini and Claude APIs and by replaying recorded real runs (see *Sheet-reading accuracy* under Tests); CI itself has no API keys.
- **Gemini's free tier allows 20 requests a day per model** (and the busiest models are often overloaded: 3 of 12 test requests got "high demand"). A 7-line page takes 3 requests with `LINES_PER_REQUEST => 4` and `CHECK_ROUNDS => 0`, so roughly six pages a day. A request is never re-sent after the AI's rate limit or daily limit; any other failure gets one retry per line. For more, use a paid key (then `LINES_PER_REQUEST => 1` is an option) or Claude.
- Engine and scoring tests use synthetic audio. Real instruments, rooms and microphones vary, so the real-world acceptance checks in SPEC §17 (a phone's speaker at normal volume, a mid-range tablet with two-hand piano, installing on an iPad) still need doing on real devices.
- Data is stored on one device only. Use **Settings → Backup** to move it. Clearing the browser's site data deletes it.

---

## Privacy

There's a plain-language privacy page in the app (written to suit the Australian Privacy Act). In short: audio never leaves the device and isn't recorded (play-then-score recordings are deleted after analysis); sheet photos go only to the reading endpoint and aren't stored there (on Gemini's free tier Google may use them to improve its models, which the privacy page explains); there are no analytics, ads, trackers or external fonts or scripts at runtime.
