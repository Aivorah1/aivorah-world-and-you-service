// Step 1: read every approved feed, keep the last 24 hours, drop duplicates
// and anything already saved (any status, rejected included).
const { FEEDS, PIB_RELEASES, fetchText, parseFeed, parsePibReleaseList, extractPibRelease, pibReleaseUrl } = require('./feeds');
const { urlHash } = require('../services/sourceUrl');
const { check } = require('../services/db');

const WINDOW_MS = 24 * 60 * 60 * 1000;

function titleTokens(title) {
  return new Set(String(title).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
}
function overlap(a, b) {
  const A = titleTokens(a); const B = titleTokens(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const t of A) if (B.has(t)) both++;
  return both / (A.size + B.size - both);
}
// Near-identical headlines: the same report (only one is kept).
const similar = (a, b) => overlap(a, b) >= 0.7;
// Headlines sharing many words: probably the same event in another report.
const RELATED = 0.28; // chosen on real feeds (19 Nov): catches the same event, not just shared words
const MAX_SUPPORTING = 3;

async function readFeed(feed, fetchImpl, report) {
  try {
    const items = parseFeed(await fetchText(feed.url, { fetchImpl }));
    // Without dates we cannot tell what is from the last 24 hours (PIB's feeds today).
    if (items.length && items.every((i) => !i.publishedAt)) throw new Error('no publish dates in the feed');
    report.feedsRead.push({ source: feed.source, url: feed.url, items: items.length });
    return items.map((i) => ({ ...i, source: feed.source, feedCategory: feed.category }));
  } catch (err) {
    report.feedsFailed.push({ source: feed.source, url: feed.url, reason: err.message });
    return [];
  }
}

// Today's PIB releases (English): the list page, then each release page for
// its posting time and text. A release page that fails is skipped.
async function pibReleases(fetchImpl, report) {
  let list;
  try {
    list = parsePibReleaseList(await fetchText(PIB_RELEASES.url, { fetchImpl }));
    if (!list.length) throw new Error('no releases found on the PIB releases page');
  } catch (err) {
    report.feedsFailed.push({ source: 'PIB', url: PIB_RELEASES.url, reason: `PIB skipped: ${err.message}` });
    return [];
  }
  const items = (await Promise.all(list.map(async ({ prid, title }) => {
    const link = pibReleaseUrl(prid);
    try {
      const { publishedAt, text } = extractPibRelease(await fetchText(link, { fetchImpl }));
      return { title, link, summary: text.slice(0, 1500), publishedAt, source: 'PIB', feedCategory: PIB_RELEASES.category };
    } catch {
      return null;
    }
  }))).filter(Boolean);
  report.feedsRead.push({ source: 'PIB', url: PIB_RELEASES.url, items: items.length });
  return items;
}

async function existingHashes(supabase, hashes) {
  const found = new Set();
  for (let i = 0; i < hashes.length; i += 100) {
    const rows = check(await supabase.from('ca_stories').select('source_url_hash').in('source_url_hash', hashes.slice(i, i + 100)));
    for (const r of rows || []) found.add(r.source_url_hash);
  }
  return found;
}

async function collect({ supabase, fetchImpl, now = new Date(), feeds = FEEDS } = {}) {
  const report = { feedsRead: [], feedsFailed: [], collected: 0, tooOld: 0, noDate: 0, duplicates: 0, alreadySaved: 0, kept: 0 };
  const [fromFeeds, fromPib] = await Promise.all([
    Promise.all(feeds.map((f) => readFeed(f, fetchImpl, report))),
    feeds === FEEDS ? pibReleases(fetchImpl, report) : [],
  ]);
  const raw = [...fromFeeds.flat(), ...fromPib];
  report.collected = raw.length;

  const since = now.getTime() - WINDOW_MS;
  const fresh = raw.filter((i) => {
    if (!i.publishedAt) { report.noDate++; return false; }
    const t = new Date(i.publishedAt).getTime();
    if (t < since || t > now.getTime() + 60 * 60 * 1000) { report.tooOld++; return false; }
    return true;
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  const unique = [];
  const seen = new Set();
  for (const item of fresh) {
    const hash = urlHash(item.link);
    if (seen.has(hash) || unique.some((u) => similar(u.title, item.title))) { report.duplicates++; continue; }
    seen.add(hash);
    unique.push({ ...item, hash });
  }

  // Other outlets reporting the same event (for the editor to check against;
  // never used as a source of facts by the AI).
  for (const item of unique) {
    item.alsoReportedBy = fresh
      .filter((o) => o.source !== item.source && o.link !== item.link && overlap(o.title, item.title) >= RELATED)
      .slice(0, MAX_SUPPORTING)
      .map((o) => ({ source: o.source, title: o.title, link: o.link }));
  }

  const saved = unique.length ? await existingHashes(supabase, unique.map((i) => i.hash)) : new Set();
  const items = unique.filter((i) => {
    if (saved.has(i.hash)) { report.alreadySaved++; return false; }
    return true;
  });
  report.kept = items.length;
  return { items, report };
}

module.exports = { collect, similar, overlap, RELATED, WINDOW_MS };
