/**
 * Server-authoritative scheduling for an in-progress session: the piece
 * that actually implements "future timestamp, not immediate play" from
 * the project's synchronization design.
 *
 * State kept here is deliberately ephemeral (in-memory `setTimeout`s),
 * not persisted — `sessions.current_item_index` and `sessions.status`
 * in the DB are the durable/authoritative record a client resyncs from
 * after a refresh; this module is just what *drives* those forward while
 * the process is up. See the "known limitations" note in
 * PROJECT_STATUS.md: a server restart mid-session loses these timers
 * (the session stays "running" in the DB with no further progress) —
 * the teacher must Stop/Cancel it and start a fresh one.
 */
const sessionRepository = require('./sessionRepository');
const hub = require('../../realtime/hub');
const logger = require('../../logger');
const gradebookService = require('../gradebook/gradebookService');

/** Used when a group session has no explicit answer-time configured, so it still auto-advances instead of stalling forever. */
const DEFAULT_ANSWER_TIME_MS = 15000;
/** Pause between one item's submission window closing and the next item's countdown starting. */
const INTER_ITEM_GAP_MS = 2000;

/** @type {Map<number, { timers: Set<NodeJS.Timeout>, scheduledStartAt: number|null, currentDeadlineAt: number|null, currentItemIndex: number|null }>} */
const runtimeStates = new Map();

function getOrCreateState(sessionId) {
    let state = runtimeStates.get(sessionId);
    if (!state) {
        state = { timers: new Set(), scheduledStartAt: null, currentDeadlineAt: null, currentItemIndex: null };
        runtimeStates.set(sessionId, state);
    }
    return state;
}

function clearTimers(sessionId) {
    const state = runtimeStates.get(sessionId);
    if (!state) return;
    state.timers.forEach(clearTimeout);
    state.timers.clear();
    state.scheduledStartAt = null;
    state.currentDeadlineAt = null;
}

function scheduleTimer(sessionId, fn, delayMs) {
    const state = getOrCreateState(sessionId);
    const timer = setTimeout(() => {
        state.timers.delete(timer);
        fn();
    }, Math.max(0, delayMs));
    state.timers.add(timer);
    return timer;
}

/**
 * What a client is allowed to see about an item — never the expected
 * answer, UNLESS `includeAnswer` is explicitly passed (used only for the
 * *currently active* item's `item_active` payload, once it has actually
 * gone live — never for a future/upcoming item's `scheduled_start`). Both
 * Formal Tests and Group Practice include it there, so the hidden
 * answer-reveal popup (see nav.js / group-session.js) can show the
 * authoritative answer for the item on screen in either session type.
 */
function publicItemPayload(item, { includeAnswer = false } = {}) {
    const ex = item.exercise;
    const payload = {
        itemId: item.id,
        orderIndex: item.orderIndex,
        mode: ex.mode,
        durationMs: ex.durationMs,
        wpm: ex.wpm,
        toneFrequencyHz: ex.toneFrequencyHz,
    };
    if (ex.mode === 'audio_to_text' || ex.mode === 'character_recognition') {
        payload.plan = ex.plan;
    } else if (ex.mode === 'morse_to_text') {
        payload.promptMorse = ex.morse;
    } else if (ex.mode === 'text_to_morse') {
        payload.promptText = ex.text;
    } else if (ex.mode === 'transmission') {
        // The target is meant to be visible the whole time — not withheld
        // like other modes' answers — see transmissionEngine.js. Only the
        // classification tolerance is included beyond the plain text, so
        // the client's live TransmissionEngine uses the exact same bands
        // the server will grade with; it's a display/timing knob, not the
        // answer, so there's nothing to protect by omitting it.
        payload.promptText = ex.text;
        payload.groupSize = ex.groupSize;
        payload.toleranceFactor = ex.toleranceFactor;
    }
    if (includeAnswer) {
        payload.expectedAnswer = ex.expectedAnswer;
    }
    return payload;
}

/**
 * Schedules item `itemIndex`'s synchronized start: broadcasts the future
 * timestamp now (so clients can preload + estimate clock offset before
 * it arrives), then a local timer fires `activateItem` at that instant.
 */
function scheduleItem(sessionId, itemIndex) {
    const session = sessionRepository.findByIdPublic(sessionId);
    if (!session || session.status !== 'running') return;

    const item = sessionRepository.getItemByIndex(sessionId, itemIndex);
    if (!item) {
        finalizeSession(sessionId);
        return;
    }

    const startAt = Date.now() + session.prepTimeMs;
    const state = getOrCreateState(sessionId);
    state.scheduledStartAt = startAt;
    state.currentItemIndex = itemIndex;
    state.currentDeadlineAt = null;

    hub.broadcast(sessionId, {
        type: 'scheduled_start',
        itemIndex,
        itemsTotal: sessionRepository.countItems(sessionId),
        startAt,
        serverNow: Date.now(),
        item: publicItemPayload(item),
    });

    scheduleTimer(sessionId, () => activateItem(sessionId, itemIndex), startAt - Date.now());
}

function activateItem(sessionId, itemIndex) {
    const session = sessionRepository.findByIdPublic(sessionId);
    if (!session || session.status !== 'running') return;

    sessionRepository.setCurrentItemIndex(sessionId, itemIndex);
    const item = sessionRepository.getItemByIndex(sessionId, itemIndex);
    const answerWindowMs = session.answerTimeMs || DEFAULT_ANSWER_TIME_MS;
    const deadlineAt = Date.now() + item.exercise.durationMs + answerWindowMs;

    const state = getOrCreateState(sessionId);
    state.currentDeadlineAt = deadlineAt;

    // Includes the full item payload (not just the index) so a client that
    // reconnects mid-item — or whose earlier `scheduled_start` message was
    // lost — can resync from this broadcast alone. The expected answer is
    // deliberately included here (and only here — never
    // in scheduleItem's earlier scheduled_start broadcast, which fires
    // before the item has actually begun) so it's already legitimately in
    // every connected client's own memory once that item goes live.
    hub.broadcast(sessionId, {
        type: 'item_active',
        itemIndex,
        itemsTotal: sessionRepository.countItems(sessionId),
        deadlineAt,
        serverNow: Date.now(),
        item: publicItemPayload(item, { includeAnswer: true }),
    });

    scheduleTimer(sessionId, () => closeItem(sessionId, itemIndex), deadlineAt - Date.now());
}

function closeItem(sessionId, itemIndex) {
    const session = sessionRepository.findByIdPublic(sessionId);
    if (!session || session.status !== 'running') return;

    hub.broadcast(sessionId, { type: 'item_closed', itemIndex });

    const total = sessionRepository.countItems(sessionId);
    if (itemIndex + 1 < total) {
        scheduleTimer(sessionId, () => scheduleItem(sessionId, itemIndex + 1), INTER_ITEM_GAP_MS);
    } else {
        finalizeSession(sessionId);
    }
}

function finalizeSession(sessionId) {
    clearTimers(sessionId);
    const info = sessionRepository.transitionStatus(sessionId, ['running', 'paused'], 'finished', {
        ended_at: new Date().toISOString(),
    });
    if (info.changes > 0) {
        hub.broadcast(sessionId, { type: 'session_finished', results: sessionRepository.listResultsForSession(sessionId) });
        hub.broadcastSessionState(sessionId);
        logger.info(`Session ${sessionId} finished (all items complete).`);
        // A finished Formal Test gets TEMPORARY gradebook entries (no-op for group practice).
        gradebookService.safeRecordFormalTestResults(sessionId);
    }
    runtimeStates.delete(sessionId);
}

/** Called by the controller right after a waiting->running DB transition. */
function startSession(sessionId) {
    scheduleItem(sessionId, 0);
}

/** Called by the controller right after a running->paused DB transition. Freezes progress; resume restarts the current item fresh. */
function pauseSession(sessionId) {
    clearTimers(sessionId);
}

/** Called by the controller right after a paused->running DB transition. */
function resumeSession(sessionId) {
    const session = sessionRepository.findByIdPublic(sessionId);
    scheduleItem(sessionId, session.currentItemIndex);
}

/** Called by the controller on stop/cancel — halts all timers without changing DB status itself (the controller already did that). */
function haltSession(sessionId) {
    clearTimers(sessionId);
    runtimeStates.delete(sessionId);
}

/** Read-only snapshot for the controller to validate a submission's timing against ("client timers are for display only"). */
function getRuntimeState(sessionId) {
    const state = runtimeStates.get(sessionId);
    if (!state) return null;
    return {
        scheduledStartAt: state.scheduledStartAt,
        currentDeadlineAt: state.currentDeadlineAt,
        currentItemIndex: state.currentItemIndex,
    };
}

module.exports = {
    DEFAULT_ANSWER_TIME_MS,
    startSession,
    pauseSession,
    resumeSession,
    haltSession,
    getRuntimeState,
    publicItemPayload,
};
