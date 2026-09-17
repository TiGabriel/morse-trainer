# PROJECT CHECKPOINT — Phase 7: Individual Training Mode

## Current phase
Phase 7 — the student's individual (ungraded) training mode: full flow
from login through settings, exercise, submission, immediate feedback,
and history. Explicitly does not implement official grading — practice
results are stored separately from anything a future test/grading phase
will use.

## Implemented features

**Data isolation from official grading**
- New `practice_attempts` table, entirely separate from the
  `sessions`/`session_items`/`attempts`/`results` tables reserved for
  teacher-controlled group/test sessions. No shared table, no foreign
  key between them — verified directly in SQLite after a full test run:
  official `attempts`/`results` had 0 rows while `practice_attempts` had
  5, confirming practice truly cannot touch an official grade.

**Scoring engine** (`server/src/modules/morse-engine/scoring.js`)
- `scoreAnswer(expected, submitted)` — sequence alignment (Levenshtein
  edit-distance with backtrace), not naive positional comparison. A
  single dropped or inserted character is correctly reported once
  (missing/extra) instead of cascading into false "incorrect" marks for
  every character after it — verified with dedicated tests and in the
  E2E script.
- Returns per-character `ops` (for a visual diff), and
  correct/incorrect/missing/extra counts plus an accuracy percentage
  (relative to the expected answer's length).
- 15 new unit tests: exact match, case sensitivity, single substitution,
  single deletion, single insertion, all-wrong, empty submitted, empty
  expected, both empty, Morse-string input, invalid input, and full
  alignment-coverage verification.

**Practice module** (`server/src/modules/practice/`)
- `practiceEngine.js` — `buildExercise()` composes the existing Phase
  5/6 engine (character generation, text↔Morse, timing, playback plan)
  into the 4 required modes: `audio_to_text`, `morse_to_text`,
  `text_to_morse`, `character_recognition` (forces length 1). No Morse
  logic is duplicated.
- Fully **stateless-until-submitted**: `POST /api/practice/exercises`
  returns a seed and only what that mode should reveal (audio plan, or
  the Morse text, or the plain text — never the answer). The client
  echoes everything back on `POST /api/practice/attempts`; the server
  regenerates the identical exercise from the seed to get the canonical
  expected answer, scores it, and saves the attempt. No "pending
  exercise" row is ever needed.
- `GET /api/practice/history` — the current user's own attempts only, no
  id parameter, no way to view anyone else's practice history.
- All three routes: `requireAuth` only (self-scoped, any role).

**A real bug found and fixed**: `generateFromDifficulty`'s random draws
for wpm/length/farnsworthWpm were being *conditionally skipped* when a
caller overrode that field, which shifted the RNG draw position
depending on *which* fields happened to be overridden on a given call.
In practice this meant a generate call (partial overrides) and a later
submit call (different partial overrides, echoing back what generate
had resolved) could compute a different `farnsworthWpm` for the
identical seed — a genuine reproducibility bug I caught while manually
testing the practice flow, not something the existing Phase 5 tests
happened to exercise. Fixed at the root: all three values are now always
drawn from the RNG unconditionally in a fixed order, with overrides
applied afterward — so the RNG cursor position (and therefore the
character sequence and every resolved value) never depends on which
subset of fields a caller happened to override. Added a regression test
and verified live via curl that the previously-drifting scenario now
reproduces byte-identical results.

**Frontend** (`client/public/practice.html`, `js/practice.js`, `css/practice.css`)
- Minimal, distraction-free 3-screen flow: Settings → Exercise → Results.
  Only one screen is visible at a time.
- Settings: exercise type, difficulty, optional WPM/length overrides,
  volume.
- Exercise screen: mode-appropriate prompt (Play/Replay buttons for
  audio modes reusing `MorseAudioPlayer`; a static Morse or text display
  for the other two) plus a single answer input and Submit.
- Results screen: accuracy percentage (color-coded), correct/incorrect/
  missing/extra counts, a color-coded character-by-character diff, and
  the full correct answer revealed for review.
- Collapsible history panel (hidden by default, so it doesn't compete
  with the exercise itself) showing the student's own recent attempts.
- Homepage (`index.html`) now links students to Individual Training.

## Created files
```
server/src/modules/morse-engine/
├── scoring.js
└── __tests__/scoring.test.js
server/src/modules/practice/
├── practiceEngine.js
├── practiceRepository.js
├── practiceController.js
└── practiceRoutes.js
client/public/
├── practice.html
├── css/practice.css
└── js/practice.js
docs/checkpoints/phase-7-checkpoint.md
```

## Modified files
- `server/src/db/schema.sql`, `migrate.js` — `practice_attempts` table, schema v4
- `server/src/modules/morse-engine/index.js` — exports `scoreAnswer`
- `server/src/modules/morse-engine/generator.js` — reproducibility fix
  (unconditional ordered RNG draws)
- `server/src/modules/morse-engine/__tests__/generator.test.js` — added
  the regression test for the fix above
- `server/src/server.js` — mounts `/api/practice`
- `client/public/index.html`, `js/app.js` — Individual Training link for students
- `README.md` — new "Individual Training" section, updated project layout

## Tests performed

**Automated (Node test runner)**: full suite **93/93 passing** (78 prior
+ 15 new scoring tests), including the new generator regression test.

**Backend (curl, live server)**
- All 4 modes generated and submitted correctly; verified via an
  independent script call to the engine (not copied from the server
  response) that the regenerated text/morse matched exactly
- Confirmed the answer is never present in a `/exercises` response for
  any mode (only plan / promptMorse / promptText, as appropriate)
- Confirmed `character_recognition` always forces length to 1 regardless
  of what was requested
- Confirmed the exact drifting scenario from the reproducibility bug now
  produces identical results before and after the fix
- Permission/validation: unauthenticated → 401; invalid mode → 400;
  missing seed on submit → 400
- Direct SQLite inspection: official `attempts`/`results` tables
  untouched (0 rows) after 5 practice attempts; all 5 landed only in
  `practice_attempts`

**Full Node E2E script** simulating the real browser flow across all 4
modes end-to-end (generate → peek actual answer independently → submit
a deliberately correct or flawed answer → verify the returned
correct/incorrect/missing/extra counts match what was expected) — all
checks passed, including history retrieval and validation error cases.

**Frontend**: `node --check` passes on `practice.js`; every DOM id
referenced in `practice.js` cross-checked against `practice.html` (and
the homepage link/`app.js` change) — no missing elements; all new
static assets (`practice.html`, `practice.css`, `practice.js`) confirmed
serving with HTTP 200 from a live server.

## Known issues
- As with Phase 6, real in-browser testing (actually clicking through
  the exercise flow, hearing the audio, typing an answer) was not
  possible in this sandboxed environment — no display, no browser
  access. The backend contract and all scoring/generation logic were
  verified thoroughly via API tests and a full E2E script; the frontend
  was verified via static analysis (syntax check, DOM-id cross-check,
  asset-serving check) rather than live interaction. Recommend a manual
  click-through pass on real Windows browser hardware before classroom
  use.
- Practice history is currently visible only to the student themselves
  — a teacher cannot yet see a student's practice history. This wasn't
  requested for this phase and would be a natural, small extension
  later if wanted (e.g. an optional teacher-facing read of a specific
  student's practice history, reusing the existing self-or-teacher
  authorization pattern from Phase 3/4).
- `durationMs` (time spent on an exercise) is tracked client-side via
  `Date.now()` and trusted as reported — fine for ungraded self-practice
  analytics, but not a value a future proctored/timed test should trust
  from the client without additional server-side timing enforcement.

## Next phase
Not yet specified by you. Natural next steps per the original roadmap
would be Phase 8 (group/synchronized sessions) or building toward
official testing/grading — at your direction.

## Important technical decisions
- Practice exercises are stateless-until-submitted (seed-based
  regeneration) rather than persisting a "pending exercise" row — avoids
  ever having orphaned incomplete-exercise data to clean up, and
  directly exploits the Phase 5 engine's seeded reproducibility rather
  than adding new state-management complexity.
- Scoring uses proper sequence alignment (edit distance) instead of
  index-by-index comparison specifically because Morse-copying errors
  are very often insertions/deletions (a missed character), not just
  substitutions — naive positional comparison would produce misleading,
  demoralizing feedback (one missed letter looking like the rest of the
  answer is also wrong).
- Practice routes require only `requireAuth` (not a student-only role
  restriction) — a teacher exploring the training tool themselves is
  harmless and their own practice data is scoped to their own account
  like anyone else's, so no extra restriction was needed.
