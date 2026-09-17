const express = require('express');
const classesController = require('./classesController');
const { requireAuth, requireRole } = require('../../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Any authenticated user (teacher or student) can view the list of classes.
router.get('/', classesController.listClasses);

// Everything below is teacher-only.
router.post('/', requireRole('teacher'), classesController.createClass);
router.patch('/:id', requireRole('teacher'), classesController.updateClass);
router.patch('/:id/status', requireRole('teacher'), classesController.setClassActive);
router.delete('/:id', requireRole('teacher'), classesController.deleteClass);

module.exports = router;
