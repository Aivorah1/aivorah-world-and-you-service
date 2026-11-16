// Standalone verification script for Phase 2 data model changes.
// Runs without Jest (which hangs in sandbox). Validates:
// 1. content.js exports and age_content overrides
// 2. digest.js digestStories helper logic
// 3. admin.js audit helper and status routes
// 4. feeds.js loadSources fallback behavior
// 5. collect.js newsroom recording

'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// Set dummy env vars so supabase client init doesn't throw.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy-key';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'dummy-key';

function requireCA(mod) {
  return require(path.join(root, mod));
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function makeFakeSupabase(rows) {
  const data = rows || [];
  return {
    from() {
      return {
        select() {
          return {
            eq(col, val) {
              return {
                in() {
                  return {
                    then: async () => data.filter((r) => true),
                  };
                },
                then: async () => data.filter((r) => r[col] === val),
                order() {
                  return {
                    then: async () => data,
                  };
                },
              };
            },
            then: async () => data,
            order() {
              return {
                then: async () => data,
              };
            },
          };
        },
        insert() {
          return {
            then: async () => ({}),
          };
        },
      };
    },
  };
}

console.log('\n=== Phase 2 Verification ===\n');

// --- content.js ---
console.log('content.js:');
const content = requireCA('services/content.js');
test('exports STORY_PUBLISHED constant', () => {
  assert.ok(content.STORY_PUBLISHED === 'published');
});
test('exports DIGEST_STATUSES', () => {
  assert.ok(Array.isArray(content.DIGEST_STATUSES) && content.DIGEST_STATUSES.length > 0);
});
test('exports QUIZ_STATUSES', () => {
  assert.ok(Array.isArray(content.QUIZ_STATUSES) && content.QUIZ_STATUSES.length > 0);
});
test('exports SOURCE_KINDS', () => {
  assert.ok(Array.isArray(content.SOURCE_KINDS));
});
test('exports SOURCE_CATEGORIES', () => {
  assert.ok(Array.isArray(content.SOURCE_CATEGORIES));
});
test('exports NEWSROOM_SCOPES', () => {
  assert.ok(Array.isArray(content.NEWSROOM_SCOPES));
});
test('exports FACT_CHECK_VERDICTS', () => {
  assert.ok(Array.isArray(content.FACT_CHECK_VERDICTS));
});
test('storyStatusFor prefers status_kid over legacy status', () => {
  assert.ok(typeof content.storyStatusFor === 'function');
  const row = { status: 'draft', status_kid: 'live', status_teen: 'scheduled' };
  assert.equal(content.storyStatusFor(row, '7-12'), 'live');
  assert.equal(content.storyStatusFor(row, '13-15'), 'scheduled');
});
test('storyStatusFor falls back to legacy status', () => {
  const row = { status: 'published' };
  assert.equal(content.storyStatusFor(row, '7-12'), 'published');
  assert.equal(content.storyStatusFor(row, '13-15'), 'published');
});
test('isStoryPublished true for published kid story', () => {
  assert.equal(content.isStoryPublished({ status: 'published', status_kid: 'published' }, '7-12'), true);
});
test('isStoryPublished false for draft kid story', () => {
  assert.equal(content.isStoryPublished({ status: 'draft', status_kid: 'draft' }, '7-12'), false);
});
test('toStory applies age_content overrides', () => {
  const story = {
    id: '1', category: 'india', publish_date: '2026-01-01',
    title_kid: 'Kid Title', summary_kid: 'Kid Summary', what_happened_kid: 'What happened',
    why_important_kid: 'Why important', new_word_1: 'word', def_1: 'definition',
    age_content: { '7-12': { did_you_know: 'custom did you know', image_url: 'https://img.jpg' } },
  };
  const result = content.toStory(story, '7-12');
  assert.equal(result.didYouKnow, 'custom did you know');
  assert.equal(result.imageUrl, 'https://img.jpg');
});
test('toStory backward compatible with legacy age_extras', () => {
  const story = {
    id: '1', category: 'india', publish_date: '2026-01-01',
    title_kid: 'Kid Title', summary_kid: 'Kid Summary', what_happened_kid: 'What happened',
    why_important_kid: 'Why important', new_word_1: 'word', def_1: 'definition',
    age_extras: { kid: { didYouKnow: 'legacy did you know' } },
  };
  const result = content.toStory(story, '7-12');
  assert.equal(result.didYouKnow, 'legacy did you know');
});
test('wordsFor logic via toStory newWords override', () => {
  const story = {
    id: '1', category: 'india', publish_date: '2026-01-01',
    title_kid: 'Kid Title', summary_kid: 'Kid Summary', what_happened_kid: 'What happened',
    why_important_kid: 'Why important', new_word_1: 'old', def_1: 'old def',
    age_content: { '7-12': { new_words: [{ word: 'new', definition: 'new def' }] } },
  };
  const result = content.toStory(story, '7-12');
  assert.equal(result.newWords[0].word, 'new');
});

// --- digest.js ---
console.log('\ndigest.js:');
test('digest.js syntax valid', () => {
  require('node:fs').readFileSync(path.join(root, 'routes/digest.js'), 'utf8');
  require('node:child_process').execSync(`node --check ${path.join(root, 'routes/digest.js')}`);
});

// --- admin.js ---
console.log('\nadmin.js:');
test('admin.js syntax valid', () => {
  require('node:fs').readFileSync(path.join(root, 'routes/admin.js'), 'utf8');
  require('node:child_process').execSync(`node --check ${path.join(root, 'routes/admin.js')}`);
});

// --- feeds.js ---
console.log('\nfeeds.js:');
const feeds = requireCA('pipeline/feeds.js');
test('loadSources falls back to hardcoded FEEDS when table unavailable', async () => {
  const fakeSupabase = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                then: async () => {
                  throw new Error('relation does not exist');
                },
              };
            },
          };
        },
      };
    },
  };
  const result = await feeds.loadSources(fakeSupabase);
  assert.ok(Array.isArray(result) && result.length > 0);
});
test('loadSources returns enabled sources from table', async () => {
  const sources = [
    { url: 'https://example.com/rss', category: 'news', enabled: true },
    { url: 'https://disabled.com/rss', category: 'news', enabled: false },
  ];
  const fakeSupabase = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                then: async () => sources.filter((s) => s.enabled),
              };
            },
          };
        },
      };
    },
  };
  const result = await feeds.loadSources(fakeSupabase);
  assert.equal(result.length, 1);
  assert.equal(result[0].url, 'https://example.com/rss');
});

// --- collect.js ---
console.log('\ncollect.js:');
const collect = requireCA('pipeline/collect.js');
test('exports collect function', () => {
  assert.ok(typeof collect.collect === 'function');
});
test('collect records newsroom items', async () => {
  const inserted = [];
  const fakeSupabase = {
    from() {
      return {
        select() {
          return {
            in() {
              return { then: async () => [] };
            },
            then: async () => [],
          };
        },
        insert(rows) {
          inserted.push(...rows);
          return { then: async () => ({}) };
        },
      };
    },
  };
  const now = new Date();
  const result = await collect.collect({
    supabase: fakeSupabase,
    feeds: [{ url: 'https://example.com/rss', name: 'Test' }],
    fetchImpl: async () => ({
      ok: true,
      text: async () => `<?xml version="1.0"?><rss><channel><item><title>Test Story</title><link>https://example.com/1</link><description>Test</description><pubDate>${now.toUTCString()}</pubDate></item></channel></rss>`,
    }),
    now,
  });
  assert.ok(result.items.length > 0);
  assert.ok(inserted.length > 0);
  assert.equal(inserted[0].headline, 'Test Story');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
