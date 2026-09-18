# PROJECT CHECKPOINT — Phase 9: Synchronized Morse Playback

## Current phase
Phase 9 — a focused hardening/verification pass on the synchronized
group-session playback mechanism Phase 8 built. Scope was deliberately
narrow (per the brief): no formal-testing changes, no statistics, no UI
redesign, no deployment work. The server-authoritative scheduling
architecture, WebSocket hub, and Morse engine integration were **not
rebuilt** — they were inspected, then extended/fixed in place.

## Starting point (inspection findings)
Re-inspected the exact Phase 8 implementation before writing anything:
`sessionRuntime.js` (scheduled-start/deadline scheduling),
`realtime/hub.js` (WS rooms, resync-on-join), `group-session.js` (client
countdown/playback), `sessionsController.js` (transition + submission
authorization), and `morse-audio-player.js` (`unlock()`). All of it
matched the Phase 8 checkpoint's description exactly — no drift.

What the inspection did **not** surface, because Phase 8 never actually
rendered the client in a real browser, was a real bug in the
countdown-to-playback trigger (see "Critical bug found and fixed"
below) — found only once this phase's multi-browser verification
actually drove real Chromium instances through the flow.

## Implemented / changed

**Clock synchronization** (`client/public/js/clock-sync.js` — new)
- Extracted the offset-estimation arithmetic into a small, dual-exported
  pure module (`window.ClockSync` for the browser, `module.exports` for
  this file's own Node unit tests — one implementation, not two that
  could drift apart).
- `estimateOffsetFromPong(clientSentAt, serverTime, clientReceivedAt)` —
  the same half-RTT model as Phase 8, now testable in isolation.
- `medianOffset(samples)` — new. `group-session.js` now sends a burst of
  3 pings (not one) on connect, and again right when `scheduled_start`
  arrives (freshest possible reading right before it matters most), and
  takes the median of the last 5 samples rather than trusting a single
  round trip. Median specifically chosen over mean so one slow/blocked
  sample can't skew the estimate (verified by a dedicated test).

**Critical bug found and fixed: the scheduled-playback trigger could
silently never fire on a fast LAN**
- Root cause: `onItemActive()` (fired by the server's real `item_active`
  broadcast) used to unconditionally set `scheduledStartAt = null`. That
  message arrives at essentially the same instant the client's own
  countdown independently reaches zero — because both are anchored to
  the same server timestamp. The countdown's `setInterval` only checks
  every 150ms, so if `item_active` won that race (which it reliably did
  once server and client are on the same fast LAN — the *better* the
  synchronization, the *more certain* the bug), the very next tick would
  see `scheduledStartAt === null`, skip the playback branch entirely,
  and `beginScheduledPlayback()` — and therefore `MorseAudioPlayer.play()`
  — would never be called. Audio would simply never play, silently, for
  every student, every time.
- This was **not** caught by Phase 8's testing, because Phase 8 verified
  the WebSocket/HTTP message flow (via `curl` and raw `ws` scripts) but
  never actually executed `group-session.js` in a real browser DOM. It
  was caught by this phase's Playwright multi-client test (see Testing),
  which is exactly the kind of bug that class of test exists to catch.
- Fix: `scheduledStartAt` is no longer nulled by `onItemActive`.
  Triggering playback is now guarded solely by a `hasPlayedCurrentItem`
  flag, checked independently on every countdown tick regardless of
  whether the deadline is already known — so whichever of "local
  countdown reaches zero" or "item_active message arrives" happens
  first, playback still triggers on the very next 150ms tick either way.
- Re-verified with the same multi-browser test after the fix: all 3
  simulated students called `MorseAudioPlayer.play()` within a
  **measured 0ms window of each other** (see Testing — same-machine
  loopback, not real network latency, but proves the mechanism itself no
  longer races against its own correctness).

**Browser audio restrictions — reconnect-into-active-item gap fixed**
- Found (by inspection, before even running the browser test) that a
  student resyncing directly into an already-playing item (fresh join
  mid-item, or a reconnect after refresh) never got a way to actually
  hear the audio — `onItemActive`'s resync path loaded the playback plan
  but never showed the Replay control, since that was previously only
  unhidden by the normal auto-play path.
- Fixed: `onItemActive` now distinguishes a genuine resync
  (`currentItemIndex !== msg.itemIndex || currentItem === null`) from a
  normal activation. On a genuine resync, it immediately shows a
  clearly-labeled "▶ Play" button plus an explicit feedback message
  ("This item is already playing for the class — press Play to hear
  it.") — satisfying "the UI should clearly communicate when the student
  needs to enable/start audio" for exactly the case where no user
  gesture happened at the activation instant. The button relabels to
  "↻ Replay" once actually pressed (or once the normal scheduled
  playback has run). Verified live via the Playwright reconnect test.

**Teacher controls connected to synchronized playback** (verified, one existing wiring, no new controls added)
- Confirmed live (Playwright): a teacher's **Stop** action mid-item
  immediately transitions the session to `finished`, broadcasts
  `session_finished`, the student's `MorseAudioPlayer.stop()` fires
  client-side, and their UI moves off the exercise screen to the
  results screen — a subsequent `cancel` correctly gets `409` (already
  terminal). **Pause/resume** and **start** were already covered by
  Phase 8's automated tests and re-verified by this phase's new
  `sessionRuntime.test.js`. No new teacher controls were added, per the
  phase's explicit scope limit.

## Files changed
```
client/public/js/clock-sync.js                                    (new)
client/public/js/group-session.js                                 (modified — race fix, resync-audio fix, multi-sample offset)
client/public/group-session.html                                  (modified — added clock-sync.js <script> tag)
server/src/realtime/__tests__/clockSync.test.js                    (new)
server/src/modules/sessions/__tests__/sessionRuntime.test.js       (new)
server/src/modules/sessions/__tests__/sessionsController.test.js   (new)
docs/checkpoints/phase-9-checkpoint.md                             (new)
```
No changes to `sessionEngine.js`, `sessionRepository.js`, `sessionRuntime.js`
(server), `hub.js`, `sessionsController.js`, or the DB schema — the
server-authoritative architecture from Phase 8 needed no structural
changes, only the client-side race fix above and new test coverage.

## Tests performed

**Automated (`node --test`, via `npm test`)**: full suite **142/142
passing** (113 prior Phase 8 baseline + 29 new):
- `clockSync.test.js` (9 tests) — offset math against known inputs
  (ahead/behind clock, pure-latency-no-skew case), median vs. mean
  outlier robustness, order-independence, empty input.
- `sessionRuntime.test.js` (5 tests) — against a real isolated temp DB
  with mocked `hub.broadcast`: `scheduled_start` broadcasts a future
  timestamp with the full item payload and never the expected answer;
  a full single-item lifecycle produces exactly
  `scheduled_start → item_active → item_closed → session_finished`, in
  order, ending in DB status `finished` and cleaned-up runtime state; a
  2-item session auto-advances after the inter-item gap; pause freezes
  progress (no `item_active` while paused) and resume broadcasts a
  fresh `scheduled_start` for the *same* item, not the next one; and —
  directly answering the brief's "stale/invalid playback commands" and
  "server-authoritative timing" asks — a timer that fires after the
  session was cancelled out-of-band (without going through
  `haltSession`) is proven to do nothing, because the authoritative
  status check lives in the timer callback itself, not just in whether
  something remembered to clear the timer.
- `sessionsController.test.js` (15 tests) — `submitAttempt` against a
  real temp DB with mocked `sessionRuntime.getRuntimeState`: accepts a
  valid submission; rejects an item that is no longer current; rejects
  past the server deadline (and grace window testing both sides of the
  boundary); rejects when no runtime state exists at all (server
  restarted mid-session); enforces `allowedAttempts` server-side;
  rejects a non-running session; rejects a teacher role; rejects a
  student outside the session's class; formal tests withhold
  score/answer. Plus transition-handler tests: legal transitions invoke
  exactly the right `sessionRuntime` hook, illegal ones return `409`
  and never touch the scheduler, and a double-`cancel` is rejected.

**Manual/scripted, real multi-browser (Playwright, ad-hoc verification
tooling — not added as a project dependency, consistent with how Phase
8 used real `curl`/`ws` scripts rather than a mocked HTTP layer)**:
- **3 simultaneous real Chromium browser contexts** (separate
  cookies/sessions, one per student) joined, readied (which also
  unlocked each one's `AudioContext`, confirming the gesture-timing
  design actually works in a real browser, not just in theory), and the
  teacher started the session via the real API. Instrumented
  `MorseAudioPlayer.prototype.play` in each context to record the exact
  local timestamp of every play trigger. **This is what caught the race
  condition above** — before the fix, 0/3 clients ever played;
  after the fix, 3/3 played within a measured 0ms spread.
- **Reconnect mid-item**: reloaded one student's page while their item
  was actively playing/answerable; confirmed it correctly restored the
  exercise screen (not the session list), showed the item's real prompt
  (not a stale placeholder), and displayed the fixed "▶ Play"
  control + explanatory message rather than a silently non-functional
  screen.
- **Teacher Stop mid-item**: confirmed a real Stop command finishes the
  session, broadcasts to the connected student, stops their audio
  player, and moves their UI to the results screen; a subsequent Cancel
  correctly gets `409`.
- **Explicit limitation, exactly as the brief asked to note**: all of
  the above ran on **one machine, one Chromium process, multiple browser
  contexts** — not physically separate student PCs on a real classroom
  LAN. This measures the *mechanism's* correctness (does the scheduling
  math and race-free trigger logic work at all) and near-zero-latency
  behavior, but says nothing about real network jitter, real Wi-Fi/
  Ethernet variance across ~20 physical machines, or real audio hardware
  differences. That specific measurement — actual playback-start skew
  across real, separate classroom computers — has still not been done
  and needs real hardware to do.

## Known limitations
- **Real multi-PC network measurement not possible in this environment**
  (see above) — the 0ms figure is a same-machine-loopback result, not a
  LAN-jitter result. The synchronization *design* (future timestamp +
  clock-offset correction, never message-arrival-triggered) is sound and
  is what the brief asked for; its real-world tightness across ~20
  distinct machines on a classroom Wi-Fi/Ethernet segment is untested.
- **Server-restart mid-session still loses in-memory scheduling** —
  unchanged from Phase 8, still the correct/accepted tradeoff (see the
  Phase 8 checkpoint).
- **Pause/resume still restarts the current item from the beginning**,
  not from the exact interruption point — unchanged from Phase 8, and
  confirmed still working exactly as documented by the new
  `sessionRuntime.test.js` pause/resume test.
- **A resync mid-item doesn't yet track "did I already submit"
  across a reload** — the client-side UI gap noted in Phase 8 as a minor
  rough edge (the server still correctly rejects a duplicate submission
  with `429`) is unchanged; out of this phase's narrow scope.
- **Clock-offset estimation is a single ping/pong-burst model** (3
  samples, median), appropriate for a single-switch LAN with sub-10ms
  typical latency. It does not continuously re-sample during a long
  multi-item session (only at connect and at each `scheduled_start`) —
  deemed sufficient for the classroom's short session durations and
  explicitly avoids the "unnecessarily complicated distributed clock
  system" the brief warned against building.

## Anything that needs attention before Phase 10
- **The playback-trigger race fix is the one item that should get real
  hardware verification before this is trusted in an actual classroom.**
  It is now provably correct in the same-machine test and by
  construction (the fix removes the race by design, not by tuning
  timing), but real ~20-machine LAN behavior — with real, non-zero,
  variable latency — has not been observed. Recommend at least a
  small real-hardware pilot (2-3 actual laptops on real Wi-Fi) before
  a full classroom rollout.
- No other action items block Phase 10. The server-authoritative
  architecture, state machine, and grading pipeline are unchanged from
  Phase 8 and remain fully covered by the existing test suite.

## Next phase
Not yet specified by the user beyond "do not start Phase 10
automatically." Per the original roadmap this would be Phase 10
(Complete Teacher & Student Experience) — its actual remaining scope
should be evaluated against what Phases 8-9 already built, not assumed.
