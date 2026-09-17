/**
 * Realtime WebSocket hub for group/formal-test sessions.
 *
 * One room per session (keyed by sessionId). Both the teacher's monitor
 * view and joined students share the same room and the same
 * `session_state` broadcast — the teacher UI already expects exactly
 * this shape (see client/public/js/sessions.js from an earlier phase).
 *
 * The server is authoritative: nothing a client sends over this socket
 * is trusted as session state. Every inbound message either (a) asks the
 * server to look something up (`monitor_session`), (b) asks the server to
 * perform a *validated* action (`join_session`, `set_ready`, `ping`), or
 * is rejected. Session status transitions themselves go through the REST
 * API (`sessionsController.js`) so they get the same auth middleware as
 * every other write in this app — the socket is push/notify only, plus
 * the two low-risk, purely-self-scoped actions above.
 */
const WebSocket = require('ws');
const config = require('../config');
const sessionService = require('../modules/auth/sessionService');
const sessionRepository = require('../modules/sessions/sessionRepository');
const logger = require('../logger');

// sessionRuntime.js requires this module (to broadcast), so requiring it
// back at the top here would create a circular `require` where whichever
// module loads second captures the other's exports object before its
// final `module.exports = {...}` assignment runs — silently keeping a
// stale, empty reference forever. Requiring it lazily, inside the
// functions that need it below, sidesteps that entirely (by the time
// these functions actually run, both modules have finished loading).
function getSessionRuntime() {
    return require('../modules/sessions/sessionRuntime');
}

let wss = null;
/** @type {Map<number, Set<import('ws').WebSocket>>} */
const rooms = new Map();

function parseCookie(cookieHeader, name) {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const key = part.slice(0, idx).trim();
        if (key === name) {
            return decodeURIComponent(part.slice(idx + 1).trim());
        }
    }
    return null;
}

function authenticateRequest(req) {
    const rawToken = parseCookie(req.headers.cookie, config.auth.cookieName);
    const session = sessionService.validateAndRefresh(rawToken);
    return session ? session.user : null;
}

function joinRoom(ws, sessionId) {
    leaveRoom(ws);
    if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
    rooms.get(sessionId).add(ws);
    ws.sessionId = sessionId;
}

function leaveRoom(ws) {
    if (ws.sessionId && rooms.has(ws.sessionId)) {
        rooms.get(ws.sessionId).delete(ws);
        if (rooms.get(ws.sessionId).size === 0) rooms.delete(ws.sessionId);
    }
    ws.sessionId = null;
}

function send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

/** Broadcasts an arbitrary message to everyone (teacher monitors + joined students) in a session's room. */
function broadcast(sessionId, message) {
    const room = rooms.get(sessionId);
    if (!room) return;
    const payload = JSON.stringify(message);
    for (const ws of room) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
}

/** Builds and broadcasts the canonical {session, roster} snapshot — the server-authoritative state every client renders from. */
function broadcastSessionState(sessionId) {
    const session = sessionRepository.findByIdPublic(sessionId);
    if (!session) return;
    const roster = sessionRepository.listRoster(sessionId, session.classId, session.participantIds);
    broadcast(sessionId, { type: 'session_state', session, roster });
}

function handleMonitorSession(ws, msg) {
    if (ws.user.role !== 'teacher') {
        return send(ws, { type: 'error', error: 'Only teachers may monitor a session.' });
    }
    const sessionId = Number(msg.sessionId);
    const session = sessionRepository.findByIdPublic(sessionId);
    if (!session) return send(ws, { type: 'error', error: 'Session not found.' });

    joinRoom(ws, sessionId);
    const roster = sessionRepository.listRoster(sessionId, session.classId, session.participantIds);
    send(ws, { type: 'session_state', session, roster });
}

function handleJoinSession(ws, msg) {
    if (ws.user.role !== 'student') {
        return send(ws, { type: 'error', error: 'Only students may join a session this way.' });
    }
    const sessionId = Number(msg.sessionId);
    const session = sessionRepository.findByIdPublic(sessionId);
    if (!session) return send(ws, { type: 'error', error: 'Session not found.' });
    if (!sessionRepository.isStudentInSessionClass(sessionId, ws.user.id)) {
        logger.warn(`Realtime: student "${ws.user.username}" attempted to join session ${sessionId} outside their class.`);
        return send(ws, { type: 'error', error: 'You are not in the class this session belongs to.' });
    }
    if (!['waiting', 'running', 'paused'].includes(session.status)) {
        return send(ws, { type: 'error', error: `This session is not open for joining (status: ${session.status}).` });
    }

    sessionRepository.markParticipantConnected(sessionId, ws.user.id);
    joinRoom(ws, sessionId);
    broadcastSessionState(sessionId);
    resyncActiveItem(ws, sessionId, session);
}

/**
 * Sent right after a student (re)joins a running session's room — covers
 * both a fresh join mid-session and a reconnect after a refresh/dropped
 * connection, which must never trust cached client state. Replays
 * whichever of `scheduled_start`/`item_active` currently applies, both of
 * which already carry the full item payload, so the client can rebuild
 * its countdown/answer-window state from this single message alone.
 */
function resyncActiveItem(ws, sessionId, session) {
    if (session.status !== 'running') return;
    const sessionRuntime = getSessionRuntime();
    const runtime = sessionRuntime.getRuntimeState(sessionId);
    if (!runtime || runtime.currentItemIndex === null) return;

    const item = sessionRepository.getItemByIndex(sessionId, runtime.currentItemIndex);
    if (!item) return;

    if (runtime.currentDeadlineAt) {
        send(ws, {
            type: 'item_active',
            itemIndex: runtime.currentItemIndex,
            deadlineAt: runtime.currentDeadlineAt,
            serverNow: Date.now(),
            item: sessionRuntime.publicItemPayload(item),
        });
    } else if (runtime.scheduledStartAt) {
        send(ws, {
            type: 'scheduled_start',
            itemIndex: runtime.currentItemIndex,
            itemsTotal: sessionRepository.countItems(sessionId),
            startAt: runtime.scheduledStartAt,
            serverNow: Date.now(),
            item: sessionRuntime.publicItemPayload(item),
        });
    }
}

function handleSetReady(ws, msg) {
    if (ws.user.role !== 'student' || !ws.sessionId) {
        return send(ws, { type: 'error', error: 'Join a session before setting readiness.' });
    }
    sessionRepository.setParticipantReady(ws.sessionId, ws.user.id, !!msg.ready);
    broadcastSessionState(ws.sessionId);
}

function handlePing(ws, msg) {
    // Clock-offset estimation support: echo the client's timestamp back
    // alongside the server's own, so the client can compute round-trip
    // time and offset (see group-session.js `estimateClockOffset`).
    send(ws, { type: 'pong', clientTime: msg.clientTime, serverTime: Date.now() });
}

const HANDLERS = {
    monitor_session: handleMonitorSession,
    join_session: handleJoinSession,
    set_ready: handleSetReady,
    ping: handlePing,
};

function init(httpServer) {
    wss = new WebSocket.Server({
        server: httpServer,
        path: '/ws',
        verifyClient(info, callback) {
            const user = authenticateRequest(info.req);
            if (!user) return callback(false, 401, 'Unauthorized');
            info.req.morseUser = user;
            callback(true);
        },
    });

    wss.on('connection', (ws, req) => {
        ws.user = req.morseUser;
        ws.isAlive = true;
        ws.sessionId = null;

        ws.on('pong', () => {
            ws.isAlive = true;
        });

        ws.on('message', (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return send(ws, { type: 'error', error: 'Malformed message.' });
            }
            const handler = HANDLERS[msg.type];
            if (!handler) return send(ws, { type: 'error', error: `Unknown message type "${msg.type}".` });
            try {
                handler(ws, msg);
            } catch (err) {
                logger.error(`Realtime handler error (${msg.type}): ${err.message}`);
                send(ws, { type: 'error', error: 'Internal error handling that message.' });
            }
        });

        ws.on('close', () => {
            if (ws.sessionId && ws.user.role === 'student') {
                sessionRepository.markParticipantDisconnected(ws.sessionId, ws.user.id);
                broadcastSessionState(ws.sessionId);
            }
            leaveRoom(ws);
        });
    });

    // Heartbeat: detects dead connections (e.g. a laptop that lost LAN
    // link without a clean close) so rooms/roster state don't accumulate
    // sockets that will never send another byte. ~20 clients is a
    // trivial load for this.
    const heartbeat = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) return ws.terminate();
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);
    heartbeat.unref();

    logger.info('Realtime WebSocket hub attached at /ws');
    return wss;
}

module.exports = { init, broadcast, broadcastSessionState };
