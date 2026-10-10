# Music Practice App: Build Spec

App name: **Riffi** (kept as one constant in `src/config.ts`).

A kids' music practice web app. Kids photograph sheet music, the app reads it, listens through the microphone while they play along to a metronome, scores them out of 100, shows their mistakes on the sheet and tracks their practice. Instruments: **violin, piano (acoustic, via mic) and singing**.

This file is the source of truth for Claude Code. Build the full product described here, not a prototype. Where a decision is explained, keep the reasoning in mind when making related choices.

---

## 1. Platform and hosting

- **Progressive Web App** (installable, works offline except sheet reading). Runs on desktop, tablet and phone browsers: Chrome, Edge, Firefox, Safari (iOS/iPadOS 16+), Android Chrome.
- **Hosting:** standard PHP shared hosting alongside an existing WordPress site.
  - Deploy to a subdomain (preferred, e.g. `practice.example.com`) or a subfolder (`/practice/`). Base path must be configurable at build time (`VITE_BASE_PATH`).
  - The app is static files plus **one PHP endpoint** for sheet reading. No database required.
  - HTTPS is mandatory (browsers block mic and camera otherwise).
- **Do not touch WordPress.** Ship an `.htaccess` for the app folder only, with SPA fallback to `index.html` and correct MIME types for `.wasm`, `.webmanifest` and model files.

## 2. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Build | Vite + TypeScript (strict) | Fast, static output that suits PHP hosting |
| UI | React 18 | Mature ecosystem, OSMD integrates easily |
| Sheet rendering | OpenSheetMusicDisplay (OSMD) | Renders MusicXML, has a cursor, notes can be recoloured |
| Mono pitch (violin, voice) | `pitchy` (McLeod pitch method) | Accurate, tiny, fast on phones |
| Poly pitch (piano) | `@spotify/basic-pitch` (TF.js) in a Web Worker | Polyphonic transcription in the browser |
| Audio capture | Web Audio API + AudioWorklet | Low latency, off the main thread |
| Storage | IndexedDB via Dexie | Local-first, handles sheets and history |
| PWA | `vite-plugin-pwa` (Workbox) | Offline shell, install prompt |
| Icons | Material Symbols Rounded, **self-hosted** font subset | Kid-friendly rounded look, works offline |
| Fonts | System font stack only | `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` |
| Tests | Vitest (unit), Playwright (e2e smoke) | |
| Server | PHP 8.1+, single endpoint, cURL | Matches existing hosting |

## 3. Architecture

```
Mic ─► AudioWorklet ─► Listening engine ─► NoteEvents ─┐
                       (mono | piano)                   ▼
Sheet photos ─► /api/omr.php ─► MusicXML ─► Expected notes ─► Score follower ─► Scorer ─► Results + feedback
                                                        ▲                                     │
Metronome (Web Audio scheduler) ─► click timestamps ────┘                                     ▼
                                                                                    Practice log (IndexedDB)
```

All engines emit the same shape, so following, scoring and feedback are written once:

```ts
type NoteEvent = {
  midi: number;        // MIDI note number (float allowed for cents)
  cents: number;       // deviation from nearest semitone
  onsetMs: number;     // relative to session start, latency-corrected
  durationMs: number;
  confidence: number;  // 0..1
};
```

## 4. Sheet reading (photo to MusicXML)

### Capture (client)
- "Add music" flow: take photos with the camera (`<input type="file" accept="image/*" capture="environment" multiple>`) or pick from gallery. Multiple pages per piece.
- Page tray: reorder by drag, delete, retake, simple crop and rotate.
- Before upload, downscale to max 2000px on the long edge, JPEG quality 0.85, fix EXIF orientation. Keeps uploads small and avoids PHP upload limits.
- Show friendly progress ("Reading your music... page 2 of 3").

### Server: `api/omr.php`
- Accepts `POST` multipart: `pages[]` (images, in order), `instrument`.
- Sends pages to the Claude API (vision) with a prompt that returns **MusicXML 3.1 partwise** only: title, clefs, key and time signatures, tempo marking if present, notes, rests, ties, dots, accidentals, repeats, both staves for piano. Ignore lyrics, fingering and chord symbols.
- **Swappable AI provider.** Support both Google Gemini (free tier via Google AI Studio) and the Claude API behind one small adapter interface, chosen by `PROVIDER` in config (`gemini` default, `claude` alternative). Same prompt and validation for both. Handle Gemini free-tier rate limits (HTTP 429) with a friendly "Riffi's music reader is busy, try again in a minute" message.
- Config in `api/config.php` **outside the web root if the host allows**, otherwise protected by `.htaccess`: `PROVIDER`, `GEMINI_API_KEY`, `GEMINI_MODEL` (current free-tier Flash model), `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` (default `claude-sonnet-5-5`), `MAX_PAGES` (8), `MAX_BYTES_PER_PAGE` (3 MB), allowed origin.
- Validate the returned XML (parseable, has at least one note). On failure retry once with the parser error included, then return a clear error.
- Basic abuse protection: per-IP rate limit (file-based, e.g. 20 scans per hour), CORS limited to the app origin.
- **Do not store images or results on the server.** Process and discard.
- Response: `{ musicxml, warnings[] }`.

### Review and fix screen (essential)
Photo OMR will make mistakes, and one wrong note ruins every score after it. After reading:
- Render the result with OSMD, next to a thumbnail of the photo.
- Tap a note to change pitch (up/down buttons), duration, or delete or insert a note or rest. Change key or time signature.
- "Looks good!" saves the piece. Pieces can be edited later.

## 5. Metronome

- Web Audio lookahead scheduler (do not use `setInterval` for timing). Tempo 40 to 200 BPM, defaulting to the sheet's tempo or 80.
- One-bar count-in before every run.
- Accent on beat 1. Sound: short (~20 ms) high woodblock-style click.
- Visual pulse always shown (big bouncing dot), so it works muted too.
- **Modes:** sound, visual only, or vibration (Android, where supported).
- **Ignoring the metronome while listening** (layered, since no single trick is perfect):
  1. Clicks are generated by the app, so exact click times are known. Suppress note onsets within a ±35 ms window around each click (after latency correction).
  2. Click sound sits mostly above 4 kHz; band-limit the analysis input for the mono engine and discard detected pitches outside the instrument's range.
  3. `getUserMedia` with `echoCancellation: true`, but `noiseSuppression: false` and `autoGainControl: false` (both damage instrument sound).
  4. Recommend headphones in the UI as the "pro tip" for best results.
- **Latency calibration** (Settings, also offered on first run): play clicks, detect them through the mic, store the round-trip offset per device.

## 6. Listening engines

Common: mono audio at the device sample rate via AudioWorklet, frames posted to the engine. Input level meter shown during practice ("I can hear you!").

### 6.1 Mono engine (violin, singing)
- `pitchy`, window 2048, hop 256. Accept frames with clarity ≥ 0.9 and RMS above a calibrated noise floor.
- Median filter pitch over 5 frames.
- **Segment notes by pitch, not volume**: bowed and sung notes start softly. A new note starts when the median pitch moves more than 60 cents and holds for at least 60 ms, or after a silence gap.
- Report the note's pitch as the median across its body, so **vibrato is not a mistake**.
- Instrument ranges: violin G3 to E7; voice A2 to C6.

### 6.2 Piano engine (acoustic)
- Basic Pitch model in a Web Worker, fed in overlapping chunks. Convert note and onset outputs into `NoteEvent`s.
- Group notes with onsets within 60 ms as one chord.
- Lazy-load the model only when piano is selected; show a one-off "Getting the piano ears ready" loader.
- Detect weak devices (slow first inference). If real-time can't keep up, switch that device to **"play then score"**: record the run, analyse at the end. Never silently fail.

## 7. Score following

- Expand MusicXML into an **expected note list**: pitch(es), onset beat, duration beats, bar number, OSMD note reference. Expand repeats. Piano: both staves merged into chords by onset.
- Convert beats to ms using the chosen tempo.
- Online alignment (windowed dynamic time warping over onsets and pitch) so one missed or extra note doesn't derail everything after it. The OSMD cursor follows the aligned position.
- Two practice modes:
  - **Play-along:** metronome runs, scored. The main mode.
  - **Learn mode:** no metronome, the cursor **waits** on each note until it hears it. Great for new pieces. Shows accuracy, no score out of 100.
- Loop range: select bars (e.g. 3 to 5) to practise just that section.

## 8. Scoring

Per expected note, classify:
- **Pitch:** correct, close, wrong, missed.
  - Tolerances by difficulty (`Easy`, `Normal`, `Tricky`): violin ±40/30/20 cents, voice ±60/50/35 cents, piano exact semitone.
  - Voice: **octave-equivalent** matching (kids often sing an octave away from what's written).
  - Piano chords: partial credit, notes hit ÷ notes in chord.
- **Timing:** onset error vs expected. Good ≤ a 16th note, OK ≤ an 8th, else late or early.
- **Length** (violin, voice only): held at least 60% of written duration.

Score out of 100:
- 60 × pitch accuracy
- 30 × rhythm accuracy
- 10 × completion (fraction of the piece reached)

Rounded to a whole number, plus stars: 1 star at 50+, 2 at 75+, 3 at 90+.

Keep all scoring in pure, unit-tested functions (`src/scoring/`), with tolerances in one config object so tuning after real-world testing is a one-file change.

## 9. Feedback and encouragement

- Results screen: big score with an animated count-up, stars, and the comparison that matters most to kids: **"Your best was 72, now 81!"**
- Sheet view colours each note: green (correct), amber (close or timing off), red (wrong), grey dashed (missed).
- Top 3 issues max, in plain kid language, each with a "Fix it" button:
  - "Bar 4: a bit rushed. Try it slower?" → loops bars 3 to 5 at 75% tempo.
  - "Bar 7: that F wants to be F#." → shows the note and the key signature hint.
- **Tone rules:** never "wrong" or "bad" in copy. Always lead with something they did well. Celebrate improvement, effort and streaks, not just high scores.
- Confetti on a personal best (respect `prefers-reduced-motion`).

## 10. Practice tracking

- **Kid profiles:** multiple kids per device, each with a name, avatar (from a fun built-in set) and main instrument.
- Session log: date, piece, instrument, mode, **active playing time** (sound detected, not just app open), score, per-bar results.
- Daily streak, weekly minutes goal (set by the parent), per-piece best score and trend chart.
- Badges, e.g. First song, 3-day streak, 7-day streak, 100 minutes, Perfect bar, Comeback (beat your best by 10+).
- Parent area behind a simple parent gate (e.g. "hold for 3 seconds" + simple maths): weekly summary per kid, goals, difficulty, export and import backup (JSON file), delete data.
- **Storage is local only (IndexedDB).** There are no accounts and no sync in this build (see Open decisions).

## 11. Screens

1. **Who's practising?** Profile picker with big avatar tiles, plus Add kid.
2. **Home:** greeting, streak flame, weekly goal ring, "Keep going" card (last piece), My music library grid, big Add music button.
3. **Add music:** camera/gallery, page tray, reorder, crop.
4. **Review sheet:** rendered music, tap-to-fix tools, Looks good.
5. **Practice:** sheet with cursor (fills the screen; landscape on tablets), instrument chip, tempo control (− / BPM / +), metronome mode toggle, difficulty, mode (Play-along / Learn), loop bars, big round Start/Stop, level meter.
6. **Results:** score, stars, improvement, coloured sheet, top issues with Fix it, Play again.
7. **My progress:** streak calendar, minutes chart, badges, per-piece bests.
8. **Settings (parent):** mic check and latency calibration, metronome sound, goals, backup, privacy info.

## 12. Visual design

- Bright, friendly and calm, not chaotic. Rounded corners (16 to 24 px), soft shadows only for cards, generous spacing.
- Material Symbols Rounded, weight 500, filled style for active states.
- System font stack. Large type: body 18 px minimum, headings 28 to 40 px.
- Touch targets **at least 56 px**; primary actions 72 px+.
- Colour tokens in CSS variables, light and dark themes, WCAG AA contrast. Never rely on colour alone (mistake states also get an icon or pattern).
- Responsive from 360 px phones to large desktops. Practice screen prioritises the sheet.
- Subtle, quick animations (under 300 ms), all disabled under `prefers-reduced-motion`.

## 13. Privacy and safety (kids' app)

- **Audio never leaves the device.** No recordings are stored by default; "play then score" recordings are deleted after analysis.
- Sheet photos go only to the OMR endpoint and are not stored server-side. On Gemini's free tier, Google may use submitted images to improve its models; the privacy page must say so, and the capture screen reminds kids to photograph only the music (no faces).
- No analytics, no ads, no third-party trackers, no external fonts or CDNs at runtime.
- A plain-language privacy page in the app, written to suit the Australian Privacy Act.

## 14. Project structure

```
/
├─ SPEC.md
├─ README.md                 # setup, deploy, tuning notes
├─ .github/workflows/
│   ├─ ci.yml                # typecheck, lint, unit tests, build
│   └─ deploy.yml            # build + SFTP/FTP deploy (secrets), manual trigger
├─ api/
│   ├─ omr.php
│   ├─ config.sample.php
│   └─ .htaccess
├─ public/
│   ├─ icons/  fonts/  models/basic-pitch/
│   └─ .htaccess
└─ src/
    ├─ app/          # routes, layout, theme
    ├─ screens/      # one folder per screen above
    ├─ components/   # buttons, cards, avatar, meter, stars, confetti
    ├─ audio/        # capture worklet, metronome, latency calibration
    ├─ engines/      # mono/, piano/ (worker), types.ts
    ├─ sheet/        # MusicXML parsing, expected notes, OSMD wrapper, editor
    ├─ follow/       # score follower
    ├─ scoring/      # pure scoring functions + config
    ├─ data/         # Dexie schema, repositories, backup
    ├─ i18n/         # en-AU strings (all copy lives here)
    └─ config.ts
```

## 15. Testing

- **Unit:** scoring and follower against synthetic `NoteEvent` streams (perfect run, one skipped note, extra notes, late notes, octave-off singing, partial chords).
- **Engine fixtures:** generate test audio (sine and harmonic tones with vibrato, sung-like glides, piano-like chords, with and without metronome clicks mixed in) and assert detected notes.
- **MusicXML:** parse fixtures with repeats, ties, two staves, key changes.
- **E2E smoke (Playwright):** create profile, import a fixture MusicXML (bypassing OMR), run practice with a fake audio stream, see results saved.
- CI must pass before deploy.

## 16. Deployment

- `deploy.yml`: manual trigger, builds with `VITE_BASE_PATH`, uploads `dist/` and `api/` via SFTP (or FTP) using repository secrets. Never commit `config.php` or keys.
- README covers: creating the subdomain, uploading `config.php` with the API key, checking HTTPS, and the first-run mic check.

## 17. Acceptance criteria

- Photograph a 2-page beginner violin piece on a phone, fix any errors, and practise it within 2 minutes.
- Playing a piece correctly scores 90+; deliberately wrong notes are flagged on the right bars.
- Metronome clicks are not detected as notes on a phone speaker at normal volume.
- Vibrato on sustained notes does not lower the pitch score.
- A child singing an octave below the written melody scores normally.
- Simple two-hand acoustic piano pieces score sensibly on a mid-range tablet (real-time or play-then-score).
- Works installed as a PWA on iPad, Android phone and desktop Chrome.
- Lighthouse: PWA installable, accessibility 95+.

## 18. Known limits (be upfront in the README)

- Photo reading is best on clear, printed, flat, well-lit pages. Handwritten music is unlikely to read well.
- Acoustic piano detection is the least precise of the three; dense or fast passages will be scored more leniently.
- Tolerances will need tuning after testing with real kids and instruments. That's expected, and it's why scoring config lives in one file.

## 19. Open decisions (defaults used until told otherwise)

1. **App name:** Riffi (decided).
2. **Subdomain vs subfolder:** subdomain.
3. **Cross-device sync and accounts:** not in this build. Adding it needs a login system and a database on the PHP host, plus extra care with kids' data.
