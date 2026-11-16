const express = require('express');
const supabase = require('../../services/supabase');
const { AGE_GROUPS, localDate, isDateString, toStory, isStoryPublished } = require('../services/content');
const { requireSelf } = require('../middleware/auth');
const { check, isNotSetUp } = require('../services/db');
const { readStudent, handle } = require('./helpers');

const router = express.Router();

// Fetch published stories for a day and age group. Prefers the ordered list
// from ca_digest when a live/approved digest exists for that day; otherwise
// falls back to stories with per-age status 'published' (backward compatible).
async function digestStories(date, ageGroup) {
  const target = AGE_GROUPS[ageGroup].storiesPerDay;
  // Try the new digest table first (ignore if the table doesn't exist yet).
  try {
    const digest = check(await supabase.from('ca_digest').select('story_ids, status')
      .eq('date', date).maybeSingle());
    if (digest && digest.status === 'live' && Array.isArray(digest.story_ids) && digest.story_ids.length) {
      const stories = check(await supabase.from('ca_stories').select('*')
        .in('id', digest.story_ids).order('position', { ascending: true }));
      const byId = new Map((stories || []).map((s) => [s.id, s]));
      // Return only published-for-this-age stories, in digest order.
      return digest.story_ids
        .map((id) => byId.get(id))
        .filter((s) => s && isStoryPublished(s, ageGroup))
        .slice(0, target);
    }
  } catch (err) {
    if (!isNotSetUp(err)) throw err; // ca_digest table missing → fall through to legacy
  }
  // Legacy fallback: published stories for the day.
  const rows = check(await supabase.from('ca_stories').select('*')
    .eq('publish_date', date)
    .filter((row) => isStoryPublished(row, ageGroup))
    .order('priority', { ascending: false }).order('created_at', { ascending: true })
    .limit(target));
  return rows || [];
}

// ── GET /current-affairs/digest/today?ageGroup=7-12&studentEmail=&date= ───────
// Today's published stories for the age group (6 for 7-12, 7 for 13-15).
// If nothing is published for TODAY yet, the digest is blank (empty stories array).
// Admin publishes stories first; students only see what is published for today.
// With studentEmail, each story says whether that student has read it.
// The optional ?date= query still lets the app view any specific past day.
router.get('/today', requireSelf((req) => req.query.studentEmail), handle(async (req, res) => {
  const student = readStudent(res, req.query, { emailRequired: false });
  if (!student) return;
  const { ageGroup, email } = student;
  const today = localDate();

  let date = req.query.date;
  if (date !== undefined) {
    if (!isDateString(date) || date > today) return res.status(400).json({ error: 'date must be YYYY-MM-DD, not in the future' });
  } else {
    date = today;
  }

  const rows = await digestStories(date, ageGroup);

  let readIds = new Set();
  let completed = false;
  if (email && rows.length) {
    const reads = check(await supabase.from('ca_story_reads').select('story_id')
      .eq('student_email', email).in('story_id', rows.map((r) => r.id)));
    readIds = new Set((reads || []).map((r) => r.story_id));
  }
  if (email) {
    const view = check(await supabase.from('ca_digest_views').select('id')
      .eq('student_email', email).eq('view_date', today).maybeSingle());
    completed = !!view;
  }

  const stories = rows.map((row) => ({ ...toStory(row, ageGroup), read: readIds.has(row.id) }));
  res.json({
    date,
    isToday: date === today,
    ageGroup,
    target: AGE_GROUPS[ageGroup].storiesPerDay,
    stories,
    readCount: stories.filter((s) => s.read).length,
    completed,
  });
}));

// ── GET /current-affairs/digest/list?limit=30 ─────────────────────────────────
// Past digest dates (newest first) with how many stories each has.
router.get('/list', handle(async (req, res) => {
  const limit = Math.min(90, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const today = localDate();
  const rows = check(await supabase.from('ca_stories').select('publish_date')
    .filter((row) => isStoryPublished(row, '7-12')).lte('publish_date', today)
    .order('publish_date', { ascending: false })
    .limit(limit * 30));

  const counts = new Map();
  for (const r of rows || []) counts.set(r.publish_date, (counts.get(r.publish_date) || 0) + 1);
  const dates = [...counts.entries()].slice(0, limit).map(([date, storyCount]) => ({ date, storyCount }));
  res.json({ dates });
}));

module.exports = router;
