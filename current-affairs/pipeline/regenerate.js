// Rewrites one story from its source page when an editor asks (admin
// "Rewrite from source"). Same steps as the daily pipeline for one story:
// read the source page, write both age versions (PROMPT C, with the editor's
// optional request), and check the key facts against the page (PROMPT B).
// It only returns new text; the caller saves it for review. Never publishes.
const { fetchText } = require('./feeds');
const { writeOne } = require('./write');
const { verifyOne, pageTextFor, MIN_PAGE_CHARS } = require('./verify');
const { createLlm } = require('./llm');

/**
 * story: the ca_stories row. request: what the editor wants changed (optional).
 * Returns { fields, verification } with the new text, or { error } to show the editor.
 */
async function regenerateStory({ story, request = '', llm = createLlm(), fetchImpl } = {}) {
  if (!story?.source_url) return { error: 'This story has no source link, so it cannot be rewritten from its source.' };

  let pageText = '';
  try { pageText = pageTextFor(story.source_url, await fetchText(story.source_url, { fetchImpl })); } catch { pageText = ''; }
  if (pageText.length < MIN_PAGE_CHARS) {
    return { error: 'The source page could not be read, so the story was not rewritten. Open the source link to check it, or edit the text yourself.' };
  }

  // The current headline and summary say what the story is about; the facts
  // themselves must come from the source page (the prompt forbids anything else).
  const keyFacts = [story.title_teen, story.summary_teen].map((s) => String(s || '').trim()).filter(Boolean);
  const written = await writeOne({ title: story.title_teen, summary: story.summary_teen, keyFacts, pageText, editorRequest: request }, llm);
  if (written.error) return { error: `The AI could not rewrite it: ${written.error}` };

  const verification = await verifyOne({ link: story.source_url, keyFacts }, llm, fetchImpl);
  const w = written.story;
  const [w1, w2, w3] = w.words;
  return {
    verification: { result: verification.result, note: verification.note },
    fields: {
      title_kid: w.kid.title, summary_kid: w.kid.summary, what_happened_kid: w.kid.what_happened, why_important_kid: w.kid.why_important,
      title_teen: w.teen.title, summary_teen: w.teen.summary, what_happened_teen: w.teen.what_happened, why_important_teen: w.teen.why_important,
      did_you_know: w.did_you_know,
      new_word_1: w1?.word || null, def_1: w1?.definition || null,
      new_word_2: w2?.word || null, def_2: w2?.definition || null,
      new_word_3: w3?.word || null, def_3: w3?.definition || null,
      think_about_it: w.think_about_it,
    },
  };
}

module.exports = { regenerateStory };
