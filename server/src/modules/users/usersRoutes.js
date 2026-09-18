const express = require('express');
const usersController = require('./usersController');
const { requireAuth, requireRole, requireSelfOrTeacher } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');

const router = express.Router();

// All routes below require a logged-in session.
router.use(requireAuth);

// Teacher-only: create a new account (teacher or student).
router.post('/', requireRole('teacher'), asyncHandler(usersController.createUser));

// Teacher-only: list/search/filter every account.
router.get('/', requireRole('teacher'), usersController.listUsers);

// Teacher OR the user themselves: view one account's profile.
// (This is the concrete enforcement of "students can't see other
// students' private data" — a student id that isn't their own is denied.)
router.get('/:id', requireSelfOrTeacher('id'), usersController.getUser);

// Teacher-only: edit profile fields (rank, name, class, username).
// Students cannot edit their own profile in this phase, by design.
router.patch('/:id', requireRole('teacher'), usersController.updateUser);

// Teacher-only: activate/deactivate an account.
router.patch('/:id/status', requireRole('teacher'), usersController.setActiveStatus);

// Teacher-only: reset a student's (or teacher's) password.
router.post('/:id/reset-password', requireRole('teacher'), asyncHandler(usersController.resetPassword));

module.exports = router;
