const express = require('express');
const supabase = require('../../services/supabase');
const { localDate, isDateString, addDays, quizWeekStart, isUuid } = require('../services/content');
const { pickQuizQuestions, publicQuestion, gradeQuiz } = require('../services/quiz');
const { EXCELLENCE_PERCENT } = require('../services/rewards');
const { check } = require('../services/db');
const { requireSelf } = require('../middleware/auth');
const { readStudent, handle } = require('./helpers');

const router = express.Router();

async function weekQuestions(ageGroup, weekStart) {
  const rows = check(await supabase.from('ca_quiz_questions').select('*')
    .eq('status', 'published').eq('age_group', ageGroup).eq('week_start', weekStart)
    .order('position', { ascending: true }));
  return pickQuizQuestions(rows || []);
}

async function findAttempt(email, ageGroup, weekStart) {
  return check(await supabase.from('ca_quiz_attempts').select('*')
    .eq('student_email', email).eq('age_group', ageGroup).eq('week_start', weekStart)
    .maybeSingle());
}

// A stored attempt → the result the app shows (graded against the week's questions).
function attemptResult(attempt, questions) {
  const answers = (attempt.answers || []).map((a) => ({ questionId: a.questionId, answer: a.selected }));
  const graded = gradeQuiz(questions, answers);
  return {
    attemptId: attempt.id,
    weekStart: attempt.week_start,
    score: attempt.score,
    total: attempt.total,
    percentage: attempt.percentage,
    excellence: attempt.percentage >= EXCELLENCE_PERCENT,
    pointsAwarded: !!attempt.points_awarded,
    results: graded.results,
  };
}

// Record one checked answer into the student's in-progress attempt. The first
// answer recorded for a question is final — later checks for the same question
// return the recorded result without changing it. Returns the graded result
// for this one question only (correctIndex/explanation revealed once answered).
async function recordAnswer(email, ageGroup, weekStart, questionRow, selected) {
  let attempt = await findAttempt(email, ageGroup, weekStart);
  const answers = (attempt?.answers || []).map((a) => ({ ...a }));
  const existing = answers.find((a) => a.questionId === questionRow.id);
  if (existing) {
    // Already answered — return the recorded result without changing it.
    return { attemptId: attempt.id, selected: existing.selected, ...existing.result };
  }
  // Create the attempt row on first answer if none exists.
  if (!attempt) {
    const inserted = check(await supabase.from('ca_quiz_attempts')
      .insert({ student_email: email, age_group: ageGroup, week_start: weekStart, status: 'in_progress' })
      .select());
    attempt = inserted[0];
  }
  // Compute this question's result from the recorded answer (server-side only).
  const result = {
    questionId: questionRow.id,
    selected,
    correctIndex: questionRow.correct_index,
    explanation: questionRow.explanation,
    extraFact: questionRow.extra_fact || null,
    storyId: questionRow.story_id || null,
    correct: selected === questionRow.correct_index,
  };
  const updatedAnswers = [...answers, result];
  check(await supabase.from('ca_quiz_attempts')
    .update({ answers: updatedAnswers }).eq('id', attempt.id));
  return { attemptId: attempt.id, selected, ...result };
}

// The weekly quiz runs from Sunday 00:00 IST to Saturday 23:59 IST. After
// Saturday 11:59 PM IST the quiz closes: only the current week's quiz is
// submittable, and past quizzes give no points. Viewing is still allowed for
// last week (to review a completed attempt); submission is not.
function resolveWeek(requested, now = new Date()) {
  const current = quizWeekStart(localDate(now));
  if (requested === undefined || requested === null || requested === '') return current;
  if (!isDateString(requested)) return null;
  return requested === current ? current : null;
}
// Viewing also allows last week's quiz (to review a completed attempt).
function resolveWeekView(requested, now = new Date()) {
  const current = quizWeekStart(localDate(now));
  if (requested === undefined || requested === null || requested === '') return current;
  if (!isDateString(requested)) return null;
  return (requested === current || requested === addDays(current, -7)) ? requested : null;
}

// ── GET /current-affairs/quiz/week?ageGroup=7-12&studentEmail=&weekStart= ───
// This week's 10 questions without answers. With studentEmail, also the
// student's attempt if they already took it (attempt: null otherwise).
router.get('/week', requireSelf((req) => req.query.studentEmail), handle(async (req, res) => {
  const student = readStudent(res, req.query, { emailRequired: false });
  if (!student) return;
  const { ageGroup, email } = student;
  const weekStart = resolveWeekView(req.query.weekStart);
  if (!weekStart) return res.status(400).json({ error: "weekStart must be this week's or last week's Sunday (YYYY-MM-DD)" });

  const questions = await weekQuestions(ageGroup, weekStart);
  let attempt = null;
  if (email && questions.length) {
    const row = await findAttempt(email, ageGroup, weekStart);
    if (row) attempt = attemptResult(row, questions);
  }
  res.json({
    weekStart,
    ageGroup,
    total: questions.length,
    questions: questions.map(publicQuestion),
    attempt,
  });
}));

// ── POST /current-affairs/quiz/check { studentEmail, ageGroup, questionId, answer } ──
// Requires the student's sign-in. Records the answer server-side on the
// in-progress attempt (first answer is final) and reveals only that question's
// correct index/explanation. Never returns the answer key before recording.
router.post('/check', requireSelf((req) => req.body?.studentEmail), handle(async (req, res) => {
  const body = req.body || {};
  const { questionId, answer } = body;
  if (!isUuid(questionId)) return res.status(400).json({ error: 'questionId required' });
  if (!Number.isInteger(answer) || answer < 0) return res.status(400).json({ error: 'answer must be the option index' });

  const student = readStudent(res, body, { emailRequired: true });
  if (!student) return;
  const { ageGroup, email } = student;
  const weekStart = quizWeekStart(localDate());

  const row = check(await supabase.from('ca_quiz_questions').select('*')
    .eq('id', questionId).eq('status', 'published').eq('age_group', ageGroup).eq('week_start', weekStart)
    .maybeSingle());
  if (!row) return res.status(404).json({ error: 'Question not found' });
  if (answer >= row.options.length) return res.status(400).json({ error: 'answer is not one of the options' });

  const result = await recordAnswer(email, ageGroup, weekStart, row, answer);
  res.json(result);
}));

// ── POST /current-affairs/quiz/submit { studentEmail, ageGroup, weekStart? } ──
// Grades ONLY the answers recorded server-side via /check, stores the attempt
// as submitted, and returns the result. A second submit returns the first
// result (alreadySubmitted: true). Past-week quizzes are rejected by resolveWeek.
router.post('/submit', requireSelf((req) => req.body?.studentEmail), handle(async (req, res) => {
  const body = req.body || {};
  const student = readStudent(res, body, { emailRequired: true });
  if (!student) return;
  const { ageGroup, email } = student;
  const weekStart = resolveWeek(body.weekStart);
  if (!weekStart) return res.status(400).json({ error: "weekStart must be this week's Sunday (YYYY-MM-DD)" });

  const questions = await weekQuestions(ageGroup, weekStart);
  if (!questions.length) return res.status(404).json({ error: 'There is no quiz for this week yet' });

  let attempt = await findAttempt(email, ageGroup, weekStart);
  // Already submitted → return the first result.
  if (attempt && attempt.status === 'submitted') {
    return res.json({ ...attemptResult(attempt, questions), alreadySubmitted: true });
  }
  // Create the attempt row if the student never checked any answer.
  if (!attempt) {
    const inserted = check(await supabase.from('ca_quiz_attempts')
      .insert({ student_email: email, age_group: ageGroup, week_start: weekStart, status: 'in_progress' })
      .select());
    attempt = inserted[0];
  }
  // Grade only the recorded answers.
  const recorded = attempt.answers || [];
  const graded = gradeQuiz(questions, recorded.map((a) => ({ questionId: a.questionId, answer: a.selected })));
  check(await supabase.from('ca_quiz_attempts')
    .update({
      answers: graded.results.map((r) => ({ questionId: r.questionId, selected: r.selected, correctIndex: r.correctIndex, correct: r.correct })),
      score: graded.score,
      total: graded.total,
      percentage: graded.percentage,
      status: 'submitted',
    }).eq('id', attempt.id));

  const finalAttempt = await findAttempt(email, ageGroup, weekStart);
  res.json({ ...attemptResult(finalAttempt, questions), alreadySubmitted: false });
}));

module.exports = router;
