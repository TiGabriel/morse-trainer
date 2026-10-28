const express = require('express');
const gradebookController = require('./gradebookController');
const { requireAuth, requireRole } = require('../../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// The one student route: read-only, self-scoped (req.user.id — never a
// URL param), official grades only. See gradebookController.listMyGrades.
router.get('/me', requireRole('student'), gradebookController.listMyGrades);

// Everything else in the electronic gradebook is teacher-only — reading included.
router.use(requireRole('teacher'));

router.get('/pending-counts', gradebookController.getPendingCounts);
router.get('/students/:studentId/entries', gradebookController.listStudentEntries);
router.post('/students/:studentId/entries', gradebookController.createEntry);
router.patch('/entries/:entryId', gradebookController.updateEntry);
router.post('/entries/:entryId/confirm', gradebookController.confirmEntry);
router.delete('/entries/:entryId', gradebookController.deleteEntry);

module.exports = router;
