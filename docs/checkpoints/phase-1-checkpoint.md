# PROJECT CHECKPOINT — Phase 1: Foundation

## Current phase
Phase 1 — Foundation (scaffolding, DB schema, static serving, health check)

## Implemented features
- Express-based HTTP server, binds to `0.0.0.0:8080` (LAN-reachable)
- SQLite database (via `better-sqlite3`), WAL mode enabled, foreign keys enforced
- Full initial schema created: `classes`, `users`, `morse_configs`, `radiograms`,
  `grading_configs`, `sessions`, `session_items`, `attempts`, `results`, `schema_meta`
- Idempotent migration runner (`npm run migrate` or auto-run on server start)
- `GET /api/health` endpoint — confirms process + DB connectivity, returns schema
  version and uptime
- Static file serving of a placeholder client page (`client/public/index.html`)
  that calls `/api/health` on load to confirm end-to-end connectivity

## Created files
```
morse-trainer/
├── .gitignore
├── README.md
├── docs/checkpoints/phase-1-checkpoint.md
├── server/
│   ├── package.json
│   ├── src/
│   │   ├── server.js
│   │   └── db/
│   │       ├── schema.sql
│   │       ├── client.js
│   │       └── migrate.js
│   └── data/               (created at runtime; gitignored)
└── client/
    └── public/index.html
```
Empty placeholder directories were also created for future phases:
`server/src/modules/{auth,users,classes,sessions,morse-engine,grading,stats}`,
`server/src/realtime`, `server/src/middleware`.

## Modified files
None (first phase).

## Tests performed
- `npm install` completed cleanly (104 packages, 0 vulnerabilities)
- `node src/db/migrate.js` — verified all 10 expected tables created in the SQLite file
- Started server, confirmed:
  - `GET /api/health` returns `{status: "ok", schema_version: "1", ...}`
  - `GET /` serves the placeholder page (HTTP 200) and its client-side JS
    successfully calls the health endpoint and displays "Server OK"
- Confirmed the server process stays up as a persistent background process

## Known issues
- None blocking. Open items carried from Phase 0 design discussion, now default-decided
  unless you say otherwise:
  - Proceeding with Node.js/Express/SQLite/React stack as proposed
  - Proceeding with client-side Web Audio tone generation (to be built in Phase 3)
  - Discovery mechanism (fixed IP vs. mDNS vs. QR code) still undecided — will revisit
    when we build the LAN-facing pieces; fixed IP is sufficient for now and requires
    no extra work
- The client is currently a single static placeholder page, not yet split into
  teacher/student views — that structure will emerge starting Phase 2/6 as roles
  and dashboards are introduced

## Next phase
Phase 2 — Authentication & Accounts: user model refinements if needed, password
hashing (bcrypt/argon2), login/logout endpoints, role-based route guards, and
teacher-facing CRUD for students and classes.

## Important technical decisions
- Used `better-sqlite3` (synchronous, embedded) rather than an async SQLite driver —
  simplest for a single-process modular monolith at this scale, no connection pooling
  complexity needed
- Enabled WAL journal mode up front, anticipating ~20 concurrent clients later
  (writes during test submissions in particular)
- Schema for all core entities (classes, users, morse_configs, radiograms, sessions,
  session_items, attempts, results, grading_configs) was created now, in Phase 1,
  even though most of it won't be used until later phases — this avoids repeated
  schema churn/migrations as each feature phase lands, and the tables are inert
  until the corresponding modules are built
- No auth, no Morse logic, no real-time layer yet — strictly scaffolding, as scoped
