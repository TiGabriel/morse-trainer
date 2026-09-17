# PROJECT CHECKPOINT — Phase 4: Teacher Student/Class Management

## Current phase
Phase 4 — full teacher-facing CRUD for students and classes, with a clean
dark-mode dashboard UI.

## Implemented features

**Students**: list, search (free-text across username/first/last/rank),
filter (by class, by active/inactive/all status), create, edit
(rank/first/last name/username/class), deactivate, reactivate, reset
password (auto-generated, shown once, revokes existing sessions), assign
class, move between classes (same edit endpoint).

**Classes**: create, rename, list (with live student counts),
deactivate/reactivate (soft, reversible), safe delete (hard-blocked with
a clear 409 error while any student is still assigned; succeeds once
empty), assign/move students (via student edit endpoint).

**Student profile**: `GET /api/users/:id` (self-or-teacher, from Phase 3)
now surfaces on the main page as a read-only "My Profile" card for
students. Students have no write access to their own record — all edits
are teacher-only, by design.

**UI**: new `teacher.html` + `teacher.js` + `teacher.css` — dark-mode
dashboard with classes/students tables, search/filter controls, and
modals for create/edit/rename/reset-password. Role-gated: non-teachers
are redirected away. Homepage updated with a dashboard link for teachers
and a profile card for students.

## Created files
```
server/src/db/migrate.js (column-migration helper added)
client/public/teacher.html
client/public/css/teacher.css
client/public/js/teacher.js
```

## Modified files
- `server/src/db/schema.sql` — `classes.is_active` column (schema v3)
- `server/src/modules/users/userRepository.js` — search/filter, update,
  password-hash update, class-membership count
- `server/src/modules/users/usersController.js` / `usersRoutes.js` —
  list with filters, edit, reset-password endpoints
- `server/src/modules/classes/classRepository.js` /
  `classesController.js` / `classesRoutes.js` — rename, status toggle,
  safe delete, student counts
- `server/src/modules/auth/sessionService.js` — `destroySessionsForUser`
  (used on password reset / deactivation)
- `client/public/index.html`, `js/app.js`, `css/styles.css` — teacher
  dashboard link, student profile card

## Tests performed (all passing)
- Class rename, list-with-counts
- Safe delete blocked (409) while students assigned; succeeds once empty
- Class deactivate/reactivate (soft, reversible)
- Student search by name, filter by class, filter by status
- Student edit (rank, name), move between classes
- Password reset: old password stops working, new temporary password
  works, confirmed via actual login attempts
- Permission boundaries: student blocked (403) from create-user,
  list-users, create-class, rename-class, delete-class, edit-own-profile,
  reset-own-password; student still allowed to view own profile and the
  class list
- Full Node-script end-to-end simulation of the browser flow (teacher
  login → create class → create student → filter → edit → student login
  → view own profile → blocked self-edit → deactivate → delete-blocked →
  move-out-of-class → delete-succeeds) — all assertions passed
- Cross-checked every DOM id referenced in `teacher.js`/`app.js` actually
  exists in the corresponding HTML (no broken bindings)
- Both frontend JS files pass `node --check` (syntax valid)
- 20 concurrent authenticated requests against the new endpoints, all 200

## Known issues
None blocking.

## Next phase
Phase 5 — Core Morse-code engine (text↔Morse, timing, difficulty, random
generation) — completed; see phase-5-checkpoint.md.

## Important technical decisions
- Classes get a soft `is_active` flag (deactivate/reactivate) AND a hard
  `DELETE`, kept intentionally separate: deactivate is always safe/
  reversible; delete is permanent and only allowed once a class has zero
  members, so historical data is never silently orphaned or lost.
- Password reset destroys all of that user's existing sessions — a
  student who was already logged in elsewhere is signed out the moment
  their password changes.
- The teacher dashboard is plain HTML/CSS/vanilla JS (no build step),
  consistent with the rest of the client — a generic modal system (field
  specs in, validated submit out) is reused for every create/edit/rename/
  reset-password flow rather than writing one-off forms.
