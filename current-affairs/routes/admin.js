// Admin content tool (Aivorah team only, middleware/adminAuth.js): review,
// edit, write and publish stories and quiz questions, and see the analytics.
// Before this the only way to add or publish content was SQL in Supabase.
const express = require('express');
const supabase = require('../../services/supabase');
const { check, isNotSetUp } = require('../services/db');
const { requireEditor } = require('../middleware/adminAuth');
const { handle } = require('./helpers');
const { AGE_GROUPS, AGE_GROUP_NAMES, normalizeAgeGroup, localDate, isDateString, addDays, quizWeekStart, lengthWarnings, isUuid, STORY_PUBLISHED, DIGEST_STATUSES, QUIZ_STATUSES, SOURCE_KINDS, SOURCE_CATEGORIES } = require('../services/content');
const { urlHash, isHttpsUrl } = require('../services/sourceUrl');
const { computeMetrics, daysBetween } = require('../services/analytics');

const router = express.Router();
router.use(requireEditor);

const CATEGORIES = ['india', 'world', 'economy', 'science', 'environment', 'sports', 'society'];
// Legacy single-status values (kept for backward compatibility with existing rows/tests).
const LEGACY_STATUSES = ['draft', 'review', 'published', 'rejected', 'archived'];
// New per-age workflow statuses for stories.
const STORY_WORKFLOW_STATUSES = ['collected', 'selected', 'generated', 'in_review', 'approved', 'ready', 'scheduled', 'published', 'archived', 'rejected'];
// Editors write the two versions: kid = 7-12, teen = 13-15 (no under-8 version).
const AGES = ['kid', 'teen'];
const STORY_TEXT = ['title', 'summary', 'what_happened', 'why_important'].flatMap((f) => AGES.map((a) => `${f}_${a}`));
const STORY_OPTIONAL = ['did_you_know', 'new_word_1', 'def_1', 'new_word_2', 'def_2', 'new_word_3', 'def_3', 'think_about_it', 'image_url', 'source_url'];
const QUESTION_TYPES = ['mcq', 'true_false', 'reasoning'];

const bad = (res, error) => res.status(400).json({ error });
const text = (v) => (v === undefined || v === null ? null : String(v).trim());

// Audit log every admin edit/approve/publish/unpublish. Ignore failures (audit
// is best-effort; the main write already happened).
async function audit(actor, action, entityType, entityId, before, after, detail) {
  try {
    await supabase.from('ca_audit_log').insert({
      actor, action, entity_type: entityType, entity_id: entityId, before, after, detail,
    });
  } catch (e) {
    if (!isNotSetUp(e)) console.warn('[ca-admin-audit]', e.message);
  }
}

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

// Stamp a story with the editor's review. For legacy single-status writes, set
// `status`. For per-age workflow writes, set status_kid/status_teen. Publishing
// means an editor checked it against the source (is_true_fact = true).
const reviewStamp = (req, status) => ({
  status,
  reviewed_by: req.editorEmail,
  reviewed_at: new Date().toISOString(),
  ...(status === 'published' ? { is_true_fact: true } : {}),
});

// Map a legacy status to per-age statuses for the new workflow.
// draft/review → in_review; published → published; rejected → rejected; archived → archived.
function legacyToWorkflow(status) {
  switch (status) {
    case 'draft':
    case 'review': return 'in_review';
    case 'published': return 'published';
    case 'rejected': return 'rejected';
    case 'archived': return 'archived';
    default: return status;
  }
}

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
  const saved = check(await supabase.from('ca_stories').insert(row).select('*'));
  res.status(201).json({ story: Array.isArray(saved) ? saved[0] : saved, warnings: lengthWarnings(row) });
}));

// PATCH /admin/stories/:id — edit any text, the date, priority or source.
// Optimistic concurrency: if the request sends updated_at and the stored row
// has changed since then, reject with 409 so two editors can't silently
// overwrite each other.
router.patch('/stories/:id', handle(async (req, res) => {
  const { patch, error } = storyPatch(req.body || {}, { creating: false });
  if (error) return bad(res, error);
  if (!Object.keys(patch).length) return bad(res, 'Nothing to change');
  const body = req.body || {};
  let q = supabase.from('ca_stories').update(patch).eq('id', req.params.id);
  // Conditional update: only match the row if it hasn't changed since the
  // editor loaded it. PostgREST updates 0 rows if updated_at differs.
  if (body.updated_at !== undefined) q = q.eq('updated_at', body.updated_at);
  const rows = check(await q.select('*'));
  if (!rows?.length) {
    // Either the story was deleted, or (if updated_at was sent) it changed.
    if (body.updated_at !== undefined) {
      const stale = check(await supabase.from('ca_stories').select('updated_at').eq('id', req.params.id).maybeSingle());
      if (stale) {
        return res.status(409).json({
          error: 'This story was edited by someone else. Reload to see their changes.',
          currentUpdated_at: stale.updated_at,
        });
      }
    }
    return res.status(404).json({ error: 'Story not found' });
  }
  res.json({ story: rows[0], warnings: lengthWarnings(rows[0]) });
}));

// POST /admin/stories/bulk-status { ids: [≤20], status: 'published'|'rejected'|'draft', publishDate?: 'today' }
// Only stories waiting for review (or drafts) change. Publishing stamps them
// like the single route; publishDate 'today' moves them into today's digest.
const BULK_STATUSES = ['published', 'rejected', 'draft'];
router.post('/stories/bulk-status', handle(async (req, res) => {
  const { ids, status, publishDate } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || ids.length > 20) return bad(res, 'ids must list 1 to 20 stories');
  if (!BULK_STATUSES.includes(status)) return bad(res, `status must be one of ${BULK_STATUSES.join(', ')}`);
  if (publishDate !== undefined && publishDate !== 'today') return bad(res, "publishDate can only be 'today'");
  const stamp = reviewStamp(req, status);
  if (status === 'published' && publishDate === 'today') stamp.publish_date = localDate();
  const results = [];
  for (const id of [...new Set(ids.map(String))]) {
    if (!isUuid(id)) { results.push({ id, ok: false, reason: 'not a story id' }); continue; }
    const rows = check(await supabase.from('ca_stories').update(stamp).eq('id', id).in('status', ['review', 'draft']).select('id, status, publish_date'));
    if (rows?.length) { results.push({ id, ok: true, status: rows[0].status, publish_date: rows[0].publish_date }); continue; }
    const existing = check(await supabase.from('ca_stories').select('status').eq('id', id).maybeSingle());
    results.push({ id, ok: false, reason: existing ? `not waiting for review (it is ${existing.status})` : 'story not found' });
  }
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
  res.json({ lastRun: { at: auto[0].created_at, date: day, saved: sameDay.length, verified: sameDay.filter((r) => r.review_notes === 'AUTO: VERIFIED').length } });
}));

// POST /admin/stories/:id/status { status, status_kid?, status_teen? }
// Legacy `status` maps to both age versions; per-age statuses set each version
// independently. Audit logs the change.
router.post('/stories/:id/status', handle(async (req, res) => {
  const body = req.body || {};
  const { status, status_kid, status_teen } = body;
  const patch = {};
  if (status !== undefined) {
    if (!LEGACY_STATUSES.includes(status)) return bad(res, `status must be one of ${LEGACY_STATUSES.join(', ')}`);
    Object.assign(patch, reviewStamp(req, status));
    patch.status_kid = legacyToWorkflow(status);
    patch.status_teen = legacyToWorkflow(status);
  }
  if (status_kid !== undefined) {
    if (!STORY_WORKFLOW_STATUSES.includes(status_kid)) return bad(res, `status_kid must be one of ${STORY_WORKFLOW_STATUSES.join(', ')}`);
    patch.status_kid = status_kid;
  }
  if (status_teen !== undefined) {
    if (!STORY_WORKFLOW_STATUSES.includes(status_teen)) return bad(res, `status_teen must be one of ${STORY_WORKFLOW_STATUSES.join(', ')}`);
    patch.status_teen = status_teen;
  }
  if (!Object.keys(patch).length) return bad(res, 'Provide status or status_kid/status_teen');
  const before = check(await supabase.from('ca_stories').select('*').eq('id', req.params.id).maybeSingle());
  const rows = check(await supabase.from('ca_stories').update(patch).eq('id', req.params.id).select('*'));
  if (!rows?.length) return res.status(404).json({ error: 'Story not found' });
  await audit(req.editorEmail, `story.status.${status || 'per_age'}`, 'story', rows[0].id, before, rows[0], `status=${status || 'per_age'}`);
  res.json({ story: rows[0] });
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
  res.status(201).json({ question: Array.isArray(saved) ? saved[0] : saved, warnings: link.warnings });
}));

router.patch('/quiz/:id', handle(async (req, res) => {
  const existing = check(await supabase.from('ca_quiz_questions').select('*').eq('id', req.params.id).maybeSingle());
  if (!existing) return res.status(404).json({ error: 'Question not found' });
  const { patch, error } = questionPatch(req.body || {}, existing, { creating: false });
  if (error) return bad(res, error);
  const link = patch.story_id ? await checkStoryLink(patch.story_id, existing.week_start) : { warnings: [] };
  if (link.error) return bad(res, link.error);
  const body = req.body || {};
  let q = supabase.from('ca_quiz_questions').update(patch).eq('id', req.params.id);
  // Optimistic concurrency: only match if updated_at hasn't changed.
  if (body.updated_at !== undefined) q = q.eq('updated_at', body.updated_at);
  const rows = check(await q.select('*'));
  if (!rows?.length && body.updated_at !== undefined) {
    const stale = check(await supabase.from('ca_quiz_questions').select('updated_at').eq('id', req.params.id).maybeSingle());
    if (stale) {
      return res.status(409).json({
        error: 'This question was edited by someone else. Reload to see their changes.',
        currentUpdated_at: stale.updated_at,
      });
    }
  }
  if (!rows?.length) return res.status(404).json({ error: 'Question not found' });
  res.json({ question: rows[0], warnings: link.warnings });
}));

router.post('/quiz/:id/status', handle(async (req, res) => {
  const { status } = req.body || {};
  if (!QUIZ_STATUSES.includes(status)) return bad(res, `status must be one of ${QUIZ_STATUSES.join(', ')}`);
  const { is_true_fact: _ignored, ...stamp } = reviewStamp(req, status);
  const before = check(await supabase.from('ca_quiz_questions').select('*').eq('id', req.params.id).maybeSingle());
  const rows = check(await supabase.from('ca_quiz_questions').update(stamp).eq('id', req.params.id).select('*'));
  if (!rows?.length) return res.status(404).json({ error: 'Question not found' });
  await audit(req.editorEmail, `quiz.status.${status}`, 'quiz_question', rows[0].id, before, rows[0], `status=${status}`);
  res.json({ question: rows[0] });
}));

// POST /admin/quiz/publish { weekStart, ageGroup } — publish every question of
// that quiz that is not rejected or archived. Sets status to 'live' (the new
// name for published) and audits the action.
router.post('/quiz/publish', handle(async (req, res) => {
  const body = req.body || {};
  const weekStart = readWeek(res, body.weekStart);
  if (!weekStart) return;
  const ageGroup = readAge(res, body.ageGroup);
  if (!ageGroup) return;
  const { is_true_fact: _ignored, ...stamp } = reviewStamp(req, 'published');
  stamp.status = 'live';
  const rows = check(await supabase.from('ca_quiz_questions').update(stamp)
    .eq('week_start', weekStart).eq('age_group', ageGroup).in('status', ['draft', 'review', 'approved']).select('id'));
  await audit(req.editorEmail, 'quiz.publish', 'quiz', `${weekStart}|${ageGroup}`, null, { weekStart, ageGroup, published: rows?.length || 0 }, `week=${weekStart} age=${ageGroup}`);
  res.json({ published: rows?.length || 0 });
}));

// ── Digest management ───────────────────────────────────────────────────────
// GET /admin/digests — digests with status counts, newest first.
router.get('/digests', handle(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const rows = check(await supabase.from('ca_digest').select('*')
    .order('date', { ascending: false }).limit(limit)) || [];
  res.json({ digests: rows });
}));

// GET /admin/digest/:date — one digest with its stories resolved.
router.get('/digest/:date', handle(async (req, res) => {
  if (!isDateString(req.params.date)) return bad(res, 'date must be YYYY-MM-DD');
  const digest = check(await supabase.from('ca_digest').select('*').eq('date', req.params.date).maybeSingle());
  if (!digest) return res.status(404).json({ error: 'Digest not found' });
  let stories = [];
  if (digest.story_ids?.length) {
    const rows = check(await supabase.from('ca_stories').select('*').in('id', digest.story_ids)) || [];
    const byId = new Map(rows.map((s) => [s.id, s]));
    stories = digest.story_ids.map((id) => byId.get(id)).filter(Boolean);
  }
  res.json({ digest, stories });
}));

// POST /admin/digest/:date — create or update a digest plan. Body: { status?, story_ids?: [uuid], age_group? }.
router.post('/digest/:date', handle(async (req, res) => {
  if (!isDateString(req.params.date)) return bad(res, 'date must be YYYY-MM-DD');
  const body = req.body || {};
  if (body.status && !DIGEST_STATUSES.includes(body.status)) return bad(res, `status must be one of ${DIGEST_STATUSES.join(', ')}`);
  if (body.age_group && !AGE_GROUP_NAMES.includes(body.age_group)) return bad(res, `age_group must be one of ${AGE_GROUP_NAMES.join(', ')}`);
  if (body.story_ids !== undefined) {
    if (!Array.isArray(body.story_ids) || body.story_ids.length > 7) return bad(res, 'story_ids must be an array of up to 7 story ids');
  }
  const before = check(await supabase.from('ca_digest').select('*').eq('date', req.params.date).maybeSingle());
  const patch = {
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.story_ids !== undefined ? { story_ids: body.story_ids } : {}),
    ...(body.age_group !== undefined ? { age_group: body.age_group } : {}),
  };
  if (body.status === 'approved' && !before) patch.final_approved_by = req.editorEmail;
  if (body.status === 'approved' && before) { patch.final_approved_by = req.editorEmail; patch.final_approved_at = new Date().toISOString(); }
  const digest = before
    ? check(await supabase.from('ca_digest').update(patch).eq('date', req.params.date).select('*')[0])
    : check((await supabase.from('ca_digest').insert({ date: req.params.date, ...patch }).select('*'))[0]);
  await audit(req.editorEmail, `digest.${body.status || 'plan'}`, 'digest', digest.id, before, digest, `date=${digest.date}`);
  res.json({ digest });
}));

// POST /admin/digest/:date/final-approve — lock the digest as approved/live.
router.post('/digest/:date/final-approve', handle(async (req, res) => {
  if (!isDateString(req.params.date)) return bad(res, 'date must be YYYY-MM-DD');
  const digest = check(await supabase.from('ca_digest').select('*').eq('date', req.params.date).maybeSingle());
  if (!digest) return res.status(404).json({ error: 'Digest not found' });
  const before = digest;
  const updated = check((await supabase.from('ca_digest').update({
    status: 'live', final_approved_by: req.editorEmail, final_approved_at: new Date().toISOString(), live_at: new Date().toISOString(),
  }).eq('date', req.params.date).select('*'))[0]);
  await audit(req.editorEmail, 'digest.final_approve', 'digest', updated.id, before, updated, `date=${updated.date}`);
  res.json({ digest: updated });
}));

// POST /admin/digest/:date/unpublish — emergency unpublish (logged).
router.post('/digest/:date/unpublish', handle(async (req, res) => {
  if (!isDateString(req.params.date)) return bad(res, 'date must be YYYY-MM-DD');
  const digest = check(await supabase.from('ca_digest').select('*').eq('date', req.params.date).maybeSingle());
  if (!digest) return res.status(404).json({ error: 'Digest not found' });
  const before = digest;
  const updated = check((await supabase.from('ca_digest').update({
    status: 'archived', unpublished_by: req.editorEmail, unpublished_at: new Date().toISOString(),
    unpublish_reason: (req.body || {}).reason || null,
  }).eq('date', req.params.date).select('*'))[0]);
  await audit(req.editorEmail, 'digest.unpublish', 'digest', updated.id, before, updated, `date=${updated.date}`);
  res.json({ digest: updated });
}));

// ── Sources CRUD ────────────────────────────────────────────────────────────
// GET /admin/sources — all sources.
router.get('/sources', handle(async (req, res) => {
  const rows = check(await supabase.from('ca_sources').select('*').order('category', { ascending: true }).order('name', { ascending: true })) || [];
  res.json({ sources: rows });
}));

// POST /admin/sources — create a source.
router.post('/sources', handle(async (req, res) => {
  const body = req.body || {};
  const name = text(body.name);
  const url = text(body.url);
  const category = body.category || 'general';
  const kind = body.kind || 'rss';
  if (!name) return bad(res, 'name is required');
  if (!url) return bad(res, 'url is required');
  if (!SOURCE_CATEGORIES.includes(category)) return bad(res, `category must be one of ${SOURCE_CATEGORIES.join(', ')}`);
  if (!SOURCE_KINDS.includes(kind)) return bad(res, `kind must be one of ${SOURCE_KINDS.join(', ')}`);
  const before = check(await supabase.from('ca_sources').select('*').eq('url', url).maybeSingle());
  if (before) return res.status(409).json({ error: 'A source with this URL already exists', source: before });
  const row = { name, url, category, kind };
  const created = check((await supabase.from('ca_sources').insert(row).select('*'))[0]);
  await audit(req.editorEmail, 'source.create', 'source', created.id, null, created, `name=${name}`);
  res.status(201).json({ source: created });
}));

// PATCH /admin/sources/:id — edit a source (name/category/url/enabled).
router.patch('/sources/:id', handle(async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.name !== undefined) patch.name = text(body.name);
  if (body.category !== undefined) {
    if (!SOURCE_CATEGORIES.includes(body.category)) return bad(res, `category must be one of ${SOURCE_CATEGORIES.join(', ')}`);
    patch.category = body.category;
  }
  if (body.kind !== undefined) {
    if (!SOURCE_KINDS.includes(body.kind)) return bad(res, `kind must be one of ${SOURCE_KINDS.join(', ')}`);
    patch.kind = body.kind;
  }
  if (body.enabled !== undefined) patch.enabled = !!body.enabled;
  if (body.url !== undefined) patch.url = text(body.url);
  const before = check(await supabase.from('ca_sources').select('*').eq('id', req.params.id).maybeSingle());
  if (!before) return res.status(404).json({ error: 'Source not found' });
  const updated = check((await supabase.from('ca_sources').update(patch).eq('id', req.params.id).select('*'))[0]);
  await audit(req.editorEmail, 'source.update', 'source', updated.id, before, updated, 'edited');
  res.json({ source: updated });
}));

// DELETE /admin/sources/:id — delete a source.
router.delete('/sources/:id', handle(async (req, res) => {
  const before = check(await supabase.from('ca_sources').select('*').eq('id', req.params.id).maybeSingle());
  if (!before) return res.status(404).json({ error: 'Source not found' });
  check(await supabase.from('ca_sources').delete().eq('id', req.params.id));
  await audit(req.editorEmail, 'source.delete', 'source', before.id, before, null, 'deleted');
  res.json({ deleted: true, id: before.id });
}));

// ── Settings ────────────────────────────────────────────────────────────────
// GET /admin/settings — all settings key/value pairs.
router.get('/settings', handle(async (req, res) => {
  const rows = check(await supabase.from('ca_settings').select('*').order('key')) || [];
  res.json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
}));

// PATCH /admin/settings/:key — update a setting value.
router.patch('/settings/:key', handle(async (req, res) => {
  const key = req.params.key;
  const body = req.body || {};
  if (body.value === undefined) return bad(res, 'value is required');
  const before = check(await supabase.from('ca_settings').select('*').eq('key', key).maybeSingle());
  const patch = { value: body.value, updated_by: req.editorEmail };
  const row = before
    ? check((await supabase.from('ca_settings').update(patch).eq('key', key).select('*'))[0])
    : check((await supabase.from('ca_settings').insert({ key, ...patch }).select('*'))[0]);
  await audit(req.editorEmail, 'settings.update', 'settings', row.id, before, row, `key=${key}`);
  res.json({ setting: row });
}));

// ── Audit log ───────────────────────────────────────────────────────────────
// GET /admin/audit?entity_type=&actor=&limit=
router.get('/audit', handle(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  let q = supabase.from('ca_audit_log').select('*').order('created_at', { ascending: false }).limit(limit);
  if (req.query.entity_type) q = q.eq('entity_type', req.query.entity_type);
  if (req.query.actor) q = q.eq('actor', req.query.actor);
  const rows = check(await q) || [];
  res.json({ audit: rows });
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
