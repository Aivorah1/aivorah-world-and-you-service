const express = require('express');
const supabase = require('../../services/supabase');
const { normalizeAgeGroup, AGE_GROUP_NAMES, toStory, localDate, isUuid, isStoryPublished } = require('../services/content');
const { check } = require('../services/db');
const { handle } = require('./helpers');

const router = express.Router();

// ── GET /current-affairs/story/:id?ageGroup=7-12 ────────────────────────────
// One published story in the age group's version (7-12 if ageGroup is missing).
// Students only see stories whose per-age status is 'published' and whose
// publish_date is today or earlier (IST).
router.get('/:id', handle(async (req, res) => {
  const ageGroup = req.query.ageGroup === undefined ? '7-12' : normalizeAgeGroup(req.query.ageGroup);
  if (!ageGroup) return res.status(400).json({ error: `ageGroup must be one of ${AGE_GROUP_NAMES.map((a) => `'${a}'`).join(', ')}` });
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Story not found' });

  const row = check(await supabase.from('ca_stories').select('*')
    .eq('id', req.params.id).maybeSingle());
  if (!row) return res.status(404).json({ error: 'Story not found' });
  // Only published-for-this-age stories are visible.
  if (!isStoryPublished(row, ageGroup)) return res.status(404).json({ error: 'Story not found' });
  // Never serve a story scheduled for a future date.
  if (row.publish_date > localDate()) return res.status(404).json({ error: 'Story not found' });

  res.json({ story: toStory(row, ageGroup) });
}));

module.exports = router;
