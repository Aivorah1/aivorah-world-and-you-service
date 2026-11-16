jest.mock('../../services/supabase', () => require('./helpers/fakeSupabase').createFakeSupabase());
jest.mock('../../services/firebaseAdmin', () => require('./helpers/fakeFirebase'));
// index.js also loads World & You's AI routes, which create a Groq client on load.
jest.mock('../../services/dailyTidbit', () => ({}));
jest.mock('../../services/world', () => ({}));

const request = require('supertest');
const app = require('../../index');
const supabase = require('../../services/supabase');
const { pickQuizQuestions, gradeQuiz } = require('../../current-affairs/services/quiz');
const { freezeTime, questionRow, weekQuestions, auth } = require('./helpers/fixtures');

const EMAIL = 'kid@school.in';
const SLOT = { india: 'india', world: 'world', science: 'science', economy: 'econ-env', environment: 'econ-env', sports: 'sports-society', society: 'sports-society' };

beforeEach(() => {
  supabase.__reset();
  freezeTime('2026-11-09T06:00:00Z'); // Monday; this week's quiz was released Sunday 8 Nov
});
afterEach(() => jest.useRealTimers());

const countBy = (list, fn) => list.reduce((acc, x) => ({ ...acc, [fn(x)]: (acc[fn(x)] || 0) + 1 }), {});

// Answers every question; the first `correct` of them right.
function answersFor(rows, correct) {
  return rows.map((q, i) => ({ questionId: q.id, answer: i < correct ? q.correct_index : (q.correct_index + 1) % q.options.length }));
}

function submit(body, email = EMAIL) {
  return request(app).post('/current-affairs/quiz/submit').set(auth(email)).send({ studentEmail: email, ageGroup: '7-12', ...body });
}

// Helper: check answers server-side via /check, then submit grades the recorded ones.
async function takeQuiz(rows, correctCount, email = EMAIL, ageGroup = '7-12', weekStart) {
  for (let i = 0; i < rows.length; i++) {
    const selected = i < correctCount ? rows[i].correct_index : (rows[i].correct_index + 1) % rows[i].options.length;
    await request(app).post('/current-affairs/quiz/check').set(auth(email))
      .send({ studentEmail: email, ageGroup, questionId: rows[i].id, answer: selected });
  }
  return request(app).post('/current-affairs/quiz/submit').set(auth(email))
    .send({ studentEmail: email, ageGroup, weekStart });
}

describe('GET /current-affairs/quiz/week', () => {
  test('returns 10 questions: 2 per category group, 6 MCQ / 2 true-false / 2 reasoning, no answers', async () => {
    supabase.__seed('ca_quiz_questions', weekQuestions());
    const res = await request(app).get('/current-affairs/quiz/week?ageGroup=7-12');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ weekStart: '2026-11-08', ageGroup: '7-12', total: 10, attempt: null });
    const qs = res.body.questions;
    expect(qs).toHaveLength(10);
    expect(countBy(qs, (q) => SLOT[q.category])).toEqual({ india: 2, world: 2, science: 2, 'econ-env': 2, 'sports-society': 2 });
    expect(countBy(qs, (q) => q.type)).toEqual({ mcq: 6, true_false: 2, reasoning: 2 });
    for (const q of qs) {
      expect(q).not.toHaveProperty('correct_index');
      expect(q).not.toHaveProperty('correctIndex');
      expect(q).not.toHaveProperty('explanation');
      expect(Object.keys(q).sort()).toEqual(['category', 'id', 'options', 'question', 'storyId', 'type']);
    }
  });

  test("only this week's published questions for the age group", async () => {
    supabase.__seed('ca_quiz_questions', [
      ...weekQuestions(),
      ...weekQuestions({ age_group: '13-15' }),
      ...weekQuestions({ week_start: '2026-11-01' }),
      questionRow({ status: 'review', category: 'india' }),
    ]);
    const res = await request(app).get('/current-affairs/quiz/week?ageGroup=7-12');
    expect(res.body.questions).toHaveLength(10);
    const ids = new Set(supabase.__rows('ca_quiz_questions')
      .filter((q) => q.age_group === '7-12' && q.week_start === '2026-11-08' && q.status === 'published').map((q) => q.id));
    expect(res.body.questions.every((q) => ids.has(q.id))).toBe(true);
  });

  test('returns an empty quiz when none is published yet', async () => {
    const res = await request(app).get('/current-affairs/quiz/week?ageGroup=13-15');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 0, questions: [] });
  });

  test('old values: 8-12 and under-8 get the 7-12 quiz, 13+ the 13-15 quiz', async () => {
    supabase.__seed('ca_quiz_questions', [...weekQuestions(), ...weekQuestions({ age_group: '13-15' })]);
    for (const [sent, expected] of [['8-12', '7-12'], ['under-8', '7-12'], ['13%2B', '13-15']]) {
      const res = await request(app).get(`/current-affairs/quiz/week?ageGroup=${sent}`);
      expect(res.body).toMatchObject({ ageGroup: expected, total: 10 });
    }
  });

  test("with studentEmail, includes the student's attempt once they have taken it", async () => {
    const rows = weekQuestions();
    supabase.__seed('ca_quiz_questions', rows);
    await takeQuiz(rows, 6);
    const res = await request(app).get(`/current-affairs/quiz/week?ageGroup=7-12&studentEmail=${EMAIL}`).set(auth(EMAIL));
    expect(res.body.attempt).toMatchObject({ score: 6, total: 10, percentage: 60 });
    expect(res.body.attempt.results).toHaveLength(10);
  });

  test("a weekStart older than last week is rejected", async () => {
    expect((await request(app).get('/current-affairs/quiz/week?ageGroup=7-12&weekStart=2026-11-01')).status).toBe(200);
    expect((await request(app).get('/current-affairs/quiz/week?ageGroup=7-12&weekStart=2026-10-25')).status).toBe(400);
    expect((await request(app).get('/current-affairs/quiz/week?ageGroup=7-12&weekStart=nope')).status).toBe(400);
  });
});

describe('pickQuizQuestions', () => {
  test('keeps the category and type mix when there are more than 10 candidates', () => {
    const extra = [
      questionRow({ category: 'india', question_type: 'mcq', position: 0 }),
      questionRow({ category: 'india', question_type: 'mcq', position: 0 }),
      questionRow({ category: 'sports', question_type: 'reasoning', position: 0 }),
      questionRow({ category: 'world', question_type: 'true_false', position: 0 }),
    ];
    const picked = pickQuizQuestions([...extra, ...weekQuestions()]);
    expect(picked).toHaveLength(10);
    expect(countBy(picked, (q) => SLOT[q.category])).toEqual({ india: 2, world: 2, science: 2, 'econ-env': 2, 'sports-society': 2 });
    expect(countBy(picked, (q) => q.question_type)).toEqual({ mcq: 6, true_false: 2, reasoning: 2 });
  });

  test('tops up from other categories when one group is short', () => {
    const rows = weekQuestions().filter((q) => q.category !== 'science');
    rows.push(questionRow({ category: 'india', question_type: 'mcq' }), questionRow({ category: 'world', question_type: 'true_false' }));
    expect(pickQuizQuestions(rows)).toHaveLength(10);
  });
});

describe('gradeQuiz', () => {
  test('scores, percentage and per-question review with the correct answer', () => {
    const rows = weekQuestions();
    const graded = gradeQuiz(rows, answersFor(rows, 7));
    expect(graded).toMatchObject({ score: 7, total: 10, percentage: 70 });
    expect(graded.results[0]).toMatchObject({ correct: true, selected: rows[0].correct_index, correctIndex: 1, explanation: 'Because.', extraFact: 'Extra fact.' });
    expect(graded.results[9].correct).toBe(false);
  });

  test('missing, non-integer and out-of-range answers count as wrong', () => {
    const rows = weekQuestions().slice(0, 3);
    const graded = gradeQuiz(rows, [
      { questionId: rows[0].id, answer: 7 },
      { questionId: rows[1].id, answer: '1' },
    ]);
    expect(graded.score).toBe(0);
    expect(graded.results.map((r) => r.selected)).toEqual([null, null, null]);
    expect(gradeQuiz(rows.slice(0, 3), [{ questionId: rows[0].id, answer: 1 }]).percentage).toBe(33);
  });
});

describe('POST /current-affairs/quiz/check', () => {
  test('requires sign-in and records the answer server-side, revealing the result once recorded', async () => {
    const [q] = weekQuestions();
    supabase.__seed('ca_quiz_questions', [q]);
    // Without studentEmail (no sign-in target) → 400 studentEmail required.
    expect((await request(app).post('/current-affairs/quiz/check').send({ questionId: q.id, answer: 1 })).status).toBe(400);
    // Signed in as the student, recording the correct answer.
    const right = await request(app).post('/current-affairs/quiz/check').set(auth(EMAIL))
      .send({ studentEmail: EMAIL, ageGroup: '7-12', questionId: q.id, answer: 1 });
    expect(right.body).toMatchObject({ correct: true, correctIndex: 1, explanation: 'Because.', extraFact: 'Extra fact.' });
    // Recorded on an in-progress attempt.
    const [attempt] = supabase.__rows('ca_quiz_attempts');
    expect(attempt).toMatchObject({ student_email: EMAIL, age_group: '7-12', status: 'in_progress' });
    expect(attempt.answers).toHaveLength(1);
    // Re-checking the same question returns the recorded result without changing it (first answer is final).
    const again = await request(app).post('/current-affairs/quiz/check').set(auth(EMAIL))
      .send({ studentEmail: EMAIL, ageGroup: '7-12', questionId: q.id, answer: 0 });
    expect(again.body.selected).toBe(1);
    expect(supabase.__rows('ca_quiz_attempts')[0].answers).toHaveLength(1);
    // Out-of-range answer → 400.
    expect((await request(app).post('/current-affairs/quiz/check').set(auth(EMAIL))
      .send({ studentEmail: EMAIL, ageGroup: '7-12', questionId: q.id, answer: 9 })).status).toBe(400);
  });

  test('unpublished questions stay hidden', async () => {
    const q = questionRow({ status: 'review' });
    supabase.__seed('ca_quiz_questions', [q]);
    expect((await request(app).post('/current-affairs/quiz/check').set(auth(EMAIL))
      .send({ studentEmail: EMAIL, ageGroup: '7-12', questionId: q.id, answer: 1 })).status).toBe(404);
  });
});

describe('POST /current-affairs/quiz/submit', () => {
  test('grades only the answers recorded via /check and stores the attempt as submitted', async () => {
    const rows = weekQuestions();
    supabase.__seed('ca_quiz_questions', rows);
    const res = await takeQuiz(rows, 8); // record 8 correct answers server-side, then submit
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ score: 8, total: 10, percentage: 80, excellence: true, alreadySubmitted: false, weekStart: '2026-11-08' });
    expect(res.body.results).toHaveLength(10);
    expect(res.body.results[9].correct).toBe(false);

    const [stored] = supabase.__rows('ca_quiz_attempts');
    expect(stored).toMatchObject({ student_email: EMAIL, age_group: '7-12', week_start: '2026-11-08', score: 8, percentage: 80, status: 'submitted' });
    expect(stored.answers).toHaveLength(10);
  });

  test('one attempt per week: a second submit returns the first result', async () => {
    const rows = weekQuestions();
    supabase.__seed('ca_quiz_questions', rows);
    await takeQuiz(rows, 4);
    const again = await request(app).post('/current-affairs/quiz/submit').set(auth(EMAIL))
      .send({ studentEmail: EMAIL, ageGroup: '7-12' });
    expect(again.body).toMatchObject({ score: 4, percentage: 40, alreadySubmitted: true });
    expect(supabase.__rows('ca_quiz_attempts')).toHaveLength(1);
  });

  test('below 80% is not excellent', async () => {
    const rows = weekQuestions();
    supabase.__seed('ca_quiz_questions', rows);
    const res = await takeQuiz(rows, 7);
    expect(res.body).toMatchObject({ percentage: 70, excellence: false });
  });

  test('past-week quizzes cannot be submitted (window closed after Saturday)', async () => {
    const rows = weekQuestions({ week_start: '2026-11-01' });
    supabase.__seed('ca_quiz_questions', rows);
    // Freeze time to Monday of the current week → last week's quiz is closed for submission.
    freezeTime('2026-11-09T06:00:00Z');
    const res = await submit({ weekStart: '2026-11-01', answers: answersFor(rows, 10) });
    expect(res.status).toBe(400);
  });

  test('validation, missing quiz and sign-in checks', async () => {
    expect((await submit({ answers: 'x' })).status).toBe(400);
    expect((await submit({ answers: [] })).status).toBe(404); // no quiz this week
    expect((await request(app).post('/current-affairs/quiz/submit').send({ ageGroup: '7-12', answers: [] })).status).toBe(400);
    const other = await request(app).post('/current-affairs/quiz/submit').set(auth('someone@else.in'))
      .send({ studentEmail: EMAIL, ageGroup: '7-12', answers: [] });
    expect(other.status).toBe(403);
  });
});
