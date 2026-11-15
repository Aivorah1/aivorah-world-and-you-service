jest.mock('../../services/supabase', () => require('./helpers/fakeSupabase').createFakeSupabase());
jest.mock('../../services/firebaseAdmin', () => require('./helpers/fakeFirebase'));
// index.js also loads World & You's AI routes, which create a Groq client on load.
jest.mock('../../services/dailyTidbit', () => ({}));
jest.mock('../../services/world', () => ({}));

const request = require('supertest');
const app = require('../../index');
const supabase = require('../../services/supabase');
const { nextStreak, displayedStreak, quizRewards, digestRewards, POINTS } = require('../../current-affairs/services/rewards');
const { freezeTime, storyRow, auth } = require('./helpers/fixtures');

const EMAIL = 'kid@school.in';

beforeEach(() => {
  supabase.__reset();
  freezeTime('2026-11-09T06:00:00Z'); // Monday 9 Nov, India time 11:30
});
afterEach(() => jest.useRealTimers());

// Noon in India on the given day.
const onDay = (date) => jest.setSystemTime(new Date(`${date}T06:30:00Z`));

const post = (path, body, email = EMAIL) =>
  request(app).post(`/current-affairs/progress/${path}`).set(auth(email)).send({ studentEmail: email, ageGroup: '8-12', ...body });
const getProgress = (query = '?ageGroup=8-12', email = EMAIL) =>
  request(app).get(`/current-affairs/progress/${encodeURIComponent(email)}${query}`).set(auth(email));

function seedAttempt(percentage, weekStart = '2026-11-08') {
  supabase.__seed('ca_quiz_attempts', [{
    id: `00000000-0000-4000-8000-0000000000${String(percentage).padStart(2, '0')}`,
    student_email: EMAIL, age_group: '8-12', week_start: weekStart,
    answers: [], score: percentage / 10, total: 10, percentage, points_awarded: false, points_earned: 0,
  }]);
}

describe('GET /current-affairs/progress/:studentEmail', () => {
  test('a new student starts at zero', async () => {
    const res = await getProgress();
    expect(res.status).toBe(200);
    expect(res.body.progress).toMatchObject({
      studentEmail: EMAIL, ageGroup: '8-12', points: 0, currentStreak: 0, digestsCompleted: 0,
      badges: { excellence: false, weeklyStreak: false, growth: false }, digestCompletedToday: false,
    });
  });

  test("only the signed-in student can read their progress", async () => {
    expect((await request(app).get(`/current-affairs/progress/${EMAIL}`)).status).toBe(401);
    expect((await request(app).get(`/current-affairs/progress/${EMAIL}`).set(auth('someone@else.in'))).status).toBe(403);
    expect((await request(app).get(`/current-affairs/progress/${EMAIL}`).set({ Authorization: 'Bearer forged' })).status).toBe(401);
  });

  test('AUTH_ENFORCE=monitor logs instead of blocking (local dev only)', async () => {
    process.env.AUTH_ENFORCE = 'monitor';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await request(app).get(`/current-affairs/progress/${EMAIL}`)).status).toBe(200);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[auth-monitor] would 401'));
    } finally {
      delete process.env.AUTH_ENFORCE;
      warn.mockRestore();
    }
  });
});

describe('POST /current-affairs/progress/digest-complete', () => {
  test('no points, but a 1-day streak, applied with the atomic Postgres function', async () => {
    const res = await post('digest-complete', { storyCount: 10 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ alreadyCompleted: false, pointsAwarded: 0, newBadges: [] });
    expect(res.body.progress).toMatchObject({ points: 0, currentStreak: 1, digestsCompleted: 1, digestCompletedToday: true });
    expect(supabase.rpc).toHaveBeenCalledWith('ca_apply_progress', expect.objectContaining({
      p_student_email: EMAIL, p_age_group: '8-12', p_points: 0, p_digests: 1, p_current_streak: 1, p_last_digest_date: '2026-11-09',
    }));
  });

  test('only once per day', async () => {
    await post('digest-complete');
    const again = await post('digest-complete');
    expect(again.body).toMatchObject({ alreadyCompleted: true, pointsAwarded: 0 });
    expect(again.body.progress.digestsCompleted).toBe(1);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  test('consecutive days grow the streak; day 7 earns the weekly streak badge, with no points', async () => {
    const days = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'];
    let res;
    for (const day of days) {
      onDay(day);
      res = await post('digest-complete');
    }
    expect(res.body.newBadges).toEqual(['weekly_streak']);
    expect(res.body.pointsAwarded).toBe(0);
    expect(res.body.progress).toMatchObject({ points: 0, currentStreak: 7, longestStreak: 7, badges: { weeklyStreak: true } });

    onDay('2026-11-16');
    const day8 = await post('digest-complete');
    expect(day8.body.newBadges).toEqual([]); // badge is earned once
    expect(day8.body.progress.currentStreak).toBe(8);
  });

  test('missing a day resets the streak but keeps the longest; a lapsed streak shows as 0', async () => {
    onDay('2026-11-09'); await post('digest-complete');
    onDay('2026-11-10'); await post('digest-complete');
    onDay('2026-11-13');
    expect((await getProgress()).body.progress.currentStreak).toBe(0);
    const res = await post('digest-complete');
    expect(res.body.progress).toMatchObject({ currentStreak: 1, longestStreak: 2, points: 0 });
  });

  test('if the progress cannot be saved, the day is not marked done so a retry still counts it', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'db down' } });
    const failed = await post('digest-complete');
    expect(failed.status).toBe(500);
    expect(supabase.__rows('ca_digest_views')).toHaveLength(0);
    const retry = await post('digest-complete');
    expect(retry.body).toMatchObject({ alreadyCompleted: false, pointsAwarded: 0 });
    expect(retry.body.progress.currentStreak).toBe(1);
    error.mockRestore();
  });

  test('validation', async () => {
    expect((await post('digest-complete', { ageGroup: 'adult' })).status).toBe(400);
    expect((await request(app).post('/current-affairs/progress/digest-complete').send({ ageGroup: '8-12' })).status).toBe(400);
    const other = await request(app).post('/current-affairs/progress/digest-complete').set(auth('someone@else.in'))
      .send({ studentEmail: EMAIL, ageGroup: '8-12' });
    expect(other.status).toBe(403);
  });
});

describe('POST /current-affairs/progress/story-read', () => {
  test('a read is recorded once and gives no points', async () => {
    const story = storyRow();
    supabase.__seed('ca_stories', [story]);
    const first = await post('story-read', { storyId: story.id, durationSeconds: 52 });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ alreadyRead: false, pointsAwarded: 0 });
    expect(first.body.progress).toMatchObject({ points: 0, storiesRead: 1 });
    expect(supabase.__rows('ca_story_reads')[0]).toMatchObject({ story_id: story.id, duration_seconds: 52, read_date: '2026-11-09' });

    const second = await post('story-read', { storyId: story.id });
    expect(second.body).toMatchObject({ alreadyRead: true, pointsAwarded: 0 });
    expect(second.body.progress).toMatchObject({ points: 0, storiesRead: 1 });
  });

  test('unpublished or unknown stories are not recorded', async () => {
    const story = storyRow({ status: 'review' });
    supabase.__seed('ca_stories', [story]);
    expect((await post('story-read', { storyId: story.id })).status).toBe(404);
    expect((await post('story-read', { storyId: 'nope' })).status).toBe(400);
  });
});

describe('only the weekly quiz gives points', () => {
  test('reading the digest and a story adds nothing to points earned in the quiz', async () => {
    seedAttempt(70);
    expect((await post('quiz-complete')).body.pointsAwarded).toBe(20);
    const story = storyRow();
    supabase.__seed('ca_stories', [story]);
    const read = await post('story-read', { storyId: story.id });
    const digest = await post('digest-complete');
    expect(read.body.pointsAwarded).toBe(0);
    expect(digest.body.pointsAwarded).toBe(0);
    expect(digest.body.progress).toMatchObject({ points: 20, storiesRead: 1, digestsCompleted: 1, quizzesCompleted: 1 });
  });

  test('old app versions calling the reading endpoints get a normal answer', async () => {
    const story = storyRow();
    supabase.__seed('ca_stories', [story]);
    const read = await post('story-read', { storyId: story.id, durationSeconds: 30 });
    const digest = await post('digest-complete', { storyCount: 6 });
    expect([read.status, digest.status]).toEqual([200, 200]);
    expect(read.body).toEqual(expect.objectContaining({ alreadyRead: false, pointsAwarded: 0, progress: expect.any(Object) }));
    expect(digest.body).toEqual(expect.objectContaining({ alreadyCompleted: false, pointsAwarded: 0, newBadges: [], progress: expect.any(Object) }));
  });
});

describe('POST /current-affairs/progress/quiz-complete', () => {
  test('+20 points for completing the quiz', async () => {
    seedAttempt(70);
    const res = await post('quiz-complete');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ alreadyRecorded: false, pointsAwarded: 20, excellence: false, newBadges: [] });
    expect(res.body.progress).toMatchObject({ points: 20, quizzesCompleted: 1, bestQuizScore: 70, lastQuizScore: 70 });
  });

  test('80%+ adds the excellence badge and +10 bonus', async () => {
    seedAttempt(80);
    const res = await post('quiz-complete');
    expect(res.body).toMatchObject({ pointsAwarded: 30, excellence: true, newBadges: ['excellence'] });
    expect(res.body.progress).toMatchObject({ points: 30, badges: { excellence: true } });
    expect(supabase.__rows('ca_quiz_attempts')[0]).toMatchObject({ points_awarded: true, points_earned: 30 });
  });

  test('the score comes from the graded attempt, not the request', async () => {
    seedAttempt(40);
    const res = await post('quiz-complete', { percentage: 100, score: 10 });
    expect(res.body).toMatchObject({ pointsAwarded: 20, excellence: false, percentage: 40 });
  });

  test('points are awarded once per attempt', async () => {
    seedAttempt(90);
    await post('quiz-complete');
    const again = await post('quiz-complete');
    expect(again.body).toMatchObject({ alreadyRecorded: true, pointsAwarded: 0 });
    expect(again.body.progress.points).toBe(30);
  });

  test('beating the previous quiz score earns the growth badge', async () => {
    seedAttempt(50, '2026-11-01');
    await post('quiz-complete', { weekStart: '2026-11-01' });
    seedAttempt(70, '2026-11-08');
    const res = await post('quiz-complete');
    expect(res.body).toMatchObject({ growth: true, newBadges: ['growth'] });
    expect(res.body.progress).toMatchObject({ points: 40, quizzesCompleted: 2, bestQuizScore: 70, badges: { growth: true } });
  });

  test('can name the attempt by id', async () => {
    seedAttempt(60);
    const res = await post('quiz-complete', { attemptId: '00000000-0000-4000-8000-000000000060' });
    expect(res.body.pointsAwarded).toBe(20);
  });

  test('404 before the quiz is submitted', async () => {
    expect((await post('quiz-complete')).status).toBe(404);
  });
});

describe('reward rules', () => {
  test('nextStreak / displayedStreak', () => {
    expect(nextStreak(null, 0, '2026-11-09')).toBe(1);
    expect(nextStreak('2026-11-08', 3, '2026-11-09')).toBe(4);
    expect(nextStreak('2026-11-09', 3, '2026-11-09')).toBe(3);
    expect(nextStreak('2026-11-06', 3, '2026-11-09')).toBe(1);
    expect(nextStreak('2026-10-31', 9, '2026-11-01')).toBe(10); // across a month end
    expect(displayedStreak('2026-11-08', 4, '2026-11-09')).toBe(4);
    expect(displayedStreak('2026-11-07', 4, '2026-11-09')).toBe(0);
  });

  test('digestRewards: no points; the 7-day badge does not depend on points', () => {
    expect(POINTS).toMatchObject({ digest: 0, story: 0, quiz: 20, excellenceBonus: 10 });
    expect(digestRewards(null, '2026-11-09')).toEqual({ points: 0, streak: 1, weeklyStreak: false, newBadges: [] });
    expect(digestRewards({ last_digest_date: '2026-11-08', current_streak: 6, points: 0 }, '2026-11-09'))
      .toEqual({ points: 0, streak: 7, weeklyStreak: true, newBadges: ['weekly_streak'] });
    expect(digestRewards({ last_digest_date: '2026-11-08', current_streak: 6, badge_weekly_streak: true }, '2026-11-09').newBadges).toEqual([]);
  });

  test('quizRewards', () => {
    expect(quizRewards(null, 79)).toMatchObject({ points: 20, excellence: false, growth: false });
    expect(quizRewards(null, 80)).toMatchObject({ points: 30, excellence: true, newBadges: ['excellence'] });
    expect(quizRewards({ last_quiz_score: 60, badge_growth: true }, 65)).toMatchObject({ growth: true, newBadges: [] });
    expect(quizRewards({ last_quiz_score: 60 }, 60).growth).toBe(false);
  });
});
