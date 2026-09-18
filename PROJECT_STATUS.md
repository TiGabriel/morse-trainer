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



\*\*PHASE 10 — FORMAL TESTING SYSTEM — COMPLETE.\*\*



Re-inspected the existing formal-test system (`type: 'test'` sessions,

already built in Phase 8, already timing-hardened in Phase 9) against

the full Phase 10 requirement list line-by-line before writing any

code. Almost everything required was already implemented and already

tested — teacher create/configure/start/monitor/finish/results,

student join/countdown/playback/timed-submit/completion,

server-authoritative timing/grading/persistence, and every listed

security rule. Found and closed exactly four real, concrete gaps: (1)

no way to restrict a test to specific students rather than the whole

class — added an optional participant list, validated server-side,

enforced through every roster/availability/results/join check; (2) no

teacher-authored instructions field or student-facing display for one;

(3)-(4) Farnsworth WPM, tone frequency, and item-length were already

accepted by the backend but never exposed in the `sessions.html`

creation form. All four verified end-to-end with a real browser driving

the real create-session form (not just the API). 11 new/updated

automated tests (153/153 total passing). See

`docs/checkpoints/phase-10-checkpoint.md` for full detail and honest

limitations (no richer grading-rule editor than a pass threshold, no

manual radiogram entry — both pre-existing gaps, not regressions).



\*\*PHASE 11 — COMPLETE APPLICATION, SECURITY \& STATISTICS — COMPLETE.\*\*



A focused audit of the whole application (not a rebuild) looking for

what was actually incomplete or inconsistent before classroom

deployment. Found and fixed real, concrete issues rather than

re-touching working functionality: (1) async route handlers could hang

a request forever on a rejected promise (bcrypt/DB errors) — added a

global `asyncHandler` wrapper plus a global JSON error middleware and

an `/api` 404 catch-all, so every failure now returns a clean JSON

error instead of a stack trace or a hang; (2) login had no

brute-force protection — added a per-username in-memory rate limiter

(429 after repeated failures, reset on success); (3) session creation

could leave an orphaned session row if item generation failed midway,

and never checked that the submitted `classId` actually existed —

both fixed with a real `classId` existence check and a single atomic

`createSessionWithItems` transaction; (4) an expired/revoked session

cookie left the teacher and student dashboards silently broken

instead of sending the user back to log in — added consistent 401

handling across every client page; (5) a dropped WebSocket connection

gave no visible indication to either a monitoring teacher or a

mid-session student — added a reconnecting banner on both. Built a

new statistics module from scratch (`server/src/modules/stats/`) —

deliberately limited to what the schema can actually support

honestly: practice accuracy/attempt counts, a 10-attempts-minimum

"recent trend," per-day accuracy, and finished-session pass rates —

with every "no data yet" case returning `null`/an empty list rather

than a fabricated `0%`, and a "most commonly confused characters"

metric explicitly *not* built because no code path persists

per-character diff detail. Also fixed a real bug caught by the new

tests themselves: `asyncHandler` only caught promise rejections, not

a synchronous throw from the wrapped handler. 22 new automated tests

(175/175 total passing), plus a full real-browser (Playwright)

end-to-end pass covering the entire teacher/student group-session

workflow, unauthorized-action checks, invalid input, and

cleared-session recovery (36/36 checks passing). See

`docs/checkpoints/phase-11-checkpoint.md` for full detail and honest

limitations (formal-test flow re-verified only via existing automated

tests this phase, not re-driven through a real browser; no live

LAN-disconnect simulation of the new reconnect banners).



\## Current task



Phase 11 is complete. Waiting for explicit direction before starting

Phase 12 (Windows Deployment \& Final LAN QA).



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



