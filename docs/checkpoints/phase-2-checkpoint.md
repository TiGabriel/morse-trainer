# PROJECT CHECKPOINT — Phase 2: LAN Server Foundation

## Current phase
Phase 2 — Project foundation running as a real LAN server on the teacher's
Windows PC (scope as re-specified for this phase: LAN accessibility, config,
scripts, logging — no auth/DB models/Morse logic yet).

## Implemented features
1. **Project initialization** — carried forward from Phase 1, dependencies refreshed (`dotenv` added)
2. **Frontend structure** — `client/public/{index.html, css/styles.css, js/app.js}`, split out of the single inline file from Phase 1
3. **Backend structure** — new `server/src/{config, logger, utils, middleware}` modules added alongside the existing `db/`, `modules/`, `realtime/` placeholders
4. **Local server** — Express app in `server/src/server.js`, now with graceful shutdown on `SIGINT`/`SIGTERM`
5. **LAN accessibility** — binds to `0.0.0.0` (configurable), auto-detects the machine's real LAN IPv4 address via `os.networkInterfaces()` (`server/src/utils/network.js`) — no hardcoded IP anywhere
6. **Health/status endpoint** — `GET /api/health` (JSON, `server_status: "ONLINE"`), `GET /api/health/text` (plain text), `GET /api/network-info` (lists all detected interfaces, for multi-adapter machines)
7. **Basic frontend page** — placeholder page fetches `/api/health` and prominently displays the shareable LAN URL for the teacher
8. **Environment/configuration system** — `server/.env.example` + `server/src/config/index.js` (via `dotenv`); `PORT`, `HOST`, `NODE_ENV`, `LOG_LEVEL`
9. **Development scripts** — `npm start` / `npm run dev` (uses Node's built-in `--watch`, no extra dependency) / `npm run migrate`; plus Windows `.bat` files in `scripts/`
10. **Basic logging** — `server/src/logger/index.js` (timestamped, leveled, writes to console + `server/logs/server.log`), plus an HTTP request-logging middleware

## Created files
```
scripts/
├── start.bat
├── dev.bat
└── stop.bat
server/
├── .env.example
└── src/
    ├── config/index.js
    ├── logger/index.js
    ├── middleware/requestLogger.js
    └── utils/network.js
client/public/
├── css/styles.css
└── js/app.js
docs/checkpoints/phase-2-checkpoint.md
```

## Modified files
- `server/src/server.js` — rewritten to use config/logger/network-detection, new endpoints, graceful shutdown
- `server/package.json` — added `dotenv`, changed `dev` script to `node --watch`
- `client/public/index.html` — now links external CSS/JS, shows the shareable LAN URL box
- `.gitignore` — added `server/.env`, `server/logs/*.log`
- `README.md` — rewritten for Phase 2 (setup, Windows scripts, endpoints, LAN testing steps)

## Tests performed
1. **Server starts** — verified via fresh `npm install` + `node src/server.js`; startup banner correctly prints the LAN URL
2. **Frontend loads** — `GET /` returns 200, `css/styles.css` and `js/app.js` both return 200, page correctly displays "SERVER STATUS: ONLINE" and the shareable URL after fetching `/api/health`
3. **Accessible via LAN address, not just localhost** — confirmed by hitting `http://<detected-LAN-IP>:8080/api/health` (not `127.0.0.1`) and getting HTTP 200; server binds `0.0.0.0` so this generalizes to any interface, though a true cross-machine test requires two physical/virtual machines on the same classroom LAN, which isn't possible inside this sandboxed dev environment — this should be spot-checked once on real classroom hardware
4. **Health endpoint works** — `/api/health`, `/api/health/text`, and `/api/network-info` all verified, returning correct JSON/text
5. **Handles simultaneous connections** — fired 20 concurrent requests (simulating a full classroom hitting the server at once); all 20 returned HTTP 200
6. Bonus checks: request logging confirmed writing to `server/logs/server.log`; graceful shutdown confirmed via `SIGTERM` (clean log entry + process exit, no hang)

## Known issues
- True multi-machine LAN reachability (teacher PC + a *physically separate* student PC) could not be tested inside this sandboxed environment — only single-machine-but-non-loopback reachability was verified. Recommend a quick real-hardware check once deployed.
- Windows Firewall will very likely prompt to allow Node.js the first time the server starts on a real Windows machine — this is expected and just needs "Allow" for private networks; noted in the README but not yet automated (could add a one-time firewall-rule helper in a later phase if useful)
- If a teacher's PC has multiple network adapters (e.g. Wi-Fi + Ethernet + a VPN), the auto-detected address might not always be the right one for the classroom — `/api/network-info` lists all candidates as a manual override path, but there's no UI to switch yet
- No database status in the health check yet, per this phase's explicit scope — will be added when database-backed features arrive

## Next phase
Not yet defined by you for certain — the original Phase 2 in the Phase 0 roadmap was Authentication & Accounts; today's message re-scoped "Phase 2" to this LAN-foundation work instead. Suggest treating **Authentication & Accounts** as the next phase (password hashing, login/logout, role-based guards, teacher CRUD for students/classes) unless you'd like to re-order or redefine it.

## Important technical decisions
- LAN IP detection prefers private-range addresses (`192.168.x`, `10.x`, `172.16–31.x`) over other interfaces (e.g. VPN adapters), falling back to the first non-internal IPv4 found — avoids hardcoding, adapts to whatever network the teacher PC is on
- Used Node's built-in `--watch` flag for dev-mode auto-restart instead of adding `nodemon` as a dependency — keeps the dependency footprint minimal
- Wrote a small in-house logger/request-logger instead of adding `morgan`/`winston` — sufficient for this scale and keeps things simple, per the "avoid unnecessary complexity" principle from Phase 0
- Health check intentionally excludes database status this phase, per your explicit instruction that "DATABASE STATUS may be added later"
- Kept the Phase 1 database schema/migration code in place (unchanged) since it's inert foundation, not a new feature — did not expand or touch it this phase
