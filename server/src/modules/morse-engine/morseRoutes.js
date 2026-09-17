const express = require('express');
const morseController = require('./morseController');
const { requireAuth, requireRole } = require('../../middleware/auth');

const router = express.Router();

router.use(requireAuth);
router.use(requireRole('teacher'));

router.post('/preview', morseController.preview);
router.get('/random', morseController.randomText);

module.exports = router;
