# Morse Trainer — Offline LAN Classroom Platform

## Phase 2: LAN Server Foundation

The server now runs as a real LAN service:
- Binds to all network interfaces (`0.0.0.0`), not just localhost
- Auto-detects the machine's LAN IP address and prints/display it, so the
  teacher knows exactly what URL to give students — nothing is hardcoded
- Configuration via `.env` (see `server/.env.example`)
- Basic file + console logging (`server/logs/server.log`)
- Windows scripts to start/stop/dev the server without touching the command line

Still NOT implemented (by design — later phases): authentication, student
accounts, Morse generation, tests, grading, synchronization, dashboards.
The empty `server/src/modules/*` folders are placeholders for these.

## Requirements

- Node.js 18+ (needed once, for `npm install`; the app itself then runs
  fully offline)

## First-time setup

```bash
cd server
npm install
copy .env.example .env      (Windows)   /  cp .env.example .env   (macOS/Linux)
```

The defaults in `.env.example` (port 8080, host 0.0.0.0) work for almost
every classroom — you normally don't need to change anything.

## Running the server

### Windows (recommended)
Double-click, or run from `cmd`:
- `scripts\start.bat` — normal/production mode
- `scripts\dev.bat` — development mode (auto-restarts when you edit source files)
- `scripts\stop.bat` — stops the server (add a port number as an argument if you changed the default: `scripts\stop.bat 9090`)

### Any platform (manual)
```bash
cd server
npm start        # production
npm run dev       # development, auto-restart on changes
```

On startup the server prints something like:

```
========================================================
  MORSE TRAINER SERVER — ONLINE
========================================================
  Local (this machine):  http://localhost:8080
  Share with students:   http://192.168.1.42:8080
========================================================
```

Give the **"Share with students"** URL to the class — every student opens
that address in their browser.

## Endpoints (Phase 2)

| Endpoint | Purpose |
|---|---|
| `GET /` | Placeholder client page (shows live server status + the shareable LAN URL) |
| `GET /api/health` | JSON health check: `server_status: "ONLINE"`, LAN URL, uptime, etc. |
| `GET /api/health/text` | Same info as plain text, for a quick manual check |
| `GET /api/network-info` | Lists every detected network interface/IP, in case the auto-picked one is wrong for your classroom (e.g. multiple adapters) |

Database status is intentionally **not** part of the health check yet —
that will be added in a later phase alongside the database-backed features.

## Morse Engine (Phase 5)

`server/src/modules/morse-engine/` is a standalone, dependency-free
internal engine — the single source of truth for anything Morse-related.
Nothing else in the codebase should ever hardcode a dot/dash pattern or
a timing formula; everything goes through `require('./modules/morse-engine')`.

What it provides:
- **text ↔ Morse** conversion (`textToMorse`, `morseToText`), lenient by
  default (reports unsupported characters/tokens) or strict (throws)
- **Validation** of plain text or Morse strings against the supported
  character set
- **Timing calculations** (`computeTiming`, `computeSequenceDurationMs`) —
  WPM-based dot/dash/spacing durations, including full Farnsworth timing
  support. The exact mathematical model (the standard 50-unit PARIS word,
  31 content units / 19 spacing units) is documented in
  `timingService.js`.
- **Random training-text generation** (`generateRandomText`,
  `generateFromDifficulty`), reproducible via an optional seed — the
  same seed always produces the same text (and, for difficulty-based
  generation, the same resolved WPM/length too)
- **Difficulty as data**, not code — see `difficultyPresets.js`. Adding a
  new difficulty level means adding an entry to that array, never a new
  folder or branch of logic.

This phase does **not** implement audio playback — only the underlying
data/timing engine. Run its unit tests with:

```bash
cd server
npm test
```

## Morse Audio (Phase 6)

Playable Morse audio, generated entirely in the browser with the Web
Audio API — no audio files, no network requests for sound.

**`client/public/js/morse-audio-player.js`** — `MorseAudioPlayer`, a
reusable component:
- Takes a "playback plan" (a flat list of tone/gap segments, produced by
  the server's Morse engine) and schedules every oscillator's start/stop
  time ahead of playback using the AudioContext's own clock, rather than
  chaining `setTimeout` calls — avoiding main-thread timing jitter.
- Configurable tone frequency, volume (live-adjustable), and a short
  attack/release envelope on every tone to avoid audible clicks.
- Built-in support for the replay rules a later testing phase will need:
  `maxPlays` (null = unlimited, a number caps total plays — covering both
  "play once" and "replay disabled") and `autoPlay` (fire on load vs.
  manual trigger only).

**Server side** (`server/src/modules/morse-engine/`):
- `playbackPlan.js` — `buildPlaybackPlan(morse, timing)` turns a Morse
  string + timing profile into the flat segment list the player consumes
  (pure data, unit-tested, guaranteed to sum to the same total as
  `computeSequenceDurationMs`).
- `POST /api/morse/preview` (teacher-only) — converts text to Morse +
  timing + a ready-to-play plan in one call.
- `GET /api/morse/random?difficulty=...` (teacher-only) — generates
  random training text via the Phase 5 engine, for previewing "generated"
  audio.

**Teacher preview**: the Teacher Dashboard (`teacher.html`) has a "Morse
Audio Preview" panel — type or generate text, adjust WPM/Farnsworth/tone/
volume, pick a replay-policy demo mode, and play it locally.

This phase does not implement the full testing system (grading, session
enforcement) — only the reusable audio engine and a teacher preview tool
built on top of it.

## Individual Training (Phase 7)

Students can practice on their own — entirely separate from official
test grading (later phase). Ungraded practice attempts are stored in
their own `practice_attempts` table, with no shared table with the
`sessions`/`attempts`/`results` tables reserved for teacher-controlled
tests, so practice can never affect an official grade.

**Four exercise modes**, all built on the same seed-reproducible Phase 5
engine (`server/src/modules/practice/practiceEngine.js`):
- **Audio → Text** — listen, type what you heard
- **Morse → Text** — read Morse code, type the text
- **Text → Morse** — read text, type the Morse code
- **Character Recognition** — single-character audio drill

**Endpoints** (any authenticated user, self-scoped):
- `POST /api/practice/exercises` — generates an exercise; returns only
  what that mode should reveal (never the answer) plus a `seed`
- `POST /api/practice/attempts` — the client echoes the seed + settings
  back; the server regenerates the identical exercise deterministically,
  scores the submission, and saves it to the student's own history
- `GET /api/practice/history` — the current user's own past attempts only

**Scoring** (`server/src/modules/morse-engine/scoring.js`): a proper
sequence-alignment diff (Levenshtein with backtrace), not naive
positional comparison — a single dropped character is reported once as
"missing," not as a cascade of false "incorrect" characters for
everything after it. Reports correct/incorrect/missing/extra counts and
an accuracy percentage.

**UI**: `practice.html` — a minimal, distraction-free 3-screen flow
(settings → exercise → results), reusing the Phase 6 `MorseAudioPlayer`
for the audio-based modes.

## Verifying offline operation

After `npm install` has been run once, disconnect the machine from the
internet (keep the classroom LAN link up) and confirm the server still
starts and the page still loads normally — no external requests are made
at runtime.

## Testing from another computer on the LAN

1. Start the server on the teacher PC.
2. Note the "Share with students" URL it prints.
3. On a **different** computer connected to the same LAN (same Wi-Fi/switch),
   open a browser and go to that URL.
4. You should see the placeholder page load with "SERVER STATUS: ONLINE".

If it doesn't connect, check:
- Windows Firewall may be prompting to allow Node.js on first run — allow it
  for **private networks**.
- Confirm both machines are actually on the same network/subnet.
- Check `GET /api/network-info` in case the wrong adapter was auto-selected
  (e.g. a VPN or virtual adapter) and try one of the other listed addresses.

## Project layout

```
morse-trainer/
├── scripts/                    Windows helper scripts
│   ├── start.bat
│   ├── dev.bat
│   └── stop.bat
├── server/
│   ├── .env.example             copy to .env to configure
│   ├── src/
│   │   ├── config/               reads .env / environment variables
│   │   ├── logger/                console + file logging
│   │   ├── middleware/            request logger
│   │   ├── utils/network.js       LAN IP auto-detection
│   │   ├── db/                    schema.sql, migrate.js, client.js, seed.js
│   │   ├── modules/
│   │   │   ├── auth/                login, sessions, password hashing
│   │   │   ├── users/                account CRUD, search/filter
│   │   │   ├── classes/              class CRUD
│   │   │   ├── morse-engine/         text<->Morse, timing, difficulty, generator, playback plan, scoring, HTTP preview routes (Phase 5+6+7)
│   │   │   ├── practice/             individual training exercises + history (Phase 7)
│   │   │   ├── sessions/             empty placeholder (group/test sessions, later phase)
│   │   │   ├── grading/              empty placeholder (later phase)
│   │   │   └── stats/                empty placeholder (later phase)
│   │   ├── realtime/               empty placeholder (WebSocket hub, later phase)
│   │   └── server.js               entry point
│   ├── data/                      SQLite database file (gitignored)
│   └── logs/                      server.log (gitignored)
├── client/
│   └── public/                    static placeholder page, css/, js/
└── docs/checkpoints/               one file per phase checkpoint
```
