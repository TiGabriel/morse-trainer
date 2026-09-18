const express = require('express');
const authController = require('./authController');
const { requireAuth } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');

const router = express.Router();

router.post('/login', asyncHandler(authController.login));
router.post('/logout', requireAuth, authController.logout);
router.get('/me', requireAuth, authController.me);

module.exports = router;
