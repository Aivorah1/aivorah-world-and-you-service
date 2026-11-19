// The daily Current Affairs pipeline: collect, select, verify, write, save.
// Every saved story waits for an editor: status 'review', is_true_fact false.
// Nothing here ever publishes.
//
// It prepares the NEXT day's digest (publish_date = tomorrow, India time), so
// editors review and approve during the day and the approved stories appear
// for students the next morning. CA_DIGEST_DAYS_AHEAD (0-3, default 1) changes
// how far ahead; 0 is the old same-day behaviour.
const crypto = require('crypto');
const { localDate, addDays } = require('../services/content');
const audit = require('../services/audit');
const { collect } = require('./collect');
const { select } = require('./select');
const { verify } = require('./verify');
const { write } = require('./write');
const { createLlm } = require('./llm');

const REVIEW_STATUS = 'review';

// One ca_stories row from a written story.
function toRow(story, { publishDate, rank }) {
  const w = story.written;
  const [w1, w2, w3] = w.words;
  const v = story.verification;
  return {
    category: story.category,
    publish_date: publishDate,
    priority: Math.round(story.score * 10) + Math.max(0, 7 - rank), // higher = more important
    status: REVIEW_STATUS,
    is_true_fact: false,
    title_kid: w.kid.title, summary_kid: w.kid.summary, what_happened_kid: w.kid.what_happened, why_important_kid: w.kid.why_important,
    title_teen: w.teen.title, summary_teen: w.teen.summary, what_happened_teen: w.teen.what_happened, why_important_teen: w.teen.why_important,
    did_you_know: w.did_you_know,
    new_word_1: w1?.word || null, def_1: w1?.definition || null,
    new_word_2: w2?.word || null, def_2: w2?.definition || null,
    new_word_3: w3?.word || null, def_3: w3?.definition || null,
    think_about_it: w.think_about_it,
    age_extras: {},
    source: story.source,
    source_url: story.link,
    source_url_hash: story.hash,
    review_notes: reviewNotes(v, story.alsoReportedBy),
  };
}

// The check result first (the admin tool reads 'AUTO: VERIFIED' / 'AUTO: CHECK'),
// then other outlets that reported the same event, for the editor to compare.
function reviewNotes(verification, alsoReportedBy = []) {
  const head = verification.result === 'VERIFIED' ? 'AUTO: VERIFIED' : `AUTO: CHECK - ${verification.note}`;
  const others = (alsoReportedBy || []).map((o) => `${o.source}: ${o.title} (${o.link})`);
  return others.length ? `${head}\nPossibly the same story elsewhere (check before relying on it): ${others.join('; ')}` : head;
}

async function saveRows(supabase, rows, report) {
  for (const row of rows) {
    if (row.status !== REVIEW_STATUS || row.is_true_fact !== false) throw new Error('The pipeline may only save stories for review');
    const { data, error } = await supabase.from('ca_stories').insert(row).select('id');
    if (!error) {
      report.saved++;
      const id = Array.isArray(data) ? data[0]?.id : data?.id;
      // The pipeline only ever creates stories for review; the history says so.
      await audit.record({
        actor: 'pipeline', action: 'story.collected', entityType: 'story', entityId: id,
        after: { status: row.status, publish_date: row.publish_date },
        detail: `Collected from ${row.source} for ${row.publish_date}: ${row.review_notes}`,
      }, { client: supabase });
      continue;
    }
    if (error.code === '23505') report.skipped.push({ title: row.title_kid, reason: 'already saved (same source link)' });
    else report.skipped.push({ title: row.title_kid, reason: `save failed: ${error.message}` });
  }
}

/**
 * Runs the pipeline once. Writes only when dryRun is false AND
 * CA_PIPELINE_ENABLED=true; otherwise the report lists the rows it would save.
 */
async function runDailyPipeline({ supabase, fetchImpl, llm = createLlm(), now = new Date(), dryRun = false, env = process.env } = {}) {
  const runId = crypto.randomUUID();
  const today = localDate(now);
  const publishDate = addDays(today, daysAhead(env));
  const writesEnabled = !dryRun && String(env.CA_PIPELINE_ENABLED || '').toLowerCase() === 'true';
  const report = {
    runId, date: publishDate, runDate: today, startedAt: now.toISOString(), mode: writesEnabled ? 'write' : 'dry-run',
    ...(dryRun || writesEnabled ? {} : { note: 'CA_PIPELINE_ENABLED is not "true": nothing was saved.' }),
    feeds: {}, collected: {}, selected: {}, verification: {}, written: 0, saved: 0, skipped: [], rows: [],
  };

  const collected = await collect({ supabase, fetchImpl, now });
  report.feeds = { read: collected.report.feedsRead.length, failed: collected.report.feedsFailed };
  report.collected = collected.report;

  const chosen = await select(collected.items, llm);
  report.selected = chosen.report;

  const checked = await verify(chosen.picks, llm, { fetchImpl });
  report.verification = { verified: checked.report.verified, unclear: checked.report.unclear, dropped: checked.report.dropped };

  const written = await write(checked.kept, llm);
  report.written = written.report.written;
  report.skipped.push(...written.report.skipped);

  const rows = written.stories.map((s, rank) => toRow(s, { publishDate, rank }));
  if (writesEnabled) await saveRows(supabase, rows, report);
  else report.rows = rows;
  report.aiCalls = { ...llm.used };
  report.finishedAt = new Date().toISOString();
  return report;
}

// A short, safe summary for the server console (no page text, no secrets).
function summarize(report) {
  const failed = (report.feeds.failed || []).map((f) => `${f.source} (${f.reason})`).join('; ') || 'none';
  return `[ca-pipeline] ${report.runId} ${report.date} ${report.mode}: feeds read ${report.feeds.read}, failed ${failed}; `
    + `items ${report.collected.collected} -> kept ${report.collected.kept}; selected ${report.selected.selected}${report.selected.error ? ` (${report.selected.error})` : ''}; `
    + `verified ${report.verification.verified}, unclear ${report.verification.unclear}, dropped ${report.verification.dropped.length}; `
    + `written ${report.written}; saved ${report.saved}; skipped ${report.skipped.length}`;
}

// How many days ahead the digest is prepared: CA_DIGEST_DAYS_AHEAD, 0 to 3, default 1 (tomorrow).
function daysAhead(env = process.env) {
  const raw = env.CA_DIGEST_DAYS_AHEAD;
  if (raw === undefined || raw === '') return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 3 ? n : 1;
}

module.exports = { runDailyPipeline, toRow, reviewNotes, summarize, daysAhead, REVIEW_STATUS };
