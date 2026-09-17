# PROJECT CHECKPOINT — Phase 6: Morse Audio Engine

## Current phase
Phase 6 — converting Morse data into playable, fully-offline audio in the
browser, plus a teacher preview tool built on a reusable player component.
Explicitly does NOT implement the full testing system (grading, session
enforcement) — only the audio engine and a manual preview screen.

## Implemented features

**Playback plan (server, `morse-engine` module)**
- `playbackPlan.js`: `buildPlaybackPlan(morse, timing)` — pure function
  turning a Morse string + a `computeTiming()` profile into a flat,
  ordered list of `{type:'tone', symbol, durationMs}` /
  `{type:'gap', kind, durationMs}` segments. Built on a newly-extracted
  shared parser (`morseParse.js`) also used by `computeSequenceDurationMs`,
  so the two can never silently disagree about a sequence's timing.
- `planTotalDurationMs(plan)` — sums a plan; guaranteed equal to
  `computeSequenceDurationMs` for the same input (asserted in tests).

**HTTP layer (teacher-only)**
- `POST /api/morse/preview` — body `{text, wpm, farnsworthWpm?,
  toneFrequencyHz?}` → `{text, morse, timing, plan, durationMs,
  invalidCharacters}`. All computation reuses the existing, already-tested
  Phase 5 engine; no audio is generated server-side.
- `GET /api/morse/random?difficulty=&seed=` — generates random training
  text via the Phase 5 `generateFromDifficulty`, for previewing
  "generated" audio, not just typed text.
- Both routes: `requireAuth` + `requireRole('teacher')`.

**Reusable audio player (browser, `client/public/js/morse-audio-player.js`)**
- `MorseAudioPlayer` class, built on the Web Audio API — zero audio
  files, zero network requests for sound.
- **Ahead-of-time scheduling**: on `play()`, every oscillator's
  start/stop time for the *entire* plan is computed and handed to the
  Web Audio graph in one pass (using `audioContext.currentTime` +
  cumulative segment offsets), not driven by chained `setTimeout`s —
  avoiding main-thread jitter, and matching the project's "prepare ahead
  of playback" design principle from the original architecture notes.
- Configurable tone frequency, live-adjustable volume (master `GainNode`),
  and a short (default 5ms) linear attack/release envelope on every tone
  to avoid audible clicks — a real, audible quality issue with naive
  oscillator on/off that's easy to overlook.
- **Replay-restriction support for later phases**: `maxPlays` (`null` =
  unlimited; a number caps total plays — `1` covers both "play once" and,
  paired with a UI that also hides the button, "replay disabled"; `0`
  blocks all playback outright) and `autoPlay` (fire immediately once a
  plan loads vs. only on an explicit `play()` call). `canPlay()`,
  `getState()`, and an `onBlockedReplay` callback let a future
  exercise/test screen enforce and surface these rules without touching
  the player's internals.
- `stop()` immediately halts all scheduled/active oscillators;
  `setVolume()`/`mute()`/`unmute()` adjust live; `destroy()` releases the
  `AudioContext`.

**Teacher preview UI** (`teacher.html` "Morse Audio Preview" panel +
`client/public/js/morse-preview.js`)
- Text box (type your own) or "Generate random text" (difficulty
  dropdown, calls `/api/morse/random`)
- WPM, Farnsworth WPM (optional), tone frequency, volume slider
- A replay-policy dropdown (Unlimited / Play once / Disabled) and an
  autoplay checkbox — lets the teacher (and, functionally, this
  checkpoint) directly exercise every one of the four listed future
  restriction modes against the real component
- Live status: Morse code text, duration, play/stop state, play count,
  and a warning for any unsupported characters

## Created files
```
server/src/modules/morse-engine/
├── morseParse.js          (extracted shared parser)
├── playbackPlan.js
├── morseController.js
├── morseRoutes.js
└── __tests__/playbackPlan.test.js
client/public/js/
├── morse-audio-player.js
└── morse-preview.js
docs/checkpoints/phase-6-checkpoint.md
```

## Modified files
- `server/src/modules/morse-engine/timingService.js` — refactored to use
  the new shared `morseParse.js` (extract-function, behavior-preserving;
  re-verified against the full test suite immediately after)
- `server/src/modules/morse-engine/index.js` — exports `buildPlaybackPlan`, `planTotalDurationMs`
- `server/src/server.js` — mounts `/api/morse` routes
- `client/public/teacher.html` — new preview panel, loads the two new scripts
- `client/public/css/teacher.css` — preview panel styles
- `README.md` — new "Morse Audio" section, updated project layout

## Tests performed

**Automated (Node test runner)**
- Full suite: **77/77 passing** (70 from Phase 5 + 7 new
  `playbackPlan.test.js` tests, including a hand-verified exact
  segment-by-segment expected plan for "SOS" at 20 WPM, and a
  cross-check that `planTotalDurationMs` always equals
  `computeSequenceDurationMs` for the same input)
- Re-ran the entire suite immediately after the `morseParse.js`
  extraction to confirm the refactor was behavior-preserving

**Backend HTTP (curl, live server)**
- `POST /api/morse/preview` for "SOS" at 20 WPM returns a plan that
  matches the unit-tested expected plan byte-for-byte
- Farnsworth timing end-to-end through the API (18 WPM char speed / 10
  WPM Farnsworth) — correct stretched inter-char/inter-word gaps, dot/dash
  unaffected
- Invalid-character reporting works through the full API round trip
- `GET /api/morse/random` with a difficulty + seed
- Permission boundaries: unauthenticated → 401, student → 403, teacher → 200
- Input validation: missing `text` → 400, unknown difficulty → 400

**Audio player logic (mock Web Audio API harness in Node)**
Real browser automation isn't available in this sandboxed environment
(no network access to download a browser, no display), so I built a
minimal mock of the Web Audio API surface the player uses
(`AudioContext`/`OscillatorNode`/`GainNode`) to verify the actual
scheduling *logic* in isolation:
- Loaded the exact same SOS-at-20-WPM plan already verified server-side
  and confirmed all **9** tone start-offsets and durations match the
  expected cumulative timings exactly (0, 120, 240, 480, 720, 960, 1320,
  1440, 1560 ms — hand-computed independently, not copied from the code)
- Confirmed every tone gets a 4-step gain envelope (silence → ramp up →
  hold → ramp down), i.e. click-avoidance is actually wired up, not just
  described in a comment
- Confirmed tone frequency and master-gain volume are applied correctly
- Confirmed `maxPlays: 1` blocks a second `play()` call (returns `false`,
  no new oscillators scheduled)
- Confirmed `maxPlays: 0` ("Disabled") blocks play from the very first
  call
- Confirmed `autoPlay: true` fires playback automatically on `loadPlan()`
  with no explicit `play()` call
- Confirmed `stop()` invokes `oscillator.stop()` and clears `isPlaying`

**Frontend wiring**
- `node --check` passes on both new client JS files (syntax valid)
- Cross-checked every DOM id referenced in `teacher.js` + `morse-preview.js`
  against `teacher.html` — no missing elements
- Confirmed `teacher.html`, `morse-audio-player.js`, `morse-preview.js`,
  and the updated `teacher.css` all serve correctly (HTTP 200) from a
  live server

## Known issues / honest limitations
- **No real-browser test was possible in this environment.** This sandbox
  has no display and only an allowlist of npm/package-registry domains —
  no way to download or drive an actual browser (Chrome, Edge, Firefox),
  Windows or otherwise. What I verified instead: (a) the exact scheduling
  math via a hand-built mock of the Web Audio API's call surface, matched
  against independently hand-computed expected values, and (b) that the
  code is syntactically valid and every DOM reference resolves. **Real
  in-browser testing on Windows (Chrome/Edge/Firefox) — actually hearing
  the tone, confirming no clicks, checking the browser's autoplay-gesture
  requirement is satisfied by the Play button — still needs to be done by
  you** before relying on this in a classroom. I did design specifically
  around the known Windows-browser autoplay constraint (AudioContext is
  created/resumed lazily, only from inside the Play button's click
  handler), but that assumption is untested against a real browser.
- The player's `stop()` calls `oscillator.stop(now)` on nodes that may
  already have a *future* stop time scheduled from when they were
  created; per the Web Audio spec this correctly overrides/advances the
  stop time, but this relies on real browser spec compliance rather than
  something my mock harness could fully exercise.
- The teacher preview intentionally re-fetches `/api/morse/preview` every
  time Play is pressed (rather than caching), so changing WPM/text and
  immediately hitting Play always reflects the latest values — this is a
  network round-trip per play, acceptable for a manual preview tool but
  not the pattern a future timed multi-student test would use (that will
  want the plan pre-fetched/cached well before the "go" moment, per the
  project's original synchronization design).

## Next phase
Not yet specified by you. Natural next step would be the actual
training/testing exercise flow (individual practice loop) that wires a
student-facing version of this same `MorseAudioPlayer` component into a
real exercise, with answer submission and automatic grading — at your
direction.

## Important technical decisions
- Timing/plan computation stays entirely server-side (the one Phase 5
  engine); the browser only *plays* a plan it's given, it never
  recomputes Morse timing itself. This avoids two independently
  maintained/possibly-drifting implementations of the timing formula
  across the Node and browser runtimes, at the cost of a network round
  trip per preview — an acceptable trade for a LAN-only classroom tool.
- `maxPlays`/`autoPlay` chosen as two independent, composable knobs
  rather than a rigid named-mode enum (e.g. `'once'|'unlimited'|'disabled'`)
  — every one of the four modes named in the requirements maps onto some
  combination of the two, and a future testing phase gets more
  flexibility (e.g. "auto-play once, no manual replay" falls out for free
  as `{autoPlay: true, maxPlays: 1}`).
- A 5ms linear attack/release envelope per tone (configurable) — standard
  practice for clean-sounding CW keying; prevents the sharp clicking
  sound naive on/off oscillator switching produces.
