const express = require('express');
const supabase = require('../../services/supabase');
const { localDate, isDateString, addDays, quizWeekStart, isUuid } = require('../services/content');
const { pickQuizQuestions, publicQuestion, reveal, gradeQuiz } = require('../services/quiz');
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

// An attempt row is created by the first /check (answers recorded, total 0)
// and graded by /submit (total = number of questions, always > 0). Only a
// submitted attempt is a result: points, analytics and the app ignore the rest.
const isSubmitted = (attempt) => !!attempt && Number(attempt.total) > 0;
const ATTEMPT_KEY = 'student_email,age_group,week_start';

// Records the student's answer to one question the first time they check it
// and returns the answer that counts. The first answer is final: checking
// again (to see other options' results) returns the recorded one, so the
// answer key cannot be probed before submitting.
async function recordAnswer(email, ageGroup, question, answer) {
  for (let tries = 0; tries < 3; tries++) {
    const attempt = await findAttempt(email, ageGroup, question.week_start);
    const answers = Array.isArray(attempt?.answers) ? attempt.answers : [];
    const earlier = answers.find((a) => a && String(a.questionId) === String(question.id));
    if (earlier && Number.isInteger(earlier.selected)) return earlier.selected;
    // Already submitted (question left blank): nothing more to record.
    if (isSubmitted(attempt)) return answer;
    const next = [...answers, { questionId: question.id, selected: answer }];
    if (!attempt) {
      const inserted = check(await supabase.from('ca_quiz_attempts')
        .upsert({
          student_email: email, age_group: ageGroup, week_start: question.week_start,
          answers: next, score: 0, total: 0, percentage: 0,
        }, { onConflict: ATTEMPT_KEY, ignoreDuplicates: true })
        .select());
      if (inserted?.length) return answer;
      continue; // created a moment ago by another request: read it again
    }
    const updated = check(await supabase.from('ca_quiz_attempts')
      .update({ answers: next }).eq('id', attempt.id).eq('total', 0).select('id'));
    if (updated?.length) return answer;
  }
  throw new Error('Could not record the answer');
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

// weekStart from the client must be this week's Sunday or last week's
// (a quiz started on Saturday night can still be submitted after midnight).
function resolveWeek(requested, today) {
  const current = quizWeekStart(today);
  if (requested === undefined || requested === null || requested === '') return current;
  if (!isDateString(requested)) return null;
  return requested === current || requested === addDays(current, -7) ? requested : null;
}

// ── GET /current-affairs/quiz/week?ageGroup=7-12&studentEmail=&weekStart= ───
// This week's 10 questions without answers. With studentEmail, also the
// student's attempt if they already took it (attempt: null otherwise).
router.get('/week', requireSelf((req) => req.query.studentEmail), handle(async (req, res) => {
  const student = readStudent(res, req.query, { emailRequired: false });
  if (!student) return;
  const { ageGroup, email } = student;
  const weekStart = resolveWeek(req.query.weekStart, localDate());
  if (!weekStart) return res.status(400).json({ error: "weekStart must be this week's or last week's Sunday (YYYY-MM-DD)" });

  const questions = await weekQuestions(ageGroup, weekStart);
  let attempt = null;
  if (email && questions.length) {
    const row = await findAttempt(email, ageGroup, weekStart);
    if (isSubmitted(row)) attempt = attemptResult(row, questions);
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
// The student's own sign-in is required. Records the answer (the first answer
// to a question is final), then reveals that question's answer, explanation
// and extra fact. Without the record, anyone could try every option of every
// question and then submit a perfect quiz for points and badges.
router.post('/check', requireSelf((req) => req.body?.studentEmail), handle(async (req, res) => {
  const body = req.body || {};
  const { questionId, answer } = body;
  if (!isUuid(questionId)) return res.status(400).json({ error: 'questionId required' });
  if (!Number.isInteger(answer) || answer < 0) return res.status(400).json({ error: 'answer must be the option index' });
  const student = readStudent(res, body, { emailRequired: true });
  if (!student) return;
  const { ageGroup, email } = student;

  const row = check(await supabase.from('ca_quiz_questions').select('*')
    .eq('id', questionId).eq('status', 'published').eq('age_group', ageGroup).maybeSingle());
  // Only this week's or last week's quiz can be played (same rule as /submit).
  if (!row || !resolveWeek(row.week_start, localDate())) return res.status(404).json({ error: 'Question not found' });
  if (answer >= row.options.length) return res.status(400).json({ error: 'answer is not one of the options' });

  const selected = await recordAnswer(email, ageGroup, row, answer);
  res.json({ questionId, selected, correct: selected === row.correct_index, ...reveal(row) });
}));

// ── POST /current-affairs/quiz/submit { studentEmail, ageGroup, answers, weekStart? } ──
// Grades on the server and stores one attempt per student per week. Answers
// already checked with /check are final; `answers` fills in the rest. A
// second submit for the same week returns the first result (alreadySubmitted: true).
router.post('/submit', requireSelf((req) => req.body?.studentEmail), handle(async (req, res) => {
  const body = req.body || {};
  const student = readStudent(res, body, { emailRequired: true });
  if (!student) return;
  const { ageGroup, email } = student;
  if (!Array.isArray(body.answers)) return res.status(400).json({ error: 'answers must be an array of { questionId, answer }' });
  const weekStart = resolveWeek(body.weekStart, localDate());
  if (!weekStart) return res.status(400).json({ error: "weekStart must be this week's or last week's Sunday (YYYY-MM-DD)" });

  const questions = await weekQuestions(ageGroup, weekStart);
  if (!questions.length) return res.status(404).json({ error: 'There is no quiz for this week yet' });

  const sent = new Map(body.answers.filter((a) => a && a.questionId).map((a) => [String(a.questionId), a.answer]));
  for (let tries = 0; tries < 3; tries++) {
    const existing = await findAttempt(email, ageGroup, weekStart);
    if (isSubmitted(existing)) return res.json({ ...attemptResult(existing, questions), alreadySubmitted: true });

    const recorded = new Map((existing?.answers || []).filter((a) => a && a.questionId)
      .map((a) => [String(a.questionId), a.selected]));
    const final = questions.map((q) => ({
      questionId: q.id,
      answer: recorded.has(String(q.id)) ? recorded.get(String(q.id)) : sent.get(String(q.id)),
    }));
    const graded = gradeQuiz(questions, final);
    const fields = {
      answers: graded.results.map((r) => ({
        questionId: r.questionId, selected: r.selected, correctIndex: r.correctIndex, correct: r.correct,
      })),
      score: graded.score,
      total: graded.total,
      percentage: graded.percentage,
    };

    const saved = existing
      // Only while still in progress (total 0): two submits cannot both grade it.
      ? check(await supabase.from('ca_quiz_attempts').update(fields).eq('id', existing.id).eq('total', 0).select())
      : check(await supabase.from('ca_quiz_attempts')
        .upsert({ student_email: email, age_group: ageGroup, week_start: weekStart, ...fields },
          { onConflict: ATTEMPT_KEY, ignoreDuplicates: true })
        .select());
    if (saved?.length) return res.json({ ...attemptResult(saved[0], questions), alreadySubmitted: false });
    // Another request got there first: read the attempt again.
  }
  throw new Error('Could not save the quiz');
}));

module.exports = router;
