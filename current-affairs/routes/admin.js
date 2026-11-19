// Admin content tool (Aivorah team only, middleware/adminAuth.js): review,
// edit, write and publish stories and quiz questions, and see the analytics.
// Before this the only way to add or publish content was SQL in Supabase.
const express = require('express');
const supabase = require('../../services/supabase');
const { check } = require('../services/db');
const { requireEditor } = require('../middleware/adminAuth');
const { handle } = require('./helpers');
const { AGE_GROUPS, normalizeAgeGroup, localDate, isDateString, addDays, quizWeekStart, lengthWarnings, isUuid } = require('../services/content');
const { urlHash, isHttpsUrl } = require('../services/sourceUrl');
const { computeMetrics, daysBetween } = require('../services/analytics');
const audit = require('../services/audit');
const { regenerateStory } = require('../pipeline/regenerate');

const router = express.Router();
router.use(requireEditor);

const CATEGORIES = ['india', 'world', 'economy', 'science', 'environment', 'sports', 'society'];
const STATUSES = ['draft', 'review', 'published', 'rejected', 'archived'];
// Editors write the two versions: kid = 7-12, teen = 13-15 (no under-8 version).
const AGES = ['kid', 'teen'];
const STORY_TEXT = ['title', 'summary', 'what_happened', 'why_important'].flatMap((f) => AGES.map((a) => `${f}_${a}`));
const STORY_OPTIONAL = ['did_you_know', 'new_word_1', 'def_1', 'new_word_2', 'def_2', 'new_word_3', 'def_3', 'think_about_it', 'image_url', 'source_url'];
const QUESTION_TYPES = ['mcq', 'true_false', 'reasoning'];

const bad = (res, error) => res.status(400).json({ error });
const text = (v) => (v === undefined || v === null ? null : String(v).trim());

// The editable story fields in a request body, checked. Returns { patch } or { error }.
function storyPatch(body, { creating }) {
  const patch = {};
  for (const f of STORY_TEXT) {
    if (body[f] === undefined) { if (creating) return { error: `${f} is required` }; continue; }
    const v = text(body[f]);
    if (!v) return { error: `${f} cannot be empty` };
    patch[f] = v;
  }
  for (const f of STORY_OPTIONAL) if (body[f] !== undefined) patch[f] = text(body[f]) || null;
  // Pictures only from an https link an editor pasted (never copied from news sites by us).
  if (patch.image_url && !isHttpsUrl(patch.image_url)) return { error: 'image_url must be an https:// link' };
  if (patch.source_url !== undefined) patch.source_url_hash = patch.source_url ? urlHash(patch.source_url) : null;
  if (body.category !== undefined || creating) {
    if (!CATEGORIES.includes(body.category)) return { error: `category must be one of ${CATEGORIES.join(', ')}` };
    patch.category = body.category;
  }
  if (body.source !== undefined || creating) {
    const v = text(body.source);
    if (!v) return { error: 'source is required (where the facts come from)' };
    patch.source = v;
  }
  if (body.publish_date !== undefined) {
    if (!isDateString(body.publish_date)) return { error: 'publish_date must be YYYY-MM-DD' };
    patch.publish_date = body.publish_date;
  }
  if (body.priority !== undefined) {
    const n = Number(body.priority);
    if (!Number.isInteger(n)) return { error: 'priority must be a whole number' };
    patch.priority = n;
  }
  if (body.age_extras !== undefined) {
    if (!body.age_extras || typeof body.age_extras !== 'object' || Array.isArray(body.age_extras)) return { error: 'age_extras must be an object' };
    patch.age_extras = body.age_extras;
  }
  return { patch };
}

// Which status an item may move to from which. A rejected story or question
// can only be archived: it must never be published, or brought back to be
// published later. Publishing needs a story an editor is reviewing (or a draft).
const ALLOWED_FROM = {
  published: ['draft', 'review', 'published'],
  review: ['draft', 'review', 'published'],
  draft: ['draft', 'review'],
  rejected: ['draft', 'review', 'published', 'rejected'],
  archived: STATUSES,
};

// What a story's approval means for students, for the history and the editor.
function scheduleNote(publishDate, today = localDate()) {
  if (!publishDate) return '';
  if (publishDate > today) return `scheduled: students see it on ${publishDate}`;
  if (publishDate === today) return 'live today';
  return `dated ${publishDate}`;
}

// A story can only be approved for today or a later day: the digest shows a
// day's approved stories on that day only, so a past date would never be seen.
const pastDateError = (date) => `This story is dated ${date}, which has passed. Set its publish date to today or later, then approve it.`;

const ENTITY = { ca_stories: 'story', ca_quiz_questions: 'quiz_question' };

// Moves one story/question to `status` only if its current status allows it,
// and records the change in the approval history. Answers 400/404/409 itself
// and returns null, or returns the updated row.
async function changeStatus(req, res, table, id, status, stamp, label) {
  const isStory = table === 'ca_stories';
  const current = check(await supabase.from(table).select(isStory ? 'status, publish_date' : 'status').eq('id', id).maybeSingle());
  if (!current) { res.status(404).json({ error: `${label} not found` }); return null; }
  const from = ALLOWED_FROM[status];
  if (!from.includes(current.status)) {
    res.status(409).json({
      error: current.status === 'rejected'
        ? `This ${label.toLowerCase()} was rejected, so it can only be archived, never published.`
        : `A ${current.status} ${label.toLowerCase()} cannot be moved to ${status}.`,
    });
    return null;
  }
  if (isStory && status === 'published' && current.status !== 'published' && current.publish_date < localDate()) {
    res.status(400).json({ error: pastDateError(current.publish_date) });
    return null;
  }
  // .in('status', from) again: the status cannot change in between.
  const rows = check(await supabase.from(table).update(stamp).eq('id', id).in('status', from).select('*'));
  if (!rows?.length) { res.status(409).json({ error: `The ${label.toLowerCase()} changed while saving. Reload and try again.` }); return null; }
  const row = rows[0];
  await audit.record({
    actor: req.editorEmail,
    action: `${ENTITY[table]}.${status}`,
    entityType: ENTITY[table],
    entityId: id,
    before: isStory ? { status: current.status, publish_date: current.publish_date } : { status: current.status },
    after: isStory ? { status: row.status, publish_date: row.publish_date } : { status: row.status },
    detail: isStory && status === 'published' ? `Approved, ${scheduleNote(row.publish_date)}` : null,
  });
  return row;
}

const reviewStamp = (req, status) => ({
  status,
  reviewed_by: req.editorEmail,
  reviewed_at: new Date().toISOString(),
  // Publishing in the tool means an editor checked it against the source.
  ...(status === 'published' ? { is_true_fact: true } : {}),
});

// ── GET /admin/me — is this account an editor? ──────────────────────────────
router.get('/me', (req, res) => res.json({ email: req.editorEmail, editor: true }));

// ── Stories ─────────────────────────────────────────────────────────────────
// GET /admin/stories?status=review&from=&to=&limit=
router.get('/stories', handle(async (req, res) => {
  const { status, from, to } = req.query;
  if (status && !STATUSES.includes(status)) return bad(res, `status must be one of ${STATUSES.join(', ')}`);
  if ((from && !isDateString(from)) || (to && !isDateString(to))) return bad(res, 'from/to must be YYYY-MM-DD');
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  let q = supabase.from('ca_stories')
    .select('id, category, publish_date, status, priority, title_kid, summary_kid, what_happened_kid, title_teen, summary_teen, what_happened_teen, source, source_url, review_notes, is_true_fact, reviewed_by, reviewed_at, created_at');
  if (status) q = q.eq('status', status);
  if (from) q = q.gte('publish_date', from);
  if (to) q = q.lte('publish_date', to);
  const rows = check(await q.order('publish_date', { ascending: false }).order('priority', { ascending: false }).limit(limit));
  res.json({ stories: rows || [] });
}));

router.get('/stories/:id', handle(async (req, res) => {
  const row = check(await supabase.from('ca_stories').select('*').eq('id', req.params.id).maybeSingle());
  if (!row) return res.status(404).json({ error: 'Story not found' });
  res.json({ story: row });
}));

// GET /admin/stories/:id/history: every recorded change, newest first.
// { available: false } until the history table (aivorah-db 0029) exists.
router.get('/stories/:id/history', handle(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Story not found' });
  res.json(await audit.historyFor('story', req.params.id));
}));

// POST /admin/stories — write a new story. { ...fields, publish: true } publishes it.
router.post('/stories', handle(async (req, res) => {
  const { patch, error } = storyPatch(req.body || {}, { creating: true });
  if (error) return bad(res, error);
  const row = {
    ...patch,
    publish_date: patch.publish_date || localDate(),
    age_extras: patch.age_extras || {},
    ...(req.body.publish ? reviewStamp(req, 'published') : { status: 'draft', is_true_fact: false }),
  };
  if (req.body.publish && row.publish_date < localDate()) return bad(res, pastDateError(row.publish_date));
  const saved = check(await supabase.from('ca_stories').insert(row).select('*'));
  const story = Array.isArray(saved) ? saved[0] : saved;
  await audit.record({
    actor: req.editorEmail, action: req.body.publish ? 'story.create_published' : 'story.create', entityType: 'story', entityId: story?.id,
    after: { status: story?.status, publish_date: story?.publish_date },
    detail: req.body.publish ? `Written and approved by an editor, ${scheduleNote(story?.publish_date)}` : 'Written by an editor as a draft',
  });
  res.status(201).json({ story, warnings: lengthWarnings(row) });
}));

// PATCH /admin/stories/:id — edit any text, the date, priority or source.
router.patch('/stories/:id', handle(async (req, res) => {
  const { patch, error } = storyPatch(req.body || {}, { creating: false });
  if (error) return bad(res, error);
  if (!Object.keys(patch).length) return bad(res, 'Nothing to change');
  const existing = isUuid(req.params.id)
    ? check(await supabase.from('ca_stories').select('*').eq('id', req.params.id).maybeSingle())
    : null;
  if (!existing) return res.status(404).json({ error: 'Story not found' });
  // Two editors on one story: the admin tool sends the updated_at it loaded
  // (the database sets updated_at on every change). If the story changed since,
  // nothing is saved, so one editor never silently overwrites the other.
  const loaded = req.body?.updated_at;
  if (loaded && !sameTime(loaded, existing.updated_at)) return res.status(409).json({ error: EDITED_ELSEWHERE });
  let update = supabase.from('ca_stories').update(patch).eq('id', req.params.id);
  if (loaded && existing.updated_at) update = update.eq('updated_at', existing.updated_at);
  const rows = check(await update.select('*'));
  if (!rows?.length) return loaded ? res.status(409).json({ error: EDITED_ELSEWHERE }) : res.status(404).json({ error: 'Story not found' });
  // The editor's text is kept in the story itself; the history keeps what it replaced.
  const diff = audit.changedFields(existing, rows[0], Object.keys(patch).filter((f) => f !== 'source_url_hash'));
  if (diff.changed.length) {
    await audit.record({
      actor: req.editorEmail, action: 'story.edit', entityType: 'story', entityId: req.params.id,
      before: diff.before, after: diff.after, detail: `Edited: ${diff.changed.join(', ')}`,
    });
  }
  res.json({ story: rows[0], warnings: lengthWarnings(rows[0]) });
}));

const EDITED_ELSEWHERE = 'This story was edited by someone else after you opened it. Reload to see their changes, then try again.';
// Same moment? (the same timestamp can come back with different formatting)
function sameTime(a, b) {
  if (String(a) === String(b)) return true;
  const ta = Date.parse(a); const tb = Date.parse(b);
  return Number.isFinite(ta) && ta === tb;
}

// POST /admin/stories/:id/regenerate { request? } — "Rewrite from source".
// Rewrites both age versions from the story's source page (with the editor's
// optional request), re-checks the key facts, and saves the new text for
// review: it is never published here. Only stories still in review or drafts.
const REGENERATE_FROM = ['review', 'draft'];
router.post('/stories/:id/regenerate', handle(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Story not found' });
  const request = text(req.body?.request) || '';
  if (request.length > 500) return bad(res, 'Keep the request under 500 characters');
  const story = check(await supabase.from('ca_stories').select('*').eq('id', req.params.id).maybeSingle());
  if (!story) return res.status(404).json({ error: 'Story not found' });
  if (!REGENERATE_FROM.includes(story.status)) {
    return res.status(409).json({ error: story.status === 'published'
      ? 'This story is published. Unpublish it (back to review) before rewriting it.'
      : `A ${story.status} story cannot be rewritten.` });
  }

  const result = await regenerateStory({ story, request });
  if (result.error) return res.status(502).json({ error: result.error });

  const v = result.verification;
  const notes = `AUTO: REGENERATED - ${v.result === 'VERIFIED' ? 'VERIFIED' : `CHECK - ${v.note}`}`;
  const patch = { ...result.fields, review_notes: notes, status: 'review', is_true_fact: false };
  // Only if nobody changed it while the AI was writing (that can take a while).
  const rows = check(await supabase.from('ca_stories').update(patch)
    .eq('id', story.id).in('status', REGENERATE_FROM).eq('updated_at', story.updated_at).select('*'));
  if (!rows?.length) return res.status(409).json({ error: 'The story changed while it was being rewritten. Reload and try again.' });

  const diff = audit.changedFields(story, rows[0], Object.keys(result.fields));
  await audit.record({
    actor: req.editorEmail, action: 'story.regenerate', entityType: 'story', entityId: story.id,
    before: diff.before, after: diff.after,
    detail: `Rewritten from the source by the AI on request${request ? ` ("${request.slice(0, 200)}")` : ''}; fact check: ${v.result}`,
  });
  res.json({ story: rows[0], warnings: lengthWarnings(rows[0]) });
}));

// POST /admin/stories/bulk-status { ids: [≤20], status: 'published'|'rejected'|'draft', publishDate? }
// "Approve the whole digest": only stories waiting for review (or drafts)
// change, each recorded in the history. Publishing stamps them like the single
// route. publishDate ('today', 'tomorrow' or YYYY-MM-DD, today or later) moves
// them to that day; without it each keeps its own date, which must not have
// passed. Approved stories for a later day are scheduled: students see them
// only on that day.
const BULK_STATUSES = ['published', 'rejected', 'draft'];
function readPublishDate(value, today) {
  if (value === undefined) return { date: null };
  if (value === 'today') return { date: today };
  if (value === 'tomorrow') return { date: addDays(today, 1) };
  if (isDateString(value) && value >= today) return { date: value };
  return { error: "publishDate must be 'today', 'tomorrow' or a date (YYYY-MM-DD) that has not passed" };
}
router.post('/stories/bulk-status', handle(async (req, res) => {
  const { ids, status } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || ids.length > 20) return bad(res, 'ids must list 1 to 20 stories');
  if (!BULK_STATUSES.includes(status)) return bad(res, `status must be one of ${BULK_STATUSES.join(', ')}`);
  const today = localDate();
  const { date: publishDate, error } = readPublishDate(req.body.publishDate, today);
  if (error) return bad(res, error);
  const stamp = reviewStamp(req, status);
  if (status === 'published' && publishDate) stamp.publish_date = publishDate;
  const results = [];
  const history = [];
  for (const id of [...new Set(ids.map(String))]) {
    if (!isUuid(id)) { results.push({ id, ok: false, reason: 'not a story id' }); continue; }
    const before = check(await supabase.from('ca_stories').select('status, publish_date').eq('id', id).maybeSingle());
    if (!before) { results.push({ id, ok: false, reason: 'story not found' }); continue; }
    if (!['review', 'draft'].includes(before.status)) { results.push({ id, ok: false, reason: `not waiting for review (it is ${before.status})` }); continue; }
    if (status === 'published' && !publishDate && before.publish_date < today) { results.push({ id, ok: false, reason: pastDateError(before.publish_date) }); continue; }
    const rows = check(await supabase.from('ca_stories').update(stamp).eq('id', id).in('status', ['review', 'draft']).select('id, status, publish_date'));
    if (!rows?.length) { results.push({ id, ok: false, reason: 'it changed while saving; reload and try again' }); continue; }
    const row = rows[0];
    results.push({ id, ok: true, status: row.status, publish_date: row.publish_date });
    history.push({
      actor: req.editorEmail, action: `story.${status}`, entityType: 'story', entityId: id,
      before: { status: before.status, publish_date: before.publish_date }, after: { status: row.status, publish_date: row.publish_date },
      detail: status === 'published' ? `Approved with the digest, ${scheduleNote(row.publish_date, today)}` : 'Changed with the digest',
    });
  }
  await audit.record(history);
  res.json({ updated: results.filter((r) => r.ok).length, results });
}));

// GET /admin/pipeline/last-run: when the daily pipeline last saved stories and how many.
router.get('/pipeline/last-run', handle(async (req, res) => {
  const rows = check(await supabase.from('ca_stories').select('created_at, publish_date, review_notes')
    .order('created_at', { ascending: false }).limit(300)) || [];
  const auto = rows.filter((r) => String(r.review_notes || '').startsWith('AUTO:'));
  if (!auto.length) return res.json({ lastRun: null });
  const day = auto[0].publish_date;
  const sameDay = auto.filter((r) => r.publish_date === day);
  res.json({ lastRun: { at: auto[0].created_at, date: day, saved: sameDay.length, verified: sameDay.filter((r) => String(r.review_notes || '').startsWith('AUTO: VERIFIED')).length } });
}));

// POST /admin/stories/:id/status { status: 'published' | 'rejected' | 'review' | 'archived' | 'draft' }
router.post('/stories/:id/status', handle(async (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return bad(res, `status must be one of ${STATUSES.join(', ')}`);
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Story not found' });
  const story = await changeStatus(req, res, 'ca_stories', req.params.id, status, reviewStamp(req, status), 'Story');
  if (story) res.json({ story });
}));

// ── Quiz ────────────────────────────────────────────────────────────────────
const readAge = (res, value) => {
  const ageGroup = normalizeAgeGroup(value);
  if (!ageGroup) { bad(res, `ageGroup must be one of ${Object.keys(AGE_GROUPS).join(', ')}`); return null; }
  return ageGroup;
};
const readWeek = (res, value) => {
  if (!isDateString(value) || quizWeekStart(value) !== value) { bad(res, 'weekStart must be a Sunday, YYYY-MM-DD'); return null; }
  return value;
};

// The editable question fields, checked against each other (options vs answer).
function questionPatch(body, existing, { creating }) {
  const patch = {};
  if (body.category !== undefined || creating) {
    if (!CATEGORIES.includes(body.category)) return { error: `category must be one of ${CATEGORIES.join(', ')}` };
    patch.category = body.category;
  }
  if (body.question_type !== undefined || creating) {
    const type = body.question_type || 'mcq';
    if (!QUESTION_TYPES.includes(type)) return { error: `question_type must be one of ${QUESTION_TYPES.join(', ')}` };
    patch.question_type = type;
  }
  for (const f of ['question', 'explanation']) {
    if (body[f] === undefined) { if (creating) return { error: `${f} is required` }; continue; }
    const v = text(body[f]);
    if (!v) return { error: `${f} cannot be empty` };
    patch[f] = v;
  }
  if (body.extra_fact !== undefined) patch.extra_fact = text(body.extra_fact) || null;
  if (body.story_id !== undefined) patch.story_id = body.story_id || null;
  if (body.position !== undefined) patch.position = Number(body.position) || 0;
  if (body.options !== undefined) {
    if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 4 || body.options.some((o) => !text(o))) {
      return { error: 'options must be 2 to 4 non-empty answers' };
    }
    patch.options = body.options.map(text);
  } else if (creating) return { error: 'options are required' };
  if (body.correct_index !== undefined) patch.correct_index = Number(body.correct_index);
  else if (creating) return { error: 'correct_index is required' };

  const options = patch.options || existing?.options || [];
  const correct = patch.correct_index ?? existing?.correct_index;
  if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) return { error: 'correct_index must point at one of the options' };
  return { patch };
}

// GET /admin/quiz/weeks — recent quiz weeks with how many questions are in each status.
router.get('/quiz/weeks', handle(async (req, res) => {
  const since = addDays(quizWeekStart(localDate()), -7 * 12);
  const rows = check(await supabase.from('ca_quiz_questions').select('week_start, age_group, status')
    .gte('week_start', since).order('week_start', { ascending: false }).limit(5000)) || [];
  const weeks = new Map();
  for (const r of rows) {
    const ageGroup = normalizeAgeGroup(r.age_group) || r.age_group;
    const key = `${r.week_start}|${ageGroup}`;
    if (!weeks.has(key)) weeks.set(key, { weekStart: r.week_start, ageGroup, counts: {} });
    const w = weeks.get(key);
    w.counts[r.status] = (w.counts[r.status] || 0) + 1;
  }
  res.json({ currentWeek: quizWeekStart(localDate()), weeks: [...weeks.values()] });
}));

// GET /admin/quiz?weekStart=&ageGroup= — every question of that quiz, any status.
router.get('/quiz', handle(async (req, res) => {
  const weekStart = readWeek(res, req.query.weekStart || quizWeekStart(localDate()));
  if (!weekStart) return;
  const ageGroup = readAge(res, req.query.ageGroup);
  if (!ageGroup) return;
  const rows = check(await supabase.from('ca_quiz_questions').select('*')
    .eq('week_start', weekStart).eq('age_group', ageGroup).order('position', { ascending: true })) || [];
  // The title of the story each question comes from, for the editor.
  const storyIds = [...new Set(rows.map((r) => r.story_id).filter(Boolean))];
  const stories = storyIds.length ? check(await supabase.from('ca_stories').select('id, title_kid').in('id', storyIds)) || [] : [];
  const titles = new Map(stories.map((s) => [s.id, s.title_kid]));
  res.json({ weekStart, ageGroup, questions: rows.map((r) => ({ ...r, story_title: titles.get(r.story_id) || null })) });
}));

// A question may name the story it comes from (optional for questions an
// editor writes). The story must exist and not be rejected; one published
// outside the 7 days ending on the quiz's Sunday only gets a warning.
async function checkStoryLink(storyId, weekStart) {
  if (!storyId) return { warnings: [] };
  if (!isUuid(storyId)) return { error: 'story_id is not a valid story id' };
  const story = check(await supabase.from('ca_stories').select('id, status, publish_date').eq('id', storyId).maybeSingle());
  if (!story) return { error: 'story_id does not match any story' };
  if (story.status === 'rejected') return { error: 'story_id points to a rejected story' };
  const from = addDays(weekStart, -6);
  const warnings = story.publish_date < from || story.publish_date > weekStart
    ? [{ field: 'story_id', message: `The linked story was published on ${story.publish_date}, outside this quiz's week (${from} to ${weekStart}).` }]
    : [];
  return { warnings };
}

// POST /admin/quiz — add a question to a week's quiz.
router.post('/quiz', handle(async (req, res) => {
  const body = req.body || {};
  const weekStart = readWeek(res, body.week_start);
  if (!weekStart) return;
  const ageGroup = readAge(res, body.age_group);
  if (!ageGroup) return;
  const { patch, error } = questionPatch(body, null, { creating: true });
  if (error) return bad(res, error);
  const link = await checkStoryLink(patch.story_id, weekStart);
  if (link.error) return bad(res, link.error);
  const saved = check(await supabase.from('ca_quiz_questions')
    .insert({ ...patch, week_start: weekStart, age_group: ageGroup, status: 'review' }).select('*'));
  const question = Array.isArray(saved) ? saved[0] : saved;
  await audit.record({ actor: req.editorEmail, action: 'quiz_question.create', entityType: 'quiz_question', entityId: question?.id,
    after: { status: 'review', week_start: weekStart, age_group: ageGroup }, detail: 'Written by an editor' });
  res.status(201).json({ question, warnings: link.warnings });
}));

router.patch('/quiz/:id', handle(async (req, res) => {
  const existing = check(await supabase.from('ca_quiz_questions').select('*').eq('id', req.params.id).maybeSingle());
  if (!existing) return res.status(404).json({ error: 'Question not found' });
  const { patch, error } = questionPatch(req.body || {}, existing, { creating: false });
  if (error) return bad(res, error);
  const link = patch.story_id ? await checkStoryLink(patch.story_id, existing.week_start) : { warnings: [] };
  if (link.error) return bad(res, link.error);
  const rows = check(await supabase.from('ca_quiz_questions').update(patch).eq('id', req.params.id).select('*'));
  const diff = audit.changedFields(existing, rows[0], Object.keys(patch));
  if (diff.changed.length) {
    await audit.record({ actor: req.editorEmail, action: 'quiz_question.edit', entityType: 'quiz_question', entityId: req.params.id,
      before: diff.before, after: diff.after, detail: `Edited: ${diff.changed.join(', ')}` });
  }
  res.json({ question: rows[0], warnings: link.warnings });
}));

router.post('/quiz/:id/status', handle(async (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return bad(res, `status must be one of ${STATUSES.join(', ')}`);
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Question not found' });
  const { is_true_fact: _ignored, ...stamp } = reviewStamp(req, status);
  const question = await changeStatus(req, res, 'ca_quiz_questions', req.params.id, status, stamp, 'Question');
  if (question) res.json({ question });
}));

// POST /admin/quiz/publish { weekStart, ageGroup } — publish every question of
// that quiz that is not rejected or archived.
router.post('/quiz/publish', handle(async (req, res) => {
  const body = req.body || {};
  const weekStart = readWeek(res, body.weekStart);
  if (!weekStart) return;
  const ageGroup = readAge(res, body.ageGroup);
  if (!ageGroup) return;
  const { is_true_fact: _ignored, ...stamp } = reviewStamp(req, 'published');
  const rows = check(await supabase.from('ca_quiz_questions').update(stamp)
    .eq('week_start', weekStart).eq('age_group', ageGroup).in('status', ['draft', 'review']).select('id'));
  await audit.record((rows || []).map((r) => ({ actor: req.editorEmail, action: 'quiz_question.published', entityType: 'quiz_question',
    entityId: r.id, after: { status: 'published' }, detail: `Approved with the ${ageGroup} quiz for the week of ${weekStart}` })));
  res.json({ published: rows?.length || 0 });
}));

// ── Analytics ───────────────────────────────────────────────────────────────
// GET /admin/analytics?from=&to=&ageGroup= (default: the last 30 days, all ages)
router.get('/analytics', handle(async (req, res) => {
  const to = req.query.to || localDate();
  const from = req.query.from || addDays(to, -29);
  if (!isDateString(from) || !isDateString(to) || from > to) return bad(res, 'from/to must be YYYY-MM-DD with from <= to');
  if (daysBetween(from, to) > 366) return bad(res, 'Choose a range of at most a year');
  let ageGroup = null;
  if (req.query.ageGroup && req.query.ageGroup !== 'all') {
    ageGroup = readAge(res, req.query.ageGroup);
    if (!ageGroup) return;
  }
  res.json(await computeMetrics({ from, to, ageGroup }));
}));

module.exports = router;
