const express = require('express');
const practiceController = require('./practiceController');
const { requireAuth } = require('../../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.post('/exercises', practiceController.generateExercise);
router.post('/attempts', practiceController.submitAttempt);
router.get('/history', practiceController.listHistory);

router.get('/charsets', practiceController.getCharsets);
router.post('/radiograms', practiceController.generateRadiogram);
router.post('/radiograms/analyze', practiceController.analyzeRadiogram);
router.post('/character-training/sessions', practiceController.generateCharacterTrainingSession);
router.post('/character-training/attempts', practiceController.submitCharacterTrainingAttempt);
router.post('/reception/exercises', practiceController.generateReceptionExercise);
router.post('/reception/attempts', practiceController.submitReceptionAttempt);
router.post('/transmission/exercises', practiceController.generateTransmissionExercise);
router.post('/transmission/attempts', practiceController.submitTransmissionAttempt);

module.exports = router;
