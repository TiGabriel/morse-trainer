# PROJECT CHECKPOINT — Phase 11: Complete Application, Security & Statistics

## Current phase
Phase 11 — a focused audit of the whole teacher/student application to
find what was actually incomplete or inconsistent before classroom
deployment, and fix it. **Not a rebuild.** Working functionality from
Phases 1-10 (auth, classes/students, individual practice, group
sessions, formal testing, server-authoritative scheduling/grading) was
left alone unless the audit found a concrete, real problem in it.

## Audit findings (what was already solid vs. what needed fixing)
Re-read the whole request/response and WebSocket surface —
`server.js`, every controller, every middleware, the client's `api()`
helpers, and the DB schema/migration path — before writing anything.

Already solid, confirmed by re-reading rather than assumed:
- Password hashing (bcryptjs) and session tokens (SHA-256 hashed in
  the DB, raw token only ever in the client's cookie) — no plaintext
  password or secret anywhere in logs (grepped the whole `logger.*`
  call surface to confirm).
- XSS: every client-side `innerHTML` write is either template-escaped
  via the shared `escapeHtml()` helper or replaced with `.textContent`
  — audited every occurrence across all client JS files.
- Server-side authorization on every existing mutating endpoint
  (`requireRole`, `requireSelfOrTeacher`, class/session ownership
  checks) — already correct, already tested in Phases 8-10.
- The server-authoritative session state machine and synchronized
  playback timing — unchanged and untouched this phase.

Six real, concrete gaps, found by walking the failure paths rather
than the happy paths:
1. **Async route handlers could hang forever.** Express 4 does not
   auto-catch a rejected promise from an `async (req, res) => {}`
   handler — a failed bcrypt call, a thrown DB error, etc. would leave
   the request with no response ever sent, and no error logged.
2. **No brute-force protection on login.** Any number of password
   guesses against any username was accepted with no backoff.
3. **`createSession` didn't validate `classId` existed**, and created
   the session row and its items as two separate, non-atomic
   operations — a mid-way failure (e.g. bad exercise parameters) could
   leave an orphaned session with zero items.
4. **An expired/revoked session cookie broke pages silently.** Every
   client page's `api()` helper threw on a 401 but nothing caught it
   at the top level — the teacher/student would see a page full of
   failed-fetch errors instead of being sent back to log in.
5. **No visible indication of a dropped WebSocket connection.** A
   teacher monitoring a live session, or a student mid-exercise, had
   no way to tell a silent LAN drop from "nothing is happening" until
   something failed outright.
6. **No statistics existed at all** — `server/src/modules/stats/` was
   an empty placeholder directory (a lone `.gitkeep`) despite the
   schema having enough real, reliable data (practice attempts,
   finished-session results) to support honest, useful numbers.

## Implemented

**Reliability: global async error handling** (`server/src/middleware/asyncHandler.js`, `server.js`)
- `asyncHandler(fn)` wraps a route handler so both a rejected promise
  and a synchronous throw are forwarded to `next(err)` — the bug where
  only the promise-rejection path was actually covered (a synchronous
  throw bypassed it entirely) was caught by the wrapper's own test
  suite, not assumed correct; fixed with a `try/catch` around the
  `Promise.resolve(...)` call.
- A global 4-argument error middleware in `server.js` now catches
  every unhandled error application-wide: malformed JSON body → `400`,
  everything else → a generic `500` with no stack trace ever sent to
  the client (only logged server-side).
- An `/api` 404 catch-all returns JSON (`{error: '...'}`) instead of
  falling through to the static file server's HTML 404 page.
- Process-level `unhandledRejection` (logged, process stays up) and
  `uncaughtException` (logged, then a clean `process.exit(1)` so a
  process manager can restart it) handlers, so nothing fails silently
  or leaves the process in an unknown state.
- Applied `asyncHandler` to the async routes that previously had
  nothing protecting them (`login`, `createUser`, `resetPassword`).

**Security: login rate limiting** (`server/src/modules/auth/loginRateLimiter.js`, `authController.js`)
- Per-username (case-insensitive) in-memory counter: 10 failed
  attempts within a 15-minute rolling window returns `429` before even
  checking the password; a successful login clears the counter.
- Deliberately in-memory, not persisted — acceptable for a
  single-process LAN classroom server (documented as a limitation
  below), and avoids adding a new storage dependency for a
  best-effort throttle.

**Reliability + security: `createSession` hardening** (`sessionRepository.js`, `sessionsController.js`)
- `classId` is now checked against `classRepository.findById()` before
  anything else — a nonexistent class returns `400` instead of
  silently creating a session no student's class will ever see.
- `createSessionWithItems(data, items)` wraps session creation and
  item insertion in one `better-sqlite3` transaction (nested via
  automatic savepoints, since item insertion was already its own
  transaction) — if item generation/insertion fails partway, the
  session row is rolled back too, so a failed creation never leaves an
  orphaned, itemless session behind.

**Usability: 401 handling + connection status indicators** (every client JS file, `group-session.html`/`.css`, `sessions.html`/`.css`)
- Every page's `api()` helper now redirects to `/` on a `401` instead
  of leaving the caller to throw into a dead page. For the shared
  classroom-PC case, `group-session.js` also clears its
  `sessionStorage` "which session am I in" marker on a 401, so the
  next student to log in on that PC never gets auto-rejoined into
  someone else's session.
- A `connection-banner` element on both the student group-session page
  and the teacher's session-monitor view: hidden while the WebSocket
  is open, shown the moment it closes (before the existing 2-second
  auto-reconnect timer fires), hidden again on a successful reconnect.

**Statistics** (`server/src/modules/stats/` — built from nothing)
- `statsRepository.js`: `getStudentPracticeSummary`,
  `getStudentAccuracyByDay`, `getStudentSessionSummary`,
  `getClassPracticeSummary`, `getClassSessionSummary`,
  `getClassStudentBreakdown`. Every one of these was checked against
  what the schema can actually support before being written — a
  "most commonly confused characters" metric was **not** implemented
  because no code path anywhere persists per-character diff detail,
  and building it would mean fabricating a metric the data can't
  back.
- The "null vs. zero" rule applied everywhere: a student/class with no
  attempts yet gets `null`/an empty array, never a fabricated `0%`
  that could be misread as "attempted and failed everything." A
  "recent trend" only appears once a student has 10+ practice
  attempts — below that, `recentTrend` is `null` rather than a
  trend computed from too little data to mean anything.
- Session-based stats are **finished-only**: an attempt on a
  still-`created`/`running` session cannot change any summary,
  verified directly by a test that submits an attempt against an
  unfinished session and asserts the summary is byte-identical before
  and after.
- `statsController.js` / `statsRoutes.js`: `GET
  /api/stats/students/:id` (via `requireSelfOrTeacher`) and `GET
  /api/stats/classes/:id` (via `requireRole('teacher')`) — a student
  can see only their own stats, a teacher can see any class's.
- New `stats.html`/`js/stats.js` teacher dashboard: class summary
  (student count, practice/test/group-session counts and averages,
  pass rate), a clickable per-student breakdown table, and a
  per-student detail panel (accuracy-by-day, recent trend). Every
  missing value renders as `—`, never `0%`.
- `practice.html`/`js/practice.js`: a short, honest progress summary
  ("N attempt(s), X% average accuracy") shown to the student
  themselves, above the Start button, hidden entirely (not shown as
  "0%") until they have at least one practice attempt; refreshed after
  every new submission.

## Files changed
```
server/src/middleware/asyncHandler.js                              (new)
server/src/middleware/__tests__/asyncHandler.test.js                (new, 3 tests)
server/src/modules/auth/loginRateLimiter.js                         (new)
server/src/modules/auth/__tests__/loginRateLimiter.test.js          (new, 6 tests)
server/src/modules/auth/authController.js                           (rate-limit check + record/clear)
server/src/modules/auth/authRoutes.js                                (asyncHandler on login)
server/src/modules/users/usersRoutes.js                              (asyncHandler on createUser/resetPassword)
server/src/modules/sessions/sessionRepository.js                    (createSessionWithItems atomic transaction)
server/src/modules/sessions/sessionsController.js                   (classId existence check; uses createSessionWithItems)
server/src/modules/sessions/__tests__/sessionRepository.test.js     (2 new tests: atomicity + rollback)
server/src/modules/sessions/__tests__/sessionsController.test.js    (1 new test: invalid classId -> 400, no orphan row)
server/src/modules/stats/statsRepository.js                          (new)
server/src/modules/stats/statsController.js                          (new)
server/src/modules/stats/statsRoutes.js                              (new)
server/src/modules/stats/__tests__/statsRepository.test.js           (new, 10 tests)
server/src/server.js                                                 (global error middleware, /api 404, process handlers, mounts stats routes)
client/public/stats.html, js/stats.js                                (new teacher statistics dashboard)
client/public/practice.html, js/practice.js                          (401 handling; progress summary box)
client/public/teacher.html, js/teacher.js                            (401 handling; Statistics nav link)
client/public/sessions.html, css/sessions.css, js/sessions.js        (401 handling; monitor connection banner; Statistics nav link)
client/public/group-session.html, css/group-session.css, js/group-session.js  (401 handling + session-storage cleanup; connection banner)
docs/checkpoints/phase-11-checkpoint.md                              (this file)
PROJECT_STATUS.md                                                    (Phase 11 history entry)
```
No changes to the Morse engine, the session state machine, scheduled
playback timing, or the DB schema (no migration bump needed — Phase 11
added no new columns).

## Tests performed

**Automated (`npm test`)**: full suite **175/175 passing** (153 prior +
22 net new): `asyncHandler` forwarding both rejected promises and
synchronous throws (the synchronous-throw case caught a real bug in
the first implementation, fixed before this count); the login rate
limiter's threshold, reset-on-success, case-insensitivity, and
per-username isolation; `createSessionWithItems` persisting correctly
and rolling back the session row when item insertion fails;
`sessionsController.createSession` rejecting a nonexistent `classId`
with `400` and never leaving a row behind; and the full statistics
suite — zero-data students getting `null`/empty rather than fabricated
zeros, practice-summary count/average/trend-gating correctness,
day-grouping, finished-only session filtering (including the
before/after identity check on an unfinished session), an ungraded
group session correctly reporting `passRatePercent: null` rather than
`0`, and class-level aggregation including every active student even
ones with zero data.

**Manual/scripted, real browser (Playwright), against a live server**
— a single end-to-end script drove the entire golden path plus a set
of negative/security checks, all against the real HTTP+WebSocket API
through real page interactions (36/36 checks passing):
- Teacher: log in → create a class → create two students → create a
  group session (audio-to-text, fast WPM/Farnsworth for test speed) →
  open it for joining → start it → watch the roster show both students
  connected → the session auto-finish after both items' timed windows
  → see full class results (2 students × 2 items).
- Student (× 2, separate browser contexts): log in → see the open
  session in the list → join → reach the waiting room → ready up
  (which also unlocks audio per the existing autoplay-gesture design)
  → answer both items within the real server-scheduled countdown/
  answer windows → reach the completion screen → see their own
  per-item results.
- Statistics: after the session finished, the class stats page showed
  the correct student count, `0` practice attempts (honestly, since
  none were done — not a fabricated number), `1` completed group
  session, a real (non-blank, non-`NaN`) average score, and both
  students in the per-student breakdown.
- Unauthorized actions: a student's direct API calls attempting to
  create a class, read another student's stats, and read class-level
  stats each correctly returned `403`.
- Invalid input: a session-creation request missing `classId`, one
  with a nonexistent `classId`, and one with a deliberately malformed
  JSON body each correctly returned `400` rather than a `500` or a
  hang.
- Recovery: submitting an answer to an already-finished session
  correctly returned `409`; clearing a student's cookies and visiting
  a protected page correctly redirected to the login page instead of
  showing a broken dashboard; an unknown API route returned a JSON
  `404` rather than an HTML error page.
- All test fixtures (the "E2E Class" class, its two test students, and
  the session created for this run) were removed from the database
  after the run — the classroom database used for actual deployment
  was left exactly as it started (one `admin` teacher account, no
  other data).

## Statistics implemented (and why nothing more)
Only metrics the existing schema can compute honestly:
- **Practice**: attempt count, average accuracy, a recent-trend
  comparison (last 5 vs. overall) gated at 10+ attempts, accuracy
  grouped by day.
- **Sessions (group + formal test, separately)**: finished-session
  count, average score, and — only where a pass threshold was actually
  configured — a real pass rate. An ungraded group session
  intentionally reports `passRatePercent: null`, not `0`.
- **Class-level**: the above aggregated across every active student in
  a class, plus a per-student breakdown table that includes students
  with zero activity (shown as `—`, not `0%`).

**Explicitly not implemented**: any "most commonly confused
characters" or per-character error-pattern metric. The scoring engine
computes a correct/incorrect/missing/extra diff at submission time for
display, but nothing persists that diff — only the final
accuracy percentage and grade are stored. Building a
"common mistakes" view would mean inventing data the system doesn't
actually have, which is exactly the kind of misleading statistic this
phase's brief said not to create.

## Known limitations
- **Login rate limiting is in-memory, per-process.** A server restart
  clears all counters, and it does not survive a multi-process
  deployment (not applicable here — this is a single-process LAN
  server by design). Acceptable as a best-effort brute-force
  deterrent for a classroom deployment, not a hardened production
  auth system.
- **The formal-test (`type: 'test'`) flow was not re-driven through a
  real browser this phase.** It was already verified end-to-end with
  Playwright in Phase 10 and is covered by unchanged, still-passing
  automated tests; this phase's new real-browser pass exercised the
  group-session flow specifically, since that path shares the exact
  same scheduling/grading/security machinery the formal-test path
  uses (this phase touched neither).
- **No live LAN-disconnect simulation of the new connection
  banners.** They were verified by direct DOM/state inspection (the
  banner shows on WebSocket `close`, hides on `open`) but not against
  an actual dropped network link between two real machines — that
  requires the real multi-PC LAN environment Phase 12 sets up.
- **All limitations already documented in the Phase 8-10 checkpoints
  still apply unchanged**: the in-memory session scheduler is lost on
  a server restart (an in-progress session cannot resume mid-item
  after a crash — it would need to be cancelled and restarted), no
  richer grading-rule editor than a single pass threshold, no manual
  radiogram entry, no saved-group participant convenience.

## Anything that needs attention before Phase 12
- Nothing blocking. The application is coherent end-to-end for both
  roles, the six audited gaps are closed and tested, and statistics
  are real and non-misleading. The full automated suite is green
  (175/175) and the real-browser E2E pass is green (36/36).
- Phase 12 (Windows Deployment & Final LAN QA) should specifically
  validate the two things this phase could not: real multi-machine LAN
  timing/disconnect behavior (the connection banners, WS
  auto-reconnect, and clock-offset correction all need a real network
  between real machines, not same-machine browser contexts), and
  server-restart recovery of an in-progress session (currently: it
  cannot resume, and the teacher would need to cancel and start a new
  one — worth deciding whether that's acceptable for the actual
  classroom or needs addressing before deployment).

## Next phase
Not yet specified by the user beyond "do not begin Windows deployment
or final LAN deployment work yet — that is Phase 12." Waiting for
explicit direction to start Phase 12.
