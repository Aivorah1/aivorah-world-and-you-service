// Age groups, categories, dates and the story shape the app receives.
// Pure functions only — no database access — so they are easy to test.

// Two content versions. Students under 8 read the 7-12 version. Each
// ca_stories row has one text column set per version (_kid, _teen); the old
// _young columns (the retired under-8 version) are no longer shown.
const AGE_GROUPS = {
  '7-12':  { column: 'kid',  storiesPerDay: 6, newWords: 1, wordsPerMinute: 130 },
  '13-15': { column: 'teen', storiesPerDay: 7, newWords: 3, wordsPerMinute: 170 },
};
const AGE_GROUP_NAMES = Object.keys(AGE_GROUPS);

const CATEGORIES = ['india', 'world', 'economy', 'science', 'environment', 'sports', 'society'];

// Old app versions still send the three old values: under-8 and 8-12 → 7-12,
// 13+ → 13-15. Answers only ever use the new values.
const ALIASES = {
  '7-12': '7-12', kid: '7-12',
  'under-8': '7-12', under8: '7-12', '3-8': '7-12', young: '7-12', '8-12': '7-12',
  '13-15': '13-15', teen: '13-15', '13+': '13-15', '13': '13-15',
};

// "13+" in a query string arrives as "13 " (a raw "+" decodes to a space), so trim first.
function normalizeAgeGroup(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return ALIASES[key] || null;
}

// ── Dates ───────────────────────────────────────────────────────────────────
// Students are in India, so "today" is the Asia/Kolkata calendar day, not UTC.
const TIME_ZONE = process.env.CA_TIME_ZONE || 'Asia/Kolkata';

function localDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function isDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
}

// The weekly quiz is released on Sunday and played until Saturday:
// its week_start is the most recent Sunday on or before the date.
function quizWeekStart(dateStr) {
  return addDays(dateStr, -new Date(`${dateStr}T00:00:00Z`).getUTCDay());
}

// ── Stories ─────────────────────────────────────────────────────────────────
function wordCount(...texts) {
  return texts.filter(Boolean).join(' ').split(/\s+/).filter(Boolean).length;
}

// Seconds, rounded to 5, kept within 30s-3min.
function readTimeSeconds(words, ageGroup) {
  const wpm = AGE_GROUPS[ageGroup].wordsPerMinute;
  const secs = Math.round(((words / wpm) * 60) / 5) * 5;
  return Math.min(180, Math.max(30, secs));
}

// New words: 7-12 sees only new_word_1 (the simplest word, chosen for both
// ages); 13-15 sees new_word_1..3, the ones that are filled in (2-3 words).
// age_content overrides (age_content[ageGroup].new_words) take precedence when present.
function wordsFor(row, ageGroup) {
  const col = AGE_GROUPS[ageGroup].column;
  const override = row.age_content?.[ageGroup]?.new_words;
  if (Array.isArray(override) && override.length) {
    return override
      .filter((w) => w && String(w.word || '').trim() && String(w.definition || '').trim())
      .slice(0, AGE_GROUPS[ageGroup].newWords)
      .map((w) => ({ word: String(w.word), definition: String(w.definition) }));
  }
  const list = [
    { word: row.new_word_1, definition: row.def_1 },
    { word: row.new_word_2, definition: row.def_2 },
    { word: row.new_word_3, definition: row.def_3 },
  ];
  return list
    .filter((w) => w && String(w.word || '').trim() && String(w.definition || '').trim())
    .slice(0, AGE_GROUPS[ageGroup].newWords)
    .map((w) => ({ word: String(w.word), definition: String(w.definition) }));
}

// A ca_stories row → the app's Story for one age group.
// age_content overrides per-age fields (image, did_you_know, think_about_it, new_words)
// when present; otherwise the base columns are used. Backward compatible with the
// legacy age_extras shape.
function toStory(row, ageGroup) {
  const col = AGE_GROUPS[ageGroup].column;
  const extras = row.age_extras?.[col] || {};
  const override = row.age_content?.[ageGroup] || {};
  const story = {
    id: row.id,
    category: row.category,
    publishDate: row.publish_date,
    title: row[`title_${col}`],
    summary: row[`summary_${col}`],
    whatHappened: row[`what_happened_${col}`],
    whyImportant: row[`why_important_${col}`],
    didYouKnow: override.did_you_know ?? extras.didYouKnow ?? row.did_you_know ?? null,
    newWords: wordsFor(row, ageGroup),
    thinkAboutIt: override.think_about_it ?? extras.thinkAboutIt ?? row.think_about_it ?? null,
    imageUrl: override.image_url ?? row.image_url ?? null,
    source: row.source,
    sourceUrl: row.source_url || null,
  };
  // Impact field exists only for the 13-15 age group.
  if (ageGroup === '13-15') story.impact = override.impact ?? null;
  story.readTimeSeconds = readTimeSeconds(
    wordCount(story.title, story.whatHappened, story.whyImportant, story.didYouKnow, story.thinkAboutIt,
      ...story.newWords.map((w) => `${w.word} ${w.definition}`)),
    ageGroup,
  );
  return story;
}

// ── Workflow status helpers ─────────────────────────────────────────────────
// The per-age status columns (status_kid/status_teen) are the source of truth.
// Fall back to the legacy single `status` column when the per-age columns are
// not yet set (old rows). 'published' on the legacy column maps to 'published'
// for both ages.
const STORY_PUBLISHED = 'published';

function storyStatusFor(row, ageGroup) {
  const col = AGE_GROUPS[ageGroup].column;
  const perAge = row[`status_${col}`];
  if (perAge) return perAge;
  // Legacy fallback.
  if (row.status === STORY_PUBLISHED) return STORY_PUBLISHED;
  return row.status || null;
}

// A story is visible to students of an age group only when its per-age status
// is 'published'.
function isStoryPublished(row, ageGroup) {
  return storyStatusFor(row, ageGroup) === STORY_PUBLISHED;
}

// The digest is the ordered list of published stories for a day and age group.
// Students see only Published content for today or earlier (checked at the route).
const DIGEST_STATUSES = ['not_started', 'in_review', 'approved', 'live', 'archived', 'missed'];
const QUIZ_STATUSES = ['draft', 'in_review', 'review', 'approved', 'scheduled', 'live', 'published', 'archived', 'missed', 'rejected'];
const SOURCE_KINDS = ['rss', 'api'];
const SOURCE_CATEGORIES = ['india', 'world', 'economy', 'science', 'environment', 'sports', 'society', 'general'];
const NEWSROOM_SCOPES = ['india', 'international'];
const FACT_CHECK_VERDICTS = ['verified', 'unclear', 'contradicted'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID.test(String(value || ''));

// Story length targets (words in what_happened): 7-12 aims for 50-80, 13-15
// for 100-150. Outside the wider limits below an editor sees a warning
// (never a block).
const LENGTH_LIMITS = {
  what_happened_kid:  { label: 'Ages 7-12 "What happened"',  target: '50-80',   min: 40, max: 95 },
  what_happened_teen: { label: 'Ages 13-15 "What happened"', target: '100-150', min: 90, max: 165 },
};

function lengthWarnings(row) {
  const warnings = [];
  for (const [field, l] of Object.entries(LENGTH_LIMITS)) {
    if (row[field] === undefined || row[field] === null) continue;
    const words = wordCount(row[field]);
    if (words < l.min || words > l.max) {
      warnings.push({ field, words, message: `${l.label} has ${words} words; aim for ${l.target}.` });
    }
  }
  return warnings;
}

module.exports = {
  wordCount, LENGTH_LIMITS, lengthWarnings,
  AGE_GROUPS, AGE_GROUP_NAMES, CATEGORIES, normalizeAgeGroup,
  localDate, isDateString, addDays, daysBetween, quizWeekStart,
  toStory, readTimeSeconds, isUuid,
  STORY_PUBLISHED, storyStatusFor, isStoryPublished,
  DIGEST_STATUSES, QUIZ_STATUSES, SOURCE_KINDS, SOURCE_CATEGORIES, NEWSROOM_SCOPES, FACT_CHECK_VERDICTS,
};
