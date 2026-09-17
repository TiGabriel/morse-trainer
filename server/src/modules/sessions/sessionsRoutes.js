const express = require('express');
const sessionsController = require('./sessionsController');
const { requireAuth, requireRole } = require('../../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Student-facing (order matters: /available must not be swallowed by /:id).
router.get('/available', sessionsController.listAvailable);

// Teacher-only management.
router.post('/', requireRole('teacher'), sessionsController.createSession);
router.get('/', requireRole('teacher'), sessionsController.listSessions);

// Shared read (teacher: full roster; student: own-class-only view — enforced in the controller).
router.get('/:id', sessionsController.getSession);
router.get('/:id/results', sessionsController.getResults);

// Teacher-only state transitions.
router.post('/:id/open', requireRole('teacher'), sessionsController.openSession);
router.post('/:id/start', requireRole('teacher'), sessionsController.startSession);
router.post('/:id/pause', requireRole('teacher'), sessionsController.pauseSession);
router.post('/:id/resume', requireRole('teacher'), sessionsController.resumeSession);
router.post('/:id/stop', requireRole('teacher'), sessionsController.stopSession);
router.post('/:id/cancel', requireRole('teacher'), sessionsController.cancelSession);

// Student-only submission.
router.post('/:id/items/:itemId/attempts', sessionsController.submitAttempt);

module.exports = router;
