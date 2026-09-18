# PROJECT CHECKPOINT — Phase 12: Windows Deployment & Final LAN QA

## Current phase
Phase 12 — the final phase. The application was already functionally
complete after Phase 11; this phase's job was to prepare it for real
classroom use on 1 Windows teacher PC + ~20 student PCs on a private
LAN, verify every deployment-relevant claim by actually testing it
rather than assuming it, and fix concrete issues found along the way —
not to add features.

## What was verified, and how

### 1. Windows startup
Created a root-level **`START SERVER.bat`** (the brief's preferred
entry point) that checks Node.js is installed, runs `npm install`
automatically only on first run (the one moment that needs internet),
sets `NODE_ENV=production`, and starts the server. `scripts/start.bat`
now delegates to it for backwards compatibility. Verified for real: the
server was started from a genuinely empty `server/data/` directory
(moved aside, not deleted) three separate times across this phase,
each time producing identical, correct output — schema applied,
initial teacher account created (random password written to
`INITIAL_TEACHER_CREDENTIALS.txt`, file mode `0600`), WebSocket hub
attached, bound to `0.0.0.0:8080`, LAN URL printed. Confirmed reachable
on the machine's actual LAN-detected address (`192.0.2.2`), not just
`localhost`.

### 2. Student access
Confirmed by direct inspection and by every Playwright test this phase
(and prior phases): the student-facing pages are plain static
HTML/CSS/JS served by Express — no Node.js, npm, SQLite, or project
files of any kind are needed on a student machine, only a browser
pointed at `http://<TEACHER-LAN-IP>:<PORT>`. Documented in README.md's
new "Classroom Deployment" section, including the exact URL format and
what students explicitly do *not* need.

### 3. Windows Firewall
Added **`OPEN FIREWALL PORT.bat`** (must be run as Administrator),
which adds one inbound rule — `netsh advfirewall firewall add rule ...
profile=private` — allowing TCP port 8080 on **private networks only**,
verified by reading its exact command against Microsoft's documented
`netsh advfirewall` syntax. It does not disable the firewall or touch
any other rule. Documented three ways to achieve the same thing (the
first-run Windows prompt, this script, and the manual GUI/CLI steps)
in README.md.

### 4. Offline dependency audit
Grepped the entire `client/` and `server/src/` trees for `https?://`,
`<link>`/`<script>` tags, `@import`/`@font-face`, CDN/Google
Fonts/analytics/telemetry identifiers, and any outbound `fetch`/HTTP
client usage. Result: **zero** external references anywhere — every
script/stylesheet tag is a relative local path, every dependency is one
of the 5 npm packages already vendored into `node_modules` (bcryptjs,
better-sqlite3, cookie-parser, dotenv, express, ws), and the server
makes no outbound network calls at all. Nothing needed fixing here;
the app was already fully offline-capable at runtime.

### 5. Clean deployment test
With `server/data/` moved aside (not deleted) to simulate a genuinely
new machine, ran the full real-browser flow end-to-end via Playwright:
teacher login → create a class → create 2 students → **group session**
(join, ready, synchronized playback, answer, submit, auto-completion)
→ **formal test** (same flow, plus deferred score reveal, a correct
answer graded `pass` and a wrong one graded `fail`) → teacher sees both
students' graded results. Then the server was stopped and restarted
(simulating a teacher-PC reboot) and every session, attempt, result,
and user account was confirmed still present and correct via a direct
database query — proving persistence is real, not in-memory. **14/14
checks passed** on the corrected script (the first pass had a bug in
the *test script itself* — it read the session list in the wrong
order and graded Ann against the wrong item; found, diagnosed, and
fixed before trusting the result, per this project's established
practice of never assuming a failure is the product's fault without
checking the test first).

### 6. Classroom-scale simulation
20 concurrent student browser contexts (the exact number the brief
asked for) were driven through login → join → ready → synchronized
playback → answer → submit → completion, with the teacher monitoring
live throughout, all in one run. **7/7 checks passed**: all 20 logged
in and readied, the teacher's monitor correctly showed "20 / 20"
connected, all 20 received the synchronized item and answered within
~5.6 seconds of it activating, all 20 reached the completion screen,
and the teacher's results table showed all 20 rows. 20 Chromium browser
contexts used well under 1GB of the sandbox's 15GB available memory —
no resource strain observed at this scale.

### 7. Failure/recovery testing
Against a real 3-item group session with 2 students:
- **Page refresh mid-item** (Ann): confirmed she automatically recovers
  onto a live session screen with no manual action, via the existing
  `sessionStorage`-backed rejoin logic.
- **Forced WebSocket close mid-item** (Bob, via a direct `ws.close()`
  call from inside the page — the same event a real network drop
  produces): the "connection lost" banner appeared immediately, cleared
  after the existing ~2s auto-reconnect, and Bob landed back on the
  correct live item via the server's full state resync.
- **Teacher stayed connected throughout**: confirmed the teacher's own
  monitor connection banner never appeared while both students were
  being disrupted.
- **Simulated temporary LAN interruption** (Chromium's browser-level
  `setOffline()` emulation): this did **not** reliably sever an
  already-open WebSocket over loopback within the test window — a
  limitation of this specific test technique in a single-VM sandbox,
  not a product issue, and documented honestly as such rather than
  forcing a false pass. The equivalent real scenario (a WS connection
  actually dropping) was already conclusively proven by the forced
  `ws.close()` test above, which exercises the identical client/server
  recovery code path a real network interruption would.
- The session reached completion for both students despite every
  disruption, and the server's own timers finished the session on
  schedule even when the driving test script itself crashed partway
  through an earlier run — direct evidence the scheduling is genuinely
  server-authoritative, not dependent on any client staying connected.
- **15/16 checks passed** (the one non-pass is the LAN-emulation
  limitation above, not a failure of recovery itself).

### 8. Audio QA
Verified directly against live `player` state in the browser: no
`AudioContext` exists before any user gesture (autoplay-safe); it
reaches `"running"` immediately after the "I'm Ready" click; scheduled
playback fires without error and stays in `"running"` state; the
Replay button can be pressed repeatedly without error or being blocked
(`maxPlays: null` for sessions); a second item gets its own independent
playback; and the practice page's volume slider correctly reaches the
player (confirmed at both 20% and 90%).

**A real, concrete bug was found and fixed here**: the teacher's
"Tone frequency (Hz)" setting — configurable at session creation,
correctly stored in the database, and correctly transmitted to the
client — was never actually applied to the `MorseAudioPlayer` instance
that plays the sound, in *either* individual practice or group/formal
sessions. Both silently always played at the hardcoded 600Hz default,
regardless of configuration (only the teacher's separate Morse Preview
tool applied it correctly). Fixed by (1) adding `toneFrequencyHz` to
the server's `publicItemPayload()` for sessions (it was already present
in the practice-exercise API response), and (2) setting
`player.toneFrequencyHz` from the item/exercise data in both
`group-session.js` and `practice.js` before loading the playback plan.
Re-verified: a session configured for 750Hz now correctly produces an
oscillator at 750Hz. This is a completion of already-existing,
already-UI-exposed functionality, not a new feature.

No uncaught JavaScript exceptions (`pageerror` events) occurred across
any of this phase's real-browser runs, including the 20-student
simulation. **Browser limitation to document**: only Chromium (which
Chrome and Edge are both built on) was tested, matching this
deployment's stated target; Firefox/Safari autoplay-policy differences
have not been verified.

### 9. Backup and restore — actually tested, not just documented
Found a real reliability gap while implementing this: the graceful
shutdown handler never closed the database connection, so the
write-ahead log (`-wal`/`-shm` files) was never checkpointed back into
the main `.db` file on a normal stop — a naive "just copy the .db file"
backup taken after stopping the server could have silently missed
whatever was still sitting in an unmerged `-wal` file. Fixed by adding
an explicit `db.pragma('wal_checkpoint(TRUNCATE)')` + `db.close()` to
the shutdown handler, verified empirically: before the fix, a 4MB
`-wal` file survived a graceful stop untouched; after the fix, stopping
the server merges everything into the `.db` file and removes the
`-wal`/`-shm` files entirely, every time.

Built `scripts/backup.bat` / `scripts/restore.bat` (with root-level
`BACKUP DATABASE.bat` / `RESTORE DATABASE.bat` wrappers) and tested the
**complete round trip for real**: created data, backed it up, added
more data on top, stopped the server, restored the backup, restarted,
and confirmed via the live API that the post-backup data was gone while
everything from the backup point was fully intact. Database location,
backup location, and the exact restore command are documented in
README.md.

### 10. Final security check
Re-verified (not re-built) everything from the Phase 11 security audit
still holds after this phase's changes: every routes module applies
`requireAuth` globally with `requireRole`/`requireSelfOrTeacher` layered
on top where needed; no endpoint exists that isn't backed by real UI
functionality; session tokens are 32 bytes of `crypto.randomBytes`,
SHA-256-hashed before storage; passwords are bcrypt-hashed
(cost 11); no password or secret value appears in any log message
(only descriptive text like "wrong password" or "password reset",
never the value); the `0.0.0.0` bind is intentional and documented;
`server/data/` (database, WAL files, the initial-credentials file, and
now backups) is fully gitignored. **One real gap found and fixed**:
`.gitignore` only covered specific top-level filenames under
`server/data/` and missed the new `backups/` subdirectory and
`.before-restore` files this phase introduced — `git status` would have
offered to commit real backup database files. Fixed by ignoring the
entire `server/data/` directory instead of enumerating file patterns
inside it.

### 11. Final cleanup
Searched for `TODO`/`FIXME`/`HACK`/`debugger;` markers, stray
`console.log`/`console.debug` calls outside the logger's own internals
and the schema-migration announcements, orphaned client JS files not
referenced by any HTML page, and stray debug/scratch scripts —
**found nothing to remove**. The still-empty `grading/` module
placeholder was deliberately left alone (it's documented, intentional
structure from Phase 8 onward, not debug cruft, per this phase's
explicit instruction not to remove things merely because they look
unused).

### 12. Final verification
- `npm test`: **175/175 passing** (unchanged count from Phase 11 — this
  phase's fixes didn't need new unit tests of their own beyond what the
  real-browser QA scripts above already exercised directly; the
  `sessionRuntime.test.js` suite's existing assertions don't pin the
  exact shape of `publicItemPayload()`, so the new `toneFrequencyHz`
  field required no test updates).
- All 9 client JS files pass `node --check` (syntax-only, no bundler in
  this project by design).
- Migration idempotency: `migrate()` run twice back-to-back against the
  same database produced no errors.
- LAN check: the server was confirmed reachable via `curl` against its
  actual detected LAN address (`192.0.2.2:8080`), not only `localhost`.
- Offline check: covered by item 4 above (the dependency audit) —
  there is nothing to disconnect from, since nothing outbound exists.

## Files changed
```
START SERVER.bat, STOP SERVER.bat                          (new, root-level teacher entry points)
BACKUP DATABASE.bat, RESTORE DATABASE.bat                   (new, root-level wrappers)
OPEN FIREWALL PORT.bat                                      (new, root-level wrapper)
scripts/start.bat                                            (now delegates to START SERVER.bat)
scripts/backup.bat, scripts/restore.bat                      (new)
scripts/open-firewall-port.bat                               (new)
server/src/server.js                                         (graceful shutdown now checkpoints WAL + closes the DB)
server/src/modules/sessions/sessionRuntime.js                (publicItemPayload now includes toneFrequencyHz)
client/public/js/group-session.js                            (applies item.toneFrequencyHz to the player before playback)
client/public/js/practice.js                                 (applies exercise.toneFrequencyHz to the player before playback)
.gitignore                                                    (ignores the whole server/data/ directory, not enumerated patterns within it)
README.md                                                     (new "Classroom Deployment" section: startup, student access, firewall, backup/restore, offline verification, known limitations)
docs/checkpoints/phase-12-checkpoint.md                       (this file)
PROJECT_STATUS.md                                             (Phase 12 history entry, marked final)
```
No changes to the Morse engine, the session state machine, scheduled
playback timing logic (only its data payload gained one field), the
database schema, or any test file — this phase was verification and
targeted bug-fixing, not feature work, exactly as scoped.

## Tests performed
Summarized in detail under items 1-12 above. In total across this
phase: **175/175 automated unit/integration tests passing**, plus five
dedicated real-browser (Playwright) verification scripts run against a
live server and a real (non-mocked) SQLite database:
1. Clean-deployment functional test — 14/14 checks
2. Classroom-scale (20-student) simulation — 7/7 checks
3. Failure/recovery testing — 15/16 checks (1 non-pass is a documented
   test-technique limitation, not a product failure)
4. Audio QA — 16/16 checks (after finding and fixing the tone-frequency
   bug)
5. Backup/restore round trip — verified via direct API/DB inspection,
   not a checklist script, but genuinely executed rather than assumed

Every script's own bugs (three were found across this phase — a
session-list ordering assumption, a missing "Start" click, and a
volume-control visibility assumption) were diagnosed and fixed in the
*test script*, not the product, before trusting any result — consistent
with this project's practice throughout every prior phase.

## Known limitations
- **A server crash or teacher-PC restart during a live session loses
  that session's in-memory scheduling state.** The session cannot
  resume mid-item; the teacher would need to cancel it and start a new
  one. Everything already graded/finished, and all practice history, is
  completely safe (it's in the database). This limitation has existed
  since Phase 8 and was not addressed this phase, since fixing it would
  mean building session-state persistence/recovery — real new feature
  work outside this phase's "fix concrete issues, don't add features"
  scope. Flagging it clearly here as the single most significant
  operational risk for the actual classroom.
- **Only Chromium-based browsers (Chrome, Edge) were tested**, matching
  this deployment's stated target audience exactly. Firefox/Safari
  autoplay-policy or WebSocket behavior differences have not been
  verified and could differ.
- **The simulated "temporary LAN interruption" test (item 7 above)
  could not fully validate itself** in this single-VM sandbox — browser
  offline emulation didn't reliably sever an already-open loopback
  WebSocket. The underlying recovery mechanism was still proven via an
  equivalent, more direct test (forcing the same WebSocket-close event a
  real drop would cause), but a genuine two-machine LAN cable-pull test
  has not been performed.
- **Login rate limiting is in-memory and resets on server restart**
  (carried over from Phase 11, unchanged) — an acceptable best-effort
  classroom control, not hardened production security.
- **No richer grading-rule configuration, no manual radiogram entry, no
  saved participant groups** — all carried over unchanged from Phases
  8-10, still true, still not required by any Phase 12 requirement.
- The `.bat` files in this phase were reviewed carefully for correct
  Windows batch syntax (drawing on Windows/`netsh`/`taskkill` documented
  behavior) but **could not be executed on an actual Windows machine**
  in this Linux sandbox — the underlying Node.js startup sequence,
  database checkpoint behavior, and firewall command syntax were each
  verified independently and directly, but the exact `.bat` files
  themselves have not had a real Windows dry run. This is the one piece
  of this phase's verification that is inference from correct
  components rather than an end-to-end test of the literal deliverable
  file, and should be the first thing manually confirmed on the actual
  teacher PC before the first real class.

## Anything that needs attention before real classroom use
- **Do** run `START SERVER.bat` once on the actual teacher PC before
  the first class, specifically to confirm the Windows-specific parts
  (the Node.js detection message, the `npm install` first-run path, and
  the Windows Firewall prompt) behave as documented — these were
  verified by careful review and by testing every underlying piece
  independently on Linux, not by running the literal `.bat` file on
  Windows.
- Decide whether the "lost in-memory session state on crash/restart"
  limitation is acceptable for the real classroom, or whether it
  warrants a future phase.
- Actually create a backup after the first real class and store a copy
  off the teacher PC, per the tested procedure above — a real backup
  schedule, not just a working script, is what protects real student
  data.

## Next phase
None. This was explicitly the final phase per the user's instructions.
No further development phase should begin without new, explicit
direction.
