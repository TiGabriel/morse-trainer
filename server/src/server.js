const path = require('path');
const os = require('os');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const logger = require('./logger');
const requestLogger = require('./middleware/requestLogger');
const { getLanAddresses, getPrimaryLanAddress } = require('./utils/network');
const migrate = require('./db/migrate');
const seed = require('./db/seed');
const sessionService = require('./modules/auth/sessionService');

const authRoutes = require('./modules/auth/authRoutes');
const usersRoutes = require('./modules/users/usersRoutes');
const classesRoutes = require('./modules/classes/classesRoutes');
const morseRoutes = require('./modules/morse-engine/morseRoutes');
const practiceRoutes = require('./modules/practice/practiceRoutes');
const sessionsRoutes = require('./modules/sessions/sessionsRoutes');
const statsRoutes = require('./modules/stats/statsRoutes');
const realtimeHub = require('./realtime/hub');

async function main() {
    // Foundation from Phase 1: applies the DB schema (idempotent).
    migrate();

    // Phase 3: ensures at least one teacher account exists. Safe/idempotent
    // — does nothing if a teacher account already exists.
    await seed();

    // Housekeeping: drop any sessions that expired while the server was down.
    const purged = sessionService.purgeExpiredSessions();
    if (purged > 0) {
        logger.info(`Purged ${purged} expired session(s) on startup.`);
    }

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(requestLogger);

    const serverStartedAt = new Date();
    const primaryLanAddress = getPrimaryLanAddress();
    const lanUrl = primaryLanAddress ? `http://${primaryLanAddress}:${config.port}` : null;

    // ---- Health / status endpoint -----------------------------------------
    // Simple, dependency-free check the teacher (or a script) can hit to
    // confirm the server process is alive and reachable. Database status is
    // intentionally NOT included yet — will be added in a later phase.
    app.get('/api/health', (req, res) => {
        res.json({
            server_status: 'ONLINE',
            hostname: os.hostname(),
            lan_address: primaryLanAddress,
            lan_url: lanUrl,
            port: config.port,
            environment: config.nodeEnv,
            started_at: serverStartedAt.toISOString(),
            uptime_seconds: Math.round(process.uptime()),
            timestamp: new Date().toISOString(),
        });
    });

    // Plain-text variant for a quick manual check (curl, or opening the URL
    // directly in a browser) without parsing JSON.
    app.get('/api/health/text', (req, res) => {
        res.type('text/plain').send(`SERVER STATUS: ONLINE\nLAN URL: ${lanUrl || 'unavailable'}\nPORT: ${config.port}`);
    });

    // Exposes the full list of detected LAN addresses, in case the machine
    // has more than one network adapter and the auto-picked one isn't the
    // right one for this classroom.
    app.get('/api/network-info', (req, res) => {
        res.json({
            primary: primaryLanAddress,
            primary_url: lanUrl,
            all_addresses: getLanAddresses(),
        });
    });

    // ---- Phase 3: authentication & account routes -------------------------
    app.use('/api/auth', authRoutes);
    app.use('/api/users', usersRoutes);
    app.use('/api/classes', classesRoutes);

    // ---- Phase 6: Morse preview (teacher-only) -----------------------------
    app.use('/api/morse', morseRoutes);

    // ---- Phase 7: individual practice (any authenticated user, self-scoped) -
    app.use('/api/practice', practiceRoutes);

    // ---- Phase 8: group sessions & formal testing ---------------------------
    app.use('/api/sessions', sessionsRoutes);

    // ---- Phase 11: statistics (teacher class-wide; self-or-teacher per student) -
    app.use('/api/stats', statsRoutes);

    // Any /api/* path that didn't match a route above gets a clean JSON 404
    // instead of falling through to Express's default HTML error page.
    app.use('/api', (req, res) => {
        res.status(404).json({ error: 'Not found.' });
    });

    // ---- Static client ------------------------------------------------------
    const clientPublicDir = path.join(__dirname, '..', '..', 'client', 'public');
    app.use(express.static(clientPublicDir));

    // ---- Global error handler -------------------------------------------------
    // Catches: malformed JSON bodies (express.json()'s own thrown error),
    // any synchronous throw in a route handler (Express catches these
    // automatically and forwards here), and any async handler wrapped in
    // asyncHandler(). Never leaks an internal error message or stack trace
    // to the client — only the generic message below goes out; the real
    // detail is logged server-side.
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err && err.type === 'entity.parse.failed') {
            return res.status(400).json({ error: 'Malformed JSON in request body.' });
        }
        logger.error(`Unhandled error on ${req.method} ${req.originalUrl}: ${err && err.message}`);
        if (err && err.stack) logger.error(err.stack);
        if (res.headersSent) return next(err);
        res.status(500).json({ error: 'Internal server error.' });
    });

    const server = app.listen(config.port, config.host, () => {
        logger.info(`Morse Trainer server started (env=${config.nodeEnv})`);
        logger.info(`Listening on ${config.host}:${config.port}`);

        console.log('');
        console.log('========================================================');
        console.log('  MORSE TRAINER SERVER — ONLINE');
        console.log('========================================================');
        console.log(`  Local (this machine):  http://localhost:${config.port}`);
        if (lanUrl) {
            console.log(`  Share with students:   ${lanUrl}`);
        } else {
            console.log('  WARNING: No LAN network interface detected.');
            console.log('  Students on other computers will not be able to connect');
            console.log('  until this machine is connected to the classroom LAN.');
        }
        const others = getLanAddresses().filter((a) => a.address !== primaryLanAddress);
        if (others.length > 0) {
            console.log('  Other detected network interfaces:');
            others.forEach((a) => console.log(`    - ${a.interfaceName}: http://${a.address}:${config.port}`));
            console.log('  (If the address above is wrong for your classroom, use one of these.)');
        }
        console.log('========================================================');
        console.log('');
    });

    // ---- Phase 8: realtime hub, attached to the same HTTP server ------------
    realtimeHub.init(server);

    // ---- Graceful shutdown --------------------------------------------------
    function shutdown(signal) {
        logger.info(`Received ${signal}, shutting down server...`);
        server.close(() => {
            logger.info('Server closed cleanly.');
            process.exit(0);
        });
        // Force-exit if something hangs during shutdown.
        setTimeout(() => process.exit(1), 5000).unref();
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Last-resort safety net. Route handlers should never reach these (async
// ones go through asyncHandler -> the global error middleware above), but
// a classroom server staying up in a degraded state beats it crashing
// mid-lesson over something outside a request/response cycle (e.g. a
// stray WebSocket callback). A rejection is logged and swallowed; a truly
// uncaught synchronous exception is treated as unsafe to continue from
// (Node's own guidance) and triggers the same graceful shutdown as
// SIGTERM/SIGINT rather than leaving the process in an unknown state.
process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled promise rejection: ${reason && reason.message ? reason.message : reason}`);
    if (reason && reason.stack) logger.error(reason.stack);
});

process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}`);
    if (err.stack) logger.error(err.stack);
    process.exit(1);
});

main().catch((err) => {
    logger.error('Fatal error during server startup:', err.message);
    console.error(err);
    process.exit(1);
});
