# PROJECT CHECKPOINT — Phase 3: Database & Authentication Foundation

## Current phase
Phase 3 — local database (users, classes, sessions) and full authentication:
teacher/student roles, secure password storage, login/logout, server-side
sessions, and role-based authorization.

## Implemented features
- **Database**: `auth_sessions` table added (session tokens stored as
  SHA-256 hashes, never raw). Schema version bumped to 2. `users` and
  `classes` tables (from Phase 1) already covered all required student
  data fields (rank, first/last name, class, username, password hash,
  active/inactive status).
- **Password security**: `bcryptjs` (pure JS, no native compile step),
  cost factor 11, configurable via `.env`.
- **Sessions**: server-side, sliding 8-hour expiration, HTTP-only cookie,
  validated + refreshed on every request. Deactivating a user immediately
  revokes their live session on the very next request.
- **Auth endpoints**: `POST /api/auth/login`, `POST /api/auth/logout`,
  `GET /api/auth/me`.
- **Users/Classes modules**: minimal endpoints needed to actually create
  and manage the accounts auth requires — teacher-only create/list,
  self-or-teacher read (`GET /api/users/:id`), teacher-only
  activate/deactivate.
- **Seed system**: `server/src/db/seed.js` auto-creates an initial teacher
  account on first run — random password if not set via `.env`, written
  once to a gitignored credentials file, never logged in plaintext.
- **Frontend**: minimal login/logout form added to the Phase 2 placeholder
  page.

## Created files
```
server/.env.example (extended with auth vars)
server/src/db/seed.js
server/src/modules/auth/
├── passwordService.js
├── sessionService.js
├── authController.js
└── authRoutes.js
server/src/modules/users/
├── userRepository.js
├── usersController.js
└── usersRoutes.js
server/src/modules/classes/
├── classRepository.js
├── classesController.js
└── classesRoutes.js
server/src/middleware/auth.js
```

## Modified files
- `server/src/db/schema.sql`, `migrate.js` — added `auth_sessions`
- `server/src/config/index.js` — session TTL, cookie name, bcrypt cost,
  initial teacher credentials
- `server/src/server.js` — wired cookie-parser, seed(), auth/users/classes routes
- `server/package.json` — added `bcryptjs`, `cookie-parser`
- `client/public/index.html`, `js/app.js` — login/logout UI

## Tests performed (all passing)
- Valid teacher login (200, session cookie set)
- Invalid password (401, generic message)
- Invalid username (401, same generic message — no enumeration)
- Valid student login (200)
- Logout (session truly deleted server-side; next request → 401)
- Unauthorized access with no session (401 on all protected routes)
- Inactive account at login (403, distinct message)
- Inactive account mid-session (deactivation revokes an already-open session)
- Role separation (student blocked with 403 from all teacher-only routes)
- Student data isolation (own profile 200, other student's profile 403,
  teacher can view both)
- 20 concurrent authenticated requests, all 200
- Input validation: duplicate username (409), short password (400),
  invalid role (400)
- No password hashes or plaintext passwords ever appear in logs (confirmed
  by grepping the log file)
- Stored password hashes confirmed to be proper bcrypt (`$2a$11$...`)
- Stored session tokens confirmed to be SHA-256 hashes, not raw values

## Known issues
None blocking.

## Next phase
Phase 4 — Teacher management of students and classes (CRUD, search/filter,
password reset, safe class deletion) — completed; see phase-4-checkpoint.md.

## Important technical decisions
- `bcryptjs` chosen over native `bcrypt` specifically to avoid requiring a
  C++ build toolchain on a fresh Windows classroom PC.
- Session tokens stored as SHA-256 hashes (not raw) — a copy of the
  database alone can never be used to impersonate a session.
- Generic "Invalid username or password" message for both wrong-username
  and wrong-password cases, to avoid username enumeration; inactive
  accounts get a distinct 403 message since that's a different, less
  sensitive category of rejection.
