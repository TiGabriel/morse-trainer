# Morse Trainer — Offline LAN Classroom Platform

**Status: feature-complete (Phase 12, final).** This section is everything
a teacher needs to actually run a class. Everything below "Development
History" documents how the app was built, phase by phase, for anyone
extending it later — it's historical, not a setup guide.

## Classroom Deployment

### Requirements
- One Windows PC for the teacher, to run the server (Node.js 18+, needed
  once for first-time setup)
- ~20 student PCs on the same private LAN, each with a modern browser
  (Chrome or Edge — the only browsers this deployment was tested with)
- No internet access needed for actual class use — the *only* moment
  that ever needs it is the one-time dependency install the very first
  time the server is set up on a machine

### Teacher: starting the server
1. Double-click **`START SERVER.bat`** in the project's root folder.
2. First run only: it installs dependencies automatically (needs
   internet briefly for this one step). Every run after that is fully
   offline.
3. Leave the window open for the whole class — closing it stops the
   server. To stop it deliberately, just close the window (or press
   Ctrl+C inside it); `STOP SERVER.bat` is also available if that
   window gets lost or closed accidentally.
4. The window prints what you need:
   ```
   Local (this machine):  http://localhost:8080
   Share with students:   http://192.168.1.42:8080
   ```
   The first line is for testing on the teacher PC itself. Give the
   **second line's address** to the class.

On the very first run ever, the server also creates the initial teacher
login and writes it to `server/data/INITIAL_TEACHER_CREDENTIALS.txt` —
open that file, log in once, then delete it.

### Students: connecting
Every student just opens a normal browser (Chrome or Edge) and types in
the address the teacher gave them:

```
http://<TEACHER-LAN-IP>:<PORT>
```

For example: `http://192.168.1.42:8080`. That's the whole procedure —
no installation, no Node.js, no npm, no SQLite, no downloading or
copying any project files onto student machines. If the page doesn't
load, see "Windows Firewall" below, and confirm both computers are
actually on the same network (check `GET /api/network-info` on the
teacher PC if there's more than one network adapter).

### Windows Firewall
The first time the server starts, Windows may show "Windows Defender
Firewall has blocked some features of this app" — click **Allow
access**, with the **Private networks** box checked (leave Public
unchecked). That's usually all that's needed.

If that prompt was dismissed, or the port needs to be opened manually,
three ways to do the same thing — none of them disable the firewall or
touch any rule other than this one port:

- **Easiest**: right-click **`OPEN FIREWALL PORT.bat`** in the project
  root and choose **"Run as administrator."** It adds a rule allowing
  inbound connections on port 8080 for **private networks only**.
- **Manual (GUI)**: Windows Defender Firewall → Advanced Settings →
  Inbound Rules → New Rule → Port → TCP → Specific local port `8080` →
  Allow the connection → check **Private** only (leave Domain/Public
  unchecked) → name it "Morse Trainer".
- **Manual (Command Prompt, as Administrator)**:
  ```
  netsh advfirewall firewall add rule name="Morse Trainer" dir=in action=allow protocol=TCP localport=8080 profile=private
  ```

Also confirm the classroom network is set to **Private** in Windows
(Settings → Network & Internet → your network → Network profile type).
Windows Firewall treats Public and Private networks differently, and
this app is designed to be reachable only on a private/trusted network
— it was never meant to be exposed to a Public-profile network or the
open internet.

### Backup and restore
The entire database is one file: `server/data/morse_trainer.db`.

**To back up**: stop the server first (close the `START SERVER.bat`
window), then double-click **`BACKUP DATABASE.bat`**. It copies the
database into `server/data/backups/` with a timestamp in the filename
(e.g. `morse_trainer_20260101_120000.db`). Copy that file somewhere off
this computer too (a USB drive, a network share) — a backup that only
ever lives on the same machine isn't a real backup.

**To restore**: stop the server, then run `RESTORE DATABASE.bat` with
the backup file as an argument, e.g. from a Command Prompt in the
project folder:
```
"RESTORE DATABASE.bat" server\data\backups\morse_trainer_20260101_120000.db
```
It saves the current database as `morse_trainer.db.before-restore`
first (in case the wrong file was picked), then restores the chosen
backup. Start the server normally afterward.

This exact procedure was tested end-to-end while building this phase:
data was created, backed up, more data was added on top, the server was
stopped, the backup was restored, and the extra data was confirmed gone
while everything from the backup point was confirmed fully intact.

Why the server must be stopped first: on a clean shutdown, the database
merges its write-ahead log back into the single `.db` file (a
"checkpoint"), so that one file alone is a complete, consistent
snapshot — copying it while the server is still running risks copying
data that's still sitting in a separate, in-progress `-wal` file.

### Verifying offline operation
No CDN, no Google Fonts, no external `<script>`/`<link>` tags, no
third-party analytics or telemetry, no cloud database, no cloud
authentication — every asset and API call this app needs at runtime is
served from this same machine (verified by inspecting every HTML/CSS/JS
file in the client and every outbound call on the server — there are
none). To confirm this yourself: after the one-time `npm install`,
disconnect the classroom LAN's internet uplink entirely (the LAN
between the teacher and student PCs can stay up) and confirm the app
still works exactly the same.

### Known limitations (read before a real class)
- **A server crash or teacher-PC restart during a live session loses
  that session's live progress** — its scheduling timers are in-memory
  and don't survive a restart. Students would need to be re-invited to
  a new session. Anything already graded and saved (finished sessions,
  practice history) is completely unaffected — that's in the database,
  not memory.
- **Only Chrome and Edge (Chromium-based browsers) were tested.**
  Firefox and Safari were not part of this deployment's target audience
  and have not been verified — they are likely to work (nothing here is
  Chromium-specific by design) but were not checked.
- **The login rate limiter (10 failed attempts / 15 minutes per
  username) resets on a server restart** — an acceptable best-effort
  classroom control, not a hardened production one.
- See `docs/checkpoints/phase-12-checkpoint.md` for the full deployment
  QA record (classroom-scale test, failure/recovery testing, audio QA,
  security review) and every other checkpoint for how each part of the
  app was built and tested.

## Development History

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

## Group Sessions & Formal Testing (Phase 8)

Teacher-controlled group training and formal tests, built on a
server-authoritative state machine and a new WebSocket realtime hub —
the `sessions`/`realtime` folders were empty placeholders before this
phase.

**State machine** (`server/src/modules/sessions/sessionEngine.js`):
`created → waiting → running ↔ paused → finished`, with `cancelled`
reachable from any non-terminal status. Every transition is validated
server-side (`POST /api/sessions/:id/{open,start,pause,resume,stop,cancel}`,
teacher-only) and applied as an atomic, race-safe DB update.

**Synchronized playback**: on Start, the server picks a *future*
timestamp and broadcasts it (`scheduled_start`) ahead of time along with
the item's playback plan, so every client can preload and then begin
playback **locally, at that absolute server timestamp** — corrected for
each client's own estimated clock offset (a single ping/pong round
trip) — rather than reacting to when the message happens to arrive.
The server's own timer fires at the same instant to open the
authoritative answer window (`item_active`, with a server-computed
deadline) and, later, to close it and auto-advance to the next item.

**Realtime hub** (`server/src/realtime/hub.js`): a `ws.Server` on `/ws`,
authenticated via the same session cookie as the rest of the app. One
room per session, shared by the teacher's monitor and joined students.
Handles `monitor_session`, `join_session`, `set_ready`, and `ping`; a
join (fresh or reconnect) is always re-sent the session's current
authoritative state, so a page refresh or a dropped LAN connection
never leaves a client trusting stale local state.

**Formal tests**: the same session machinery with `type: 'test'` and
extra config (preparation time, answer time, allowed attempts, pass
threshold) — the only real differences from group practice are
enforcing `allowedAttempts` and withholding score/grade from the
student until the test reaches `finished`.

**Endpoints** (`/api/sessions`, all `requireAuth`):
- `POST /` / `GET /` (teacher) — create (also generates+persists all
  items) / list own sessions
- `GET /available` (student) — open sessions for their own class
- `GET /:id`, `GET /:id/results` — role-scoped (teacher sees everything;
  a student sees only their own, withheld mid-test)
- `POST /:id/items/:itemId/attempts` (student) — validated against the
  currently-active item and server-computed deadline, graded immediately
  via the existing `scoring.js`

**UI**: `teacher.html` now links to the (previously unreachable)
`sessions.html`, extended with a session-type selector, formal-test
settings, a live-progress panel, and a results table. A brand-new
`group-session.html` gives students a join → ready → countdown →
answer → results flow, reusing the existing `MorseAudioPlayer` (which
gained one small addition, `unlock()`, to satisfy the browser's
autoplay-gesture requirement ahead of the server-scheduled playback
trigger).

See `docs/checkpoints/phase-8-checkpoint.md` for full implementation
detail, exact tests performed, and known limitations (most notably: an
in-memory scheduler means a server restart mid-session loses its
timers, and pause/resume restarts the current item rather than
resuming mid-playback).

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
│   │   │   ├── sessions/             group sessions + formal testing: engine, repository, runtime scheduler, HTTP routes (Phase 8)
│   │   │   ├── grading/              empty placeholder (grading is handled inline in sessions/ for now — see Phase 8 checkpoint)
│   │   │   └── stats/                empty placeholder (later phase)
│   │   ├── realtime/               WebSocket hub — /ws, session rooms, broadcasts (Phase 8)
│   │   └── server.js               entry point
│   ├── data/                      SQLite database file (gitignored)
│   └── logs/                      server.log (gitignored)
├── client/
│   └── public/                    static pages, css/, js/ (plain HTML/JS, no framework/build step)
│       ├── group-session.html      student group-session/test UI (Phase 8)
│       └── sessions.html           teacher group-session/test dashboard (Phase 8)
└── docs/checkpoints/               one file per phase checkpoint
```
