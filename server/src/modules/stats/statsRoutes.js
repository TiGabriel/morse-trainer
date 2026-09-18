const express = require('express');
const statsController = require('./statsController');
const { requireAuth, requireRole, requireSelfOrTeacher } = require('../../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// A student may view their own stats; a teacher may view any student's.
router.get('/students/:id', requireSelfOrTeacher('id'), statsController.getStudentStats);

// Class-wide statistics are teacher-only.
router.get('/classes/:id', requireRole('teacher'), statsController.getClassStats);

module.exports = router;
