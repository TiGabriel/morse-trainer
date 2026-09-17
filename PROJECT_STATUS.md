\# Morse Training Platform — Project Status



\## Project



LAN-only Morse/radiogram training platform for a military classroom.



The teacher's Windows PC is the only machine running the application/server.



Students connect using Chrome/Edge over the local LAN.



No student PC should require Node.js, npm, SQLite or application installation.



Example:

`http://TEACHER-PC-IP:PORT`



\## Architecture



\* Self-hosted

\* LAN-only

\* Offline at runtime

\* Node.js (Express) backend

\* Plain static HTML/CSS/vanilla JS frontend (NOT React — corrected as of

  the Phase 8 audit; earlier drafts of this document said React, but the

  actual `client/public/` has always been server-rendered static pages,

  no build step, no bundler, no framework)

\* SQLite database (`better-sqlite3`, WAL mode)

\* WebSockets for realtime communication (`ws`, one hub at `/ws`, added in Phase 8)

\* Modular monolith

\* Teacher PC = server + teacher workstation

\* \~20 simultaneous student clients (smoke-tested with 6 concurrent

  WebSocket+HTTP clients through a full session lifecycle; see the

  Phase 8 checkpoint for why this is representative)



No:



\* CDN

\* Google Fonts

\* external APIs

\* cloud database

\* analytics

\* telemetry

\* internet dependency



\## Core functionality



The application is designed around:



Teacher configures/generates Morse radiogram

→ server distributes/manages session

→ students hear Morse

→ students type answer

→ server scores answer

→ result is stored

→ teacher can view results



The system supports:



\* individual practice

\* group training

\* formal testing



\## Roles



\### Teacher



\* manage students

\* manage classes

\* configure Morse sessions

\* start/pause/resume/stop group sessions

\* monitor students

\* view results/statistics

\* configure grading



\### Student



\* login

\* participate in training/tests

\* hear Morse

\* submit answers

\* view own results/history



Students must not be able to modify official session/test state, scores, configuration or other students' data.



\## Morse functionality



Configuration includes:



\* WPM

\* Farnsworth spacing

\* tone frequency

\* difficulty

\* character set

\* letters/numbers/punctuation

\* radiogram length

\* spacing/timing



Supports generated and manually entered radiograms.



Morse audio should be prepared/preloaded before synchronized playback where necessary.



\## Synchronization architecture



The server is authoritative.



Do NOT use:

"teacher clicks Start → browser immediately plays."



Instead:



1\. Server validates Start.

2\. Server chooses a future timestamp.

3\. Server broadcasts authoritative state + scheduled start.

4\. Clients synchronize/estimate clock offset.

5\. Clients preload required data/audio/timing.

6\. Clients schedule playback for the future server timestamp.

7\. Server remains authoritative.

8\. Reconnecting clients resynchronize from server state.



\## Development history



The project originally had many small development phases.



\*\*PHASE 8 — GROUP SESSIONS + FORMAL TESTING — COMPLETE.\*\*



Previous phases established:



\* project foundation

\* authentication/accounts

\* Morse engine

\* individual practice

\* persistence/grading (schema only, until Phase 8 actually used it)

\* teacher dashboard

\* Morse audio playback engine



Phase 8 (this round) implemented, on top of all of the above without

rebuilding any of it:



\* group session creation, teacher controls (open/start/pause/resume/stop/cancel)

\* an explicit server-authoritative 6-state machine (created/waiting/running/paused/finished/cancelled)

\* a new WebSocket realtime hub (`server/src/realtime/hub.js`) — the

  previous placeholder folder is now implemented

\* scheduled, server-authoritative synchronized playback (future

  timestamp + client-side clock-offset correction — never "message

  arrives, play immediately")

\* student session UI (`group-session.html`), including a waiting room,

  readiness, countdown, synchronized playback, timed submission, and a

  results screen — this didn't exist before Phase 8 at all

\* teacher live monitoring (extended the pre-existing but previously

  unreachable `sessions.html`/`sessions.js`)

\* reconnect/resync (both WS auto-reconnect and a full page-refresh

  recovery path, backed by the hub re-sending current authoritative

  state on every join)

\* server-side authorization throughout (every mutation re-validated

  against the requester's actual role/class/session, never trusted from

  the client)

\* formal testing extended onto the same session machinery: configurable

  prep/answer time, allowed attempts, pass threshold, and deferred score

  reveal until the test ends

\* automated tests (113/113 passing) plus extensive manual/scripted

  end-to-end and concurrency testing — see

  `docs/checkpoints/phase-8-checkpoint.md` for the full detail, honest

  limitations, and exactly what was and wasn't automated



See `docs/checkpoints/phase-8-checkpoint.md` for the complete record —

this section is intentionally just a summary.



\*\*PHASE 9 — SYNCHRONIZED MORSE PLAYBACK — COMPLETE.\*\*



A narrowly-scoped hardening pass on exactly the Phase 8 playback

mechanism (no formal-testing/statistics/UI/deployment work, per that

phase's explicit scope limit). Found and fixed a real, previously

unverified bug: the scheduled-playback trigger could silently never

fire at all on a fast LAN, because the server's `item_active` broadcast

raced against — and could suppress — the client's own countdown-based

play() trigger. This was only caught by actually driving real browser

instances through the flow (Playwright, multiple simultaneous browser

contexts), which Phase 8 had not done. Also: multi-sample

(median-of-3) clock-offset estimation replacing a single ping/pong

sample, and a fix so a student reconnecting mid-item always gets a

clear, working way to start audio (previously the control stayed

hidden). 29 new automated tests added (142/142 total passing). See

`docs/checkpoints/phase-9-checkpoint.md` for full detail, including the

honest limitation that real multi-machine LAN timing still hasn't been

measured (only same-machine multi-browser-context testing was possible

here).



\## Current task



Phase 9 is complete. Waiting for explicit direction before starting

Phase 10.



\## Important development rules



Before coding:



1\. Inspect the existing project.

2\. Read README.md.

3\. Read PROJECT\_STATUS.md.

4\. Inspect database/schema.

5\. Inspect backend.

6\. Inspect frontend.

7\. Inspect WebSocket implementation.

8\. Inspect Morse/audio implementation.

9\. Inspect tests.

10\. Determine what Phase 8 is already implementing.



Do NOT:



\* rebuild the project

\* rewrite working functionality

\* create duplicate systems

\* replace the architecture unnecessarily

\* introduce microservices

\* introduce internet dependencies

\* use fake/mock production functionality



Reuse the existing implementation.



After Phase 8:



\* update this file

\* document what was actually implemented

\* document tests performed

\* document known limitations

\* STOP and wait for the next phase



Do not automatically proceed to Phase 9.



\## Next roadmap



After Phase 8 (now complete — see `docs/checkpoints/phase-8-checkpoint.md`),

development continues in larger milestones. Formal Testing's core

(configured tests, timed items, attempt limits, pass/fail grading,

deferred reveal, results persistence) was pulled forward and already

built as part of Phase 8, so Phase 9 below should be scoped against

what's actually implemented now, not the original assumption that it

was untouched:



Phase 9 — remaining Formal Testing / assessment polish not already covered

by Phase 8 (e.g. participant selection UI, richer grading-rule

configuration beyond a single pass threshold, teacher-side test review

tooling)



Phase 10 — Complete Teacher \& Student Experience



Phase 11 — Reliability, Security, Statistics \& Backup



Phase 12 — Windows Deployment \& Final LAN QA



