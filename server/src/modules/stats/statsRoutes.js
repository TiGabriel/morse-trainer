const express = require('express');
const statsController = require('./statsController');
const { requireAuth, requireRole, requireSelfOrTeacher } = require('../../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// A student may view their own stats; a teacher may view any student's.
router.get('/students/:id', requireSelfOrTeacher('id'), statsController.getStudentStats);
router.get('/students/:id/history', requireSelfOrTeacher('id'), statsController.getStudentHistory);

// Deleting/resetting results is teacher-only — never self-service, even
// for a student's own data (students cannot erase their own history).
router.delete('/students/:id/history/:attemptId', requireRole('teacher'), statsController.deleteStudentAttempt);
router.delete('/students/:id/history', requireRole('teacher'), statsController.resetStudentHistory);

// Class-wide statistics, the cross-student result browser, and CSV
// export are all teacher-only.
router.get('/classes/:id', requireRole('teacher'), statsController.getClassStats);
router.get('/classes/:id/attempts', requireRole('teacher'), statsController.getClassAttempts);
router.get('/classes/:id/export.csv', requireRole('teacher'), statsController.exportClassCsv);

module.exports = router;
