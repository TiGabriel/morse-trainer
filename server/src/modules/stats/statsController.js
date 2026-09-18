const statsRepository = require('./statsRepository');
const classRepository = require('../classes/classRepository');
const userRepository = require('../users/userRepository');

/** GET /api/stats/students/:id — teacher, or the student themselves (enforced by requireSelfOrTeacher in the route). */
function getStudentStats(req, res) {
    const studentId = Number(req.params.id);
    const user = userRepository.findById(studentId);
    if (!user || user.role !== 'student') {
        return res.status(404).json({ error: 'Student not found.' });
    }

    return res.json({
        practice: statsRepository.getStudentPracticeSummary(studentId),
        accuracyByDay: statsRepository.getStudentAccuracyByDay(studentId, { days: 14 }),
        sessions: statsRepository.getStudentSessionSummary(studentId),
    });
}

/** GET /api/stats/classes/:id — teacher-only (enforced in the route). */
function getClassStats(req, res) {
    const classId = Number(req.params.id);
    const cls = classRepository.findById(classId);
    if (!cls) {
        return res.status(404).json({ error: 'Class not found.' });
    }

    return res.json({
        className: cls.name,
        studentCount: statsRepository.getClassStudentIds(classId).length,
        practice: statsRepository.getClassPracticeSummary(classId),
        sessions: statsRepository.getClassSessionSummary(classId),
        students: statsRepository.getClassStudentBreakdown(classId),
    });
}

module.exports = { getStudentStats, getClassStats };
