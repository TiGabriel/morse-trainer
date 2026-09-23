const express = require('express');
const morseController = require('./morseController');
const { requireAuth, requireRole } = require('../../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// The Morse Alphabet reference page is for every logged-in user
// (teacher AND student) — registered before the teacher-only gate below.
router.get('/alphabet', morseController.alphabet);

router.use(requireRole('teacher'));

router.post('/preview', morseController.preview);
router.get('/random', morseController.randomText);

module.exports = router;
