const express = require('express');
const gradebookController = require('./gradebookController');
const { requireAuth, requireRole } = require('../../middleware/auth');

const router = express.Router();

// The whole electronic gradebook is teacher-only — reading included.
// Students have no route here at all, not even for their own entries.
router.use(requireAuth);
router.use(requireRole('teacher'));

router.get('/pending-counts', gradebookController.getPendingCounts);
router.get('/students/:studentId/entries', gradebookController.listStudentEntries);
router.post('/students/:studentId/entries', gradebookController.createEntry);
router.patch('/entries/:entryId', gradebookController.updateEntry);
router.post('/entries/:entryId/confirm', gradebookController.confirmEntry);
router.delete('/entries/:entryId', gradebookController.deleteEntry);

module.exports = router;
