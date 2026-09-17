# PROJECT CHECKPOINT — Phase 5: Core Morse-Code Engine

## Current phase
Phase 5 — a reliable, reusable, internal Morse engine (text↔Morse, timing,
difficulty-as-data, reproducible random generation). No audio playback,
no HTTP routes exposing it yet — purely the internal engine and its tests,
per this phase's explicit scope.

## Implemented features

1. **Canonical character map** (`morseMap.js`) — a single source-of-truth
   table for A–Z, 0–9, and 18 common punctuation marks (standard
   International Morse Code / ITU-R M.1677-1, plus "!" which most
   training tools include). Named character sets (`letters`, `numbers`,
   `punctuation`, `alphanumeric`, `all`) are derived from this same table.
2. **text → Morse** (`textToMorse.js`) — case-insensitive, word-aware
   (" " between characters, " / " between words), lenient by default
   (reports unsupported characters and skips them) or strict (throws).
3. **Morse → text** (`morseToText.js`) — tolerant of irregular spacing
   and of "/" with or without surrounding spaces; lenient (unrecognized
   tokens become "#" and are reported) or strict (throws).
4. **Validation** (`validator.js`) — `validateText` (against the
   supported character set; whitespace always allowed) and
   `validateMorse` (only `.`, `-`, space, `/` allowed).
5. **Timing engine** (`timingService.js`) — `computeTiming({wpm,
   farnsworthWpm, toneFrequencyHz})` returns dot/dash/intra-char/inter-char/
   inter-word durations in ms, using the standard PARIS-word model
   (dotMs = 1200/wpm) and full Farnsworth support (spacing stretched via
   the documented 31-content-unit / 19-spacing-unit derivation; dot/dash
   length is never affected by Farnsworth). `computeSequenceDurationMs`
   sums a full Morse string's duration from a timing profile — pure
   arithmetic, no audio.
6. **Seeded RNG** (`rng.js`) — mulberry32 + a string→seed hash, so any
   result can be captured and exactly reproduced later.
7. **Difficulty as data** (`difficultyPresets.js`) — four presets
   (`beginner`, `easy`, `medium`, `hard`) as plain data objects (character
   pool, WPM range, length range, optional group size), not folders or
   branching code. `generateFromDifficulty()` is the one generic function
   that resolves any preset.
8. **Random generator** (`generator.js`) — `generateRandomText` (explicit
   character pool + length + optional grouping, seed-reproducible) and
   `generateFromDifficulty` (resolves a named preset's ranges into
   concrete wpm/length, also seed-reproducible as one unit).
9. **Public API** (`index.js`) — the one module the rest of the app should
   ever import from; internal files are implementation detail.
10. **Unit tests** — 70 tests across 7 files (Node's built-in `node:test`
    runner, no extra dependency), covering every item requested: text→Morse,
    Morse→text, spaces, punctuation, numbers, invalid characters, timing
    calculations (including hand-verified Farnsworth math), and random
    generation (including reproducibility).

## Created files
```
server/src/modules/morse-engine/
├── index.js                (public API)
├── morseMap.js              (canonical character table + charsets)
├── textToMorse.js
├── morseToText.js
├── validator.js
├── timingService.js         (WPM/Farnsworth timing model, fully documented)
├── rng.js                   (seeded PRNG for reproducibility)
├── difficultyPresets.js     (difficulty as data)
├── generator.js             (random text generation)
├── errors.js                (MorseEngineError)
└── __tests__/
    ├── textToMorse.test.js
    ├── morseToText.test.js
    ├── validator.test.js
    ├── timingService.test.js
    ├── generator.test.js
    ├── rng.test.js
    └── index.test.js
docs/checkpoints/phase-5-checkpoint.md
```

## Modified files
- `server/package.json` — added `"test": "node --test"` script
- `README.md` — added a "Morse Engine" section and updated the project
  layout tree

## Tests performed
- `npm test` (`node --test`, auto-discovery): **70/70 passing**
- Manual interactive sanity pass before writing formal tests (text↔Morse
  round trips, timing numbers at 20 WPM hand-verified: dotMs=60,
  dashMs=180, interCharGapMs=180, interWordGapMs=420; Farnsworth 20→10
  hand-verified via the documented formula; PARIS-word duration check
  confirms 31+12+7=50 dot-units exactly)
- Verified the main server still boots cleanly with the new module
  present (it's purely internal at this point — no routes reference it
  yet, so this was a regression check, not new functionality)
- Two bugs were found and fixed during testing — both were mistakes in
  my *test assertions* (an incorrect assumption about `String.split`
  behavior, and a miscalculated expected value for a "/" parsing case),
  not in the engine itself; both are now fixed and passing

## Known issues
- The engine is not yet wired into any HTTP route — by design, per this
  phase's scope ("do not implement the complete audio player yet"). A
  later phase will expose it (e.g. an endpoint to fetch a generated
  radiogram's text + timing profile for a session).
- Punctuation set is the common ITU set plus "!" (not officially in the
  ITU standard but included because virtually every Morse trainer
  supports it) — flag if you'd prefer strict ITU-only punctuation.
- `computeSequenceDurationMs` never charges an inter-word gap after the
  very last word (this is intentional — trailing dead air isn't part of
  the content — but worth knowing when composing total-session-length
  estimates in a later phase: add one `interWordGapMs` per word boundary
  you introduce yourself, e.g. between back-to-back exercise items).

## Next phase
Not yet specified by you. Natural next step per the original roadmap
would be building the actual audio player (Web Audio API tone
generation on the client, driven by this engine's timing output) —
Phase 6 or later, at your direction.

## Important technical decisions
- Used Node's built-in `node:test` runner instead of adding Jest/Mocha as
  a dependency — zero extra install weight, works fully offline like
  everything else in this project, and Node 18+ (already required) ships
  it natively.
- Chose mulberry32 for the seeded RNG (not cryptographically secure, and
  explicitly documented as such) — it's small, fast, dependency-free, and
  exactly what's needed for reproducible *practice text*, not security.
- `generateFromDifficulty` derives a decorrelated sub-seed (XOR with a
  fixed odd constant) for character selection, separate from the
  seed used to pick WPM/length from their ranges — keeps the character
  sequence from merely replaying the same draws used for wpm/length,
  while the whole result stays 100% reproducible from one input seed.
- Word separator convention (" / ") was chosen as the common
  human-readable way to write Morse word breaks in text form; the parser
  is lenient about spacing around it since this format may eventually be
  hand-typed by a teacher composing a manual radiogram.
