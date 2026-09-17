const express = require('express');
const practiceController = require('./practiceController');
const { requireAuth } = require('../../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.post('/exercises', practiceController.generateExercise);
router.post('/attempts', practiceController.submitAttempt);
router.get('/history', practiceController.listHistory);

module.exports = router;
