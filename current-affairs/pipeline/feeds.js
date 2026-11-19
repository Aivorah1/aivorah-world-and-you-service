// Approved news sources (and only these), fetching and RSS/Atom parsing.
// A feed that fails is skipped and listed in the run report; it never stops a run.

const FEEDS = [
  { source: 'The Hindu', category: 'india', url: 'https://www.thehindu.com/news/national/feeder/default.rss' },
  { source: 'RBI', category: 'economy', url: 'https://rbi.org.in/pressreleases_rss.xml' },
  { source: 'The Hindu', category: 'economy', url: 'https://www.thehindu.com/business/Economy/feeder/default.rss' },
  { source: 'UN News', category: 'world', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml' },
  { source: 'The Hindu', category: 'world', url: 'https://www.thehindu.com/news/international/feeder/default.rss' },
  { source: 'The Hindu', category: 'science', url: 'https://www.thehindu.com/sci-tech/science/feeder/default.rss' },
  { source: 'UN News', category: 'environment', url: 'https://news.un.org/feed/subscribe/en/news/topic/climate-change/feed/rss.xml' },
  { source: 'The Hindu', category: 'environment', url: 'https://www.thehindu.com/sci-tech/energy-and-environment/feeder/default.rss' },
  { source: 'Mongabay India', category: 'environment', url: 'https://india.mongabay.com/feed/' },
  { source: 'Sportstar', category: 'sports', url: 'https://sportstar.thehindu.com/feeder/default.rss' },
  { source: 'UN News', category: 'society', url: 'https://news.un.org/feed/subscribe/en/news/topic/culture-and-education/feed/rss.xml' },
  { source: 'The Hindu', category: 'society', url: 'https://www.thehindu.com/education/feeder/default.rss' },
];
// PIB: its RSS feeds give Hindi headlines without dates (checked 19 Nov 2026),
// so the English "All releases" page is read instead: today's releases with
// their ids and English headlines. Each release page gives the posting time
// ("Posted On: 19 NOV 2026 4:24PM by PIB Delhi", India time) and the text.
const PIB_RELEASES = { source: 'PIB', category: 'india', url: 'https://www.pib.gov.in/allRel.aspx?reg=3&lang=1' };
const PIB_MAX_RELEASES = 12;
const pibReleaseUrl = (prid) => `https://pib.gov.in/PressReleaseIframePage.aspx?PRID=${prid}&reg=3&lang=1`;
const isPibUrl = (url) => /(^|\.)pib\.gov\.in$/i.test((() => { try { return new URL(url).hostname; } catch { return ''; } })());

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TIMEOUT_MS = 15000;

// GET with a normal browser User-Agent, a 15 s timeout and one retry.
async function fetchText(url, { fetchImpl = (...a) => fetch(...a), timeoutMs = TIMEOUT_MS } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

// Text without HTML tags, entities decoded, spaces collapsed.
function stripHtml(raw) {
  const unwrapped = String(raw || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeEntities(decodeEntities(unwrapped).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

// RSS 2.0 <item> and Atom <entry> → [{ title, link, summary, publishedAt }].
function parseFeed(xml) {
  const text = String(xml || '');
  const blocks = text.match(/<item[\s>][\s\S]*?<\/item>/gi) || text.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((block) => {
    let link = stripHtml(tag(block, 'link'));
    if (!link) {
      const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = href ? decodeEntities(href[1]) : '';
    }
    const date = stripHtml(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date'));
    const parsed = date ? new Date(date) : null;
    return {
      title: stripHtml(tag(block, 'title')),
      link: link.trim(),
      summary: stripHtml(tag(block, 'description') || tag(block, 'summary') || tag(block, 'content')).slice(0, 1500),
      publishedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
    };
  }).filter((i) => i.title && /^https?:\/\//i.test(i.link));
}

// The releases on PIB's "All releases" page: [{ prid, title }], newest id first, no repeats.
function parsePibReleaseList(html, max = PIB_MAX_RELEASES) {
  const seen = new Set();
  const out = [];
  for (const m of String(html || '').matchAll(/<a[^>]*href=["'][^"']*PRID=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    // PIB headlines sometimes start with invisible zero-width spaces.
    const title = stripHtml(m[2]).replace(/[​-‍﻿]/g, '').trim();
    if (!title || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ prid: m[1], title });
  }
  return out.sort((a, b) => Number(b.prid) - Number(a.prid)).slice(0, max);
}

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
// A PIB release page: { publishedAt (ISO, from India time), text (the release, between
// "Posted On" and "(Release ID: …)") }. publishedAt is null when the page has no date.
function extractPibRelease(html) {
  const text = stripHtml(html);
  const posted = text.match(/Posted On:?\s*(\d{1,2})\s+([A-Z]{3})[A-Z]*\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)/i);
  let publishedAt = null;
  if (posted && MONTHS[posted[2].toUpperCase()] !== undefined) {
    let hour = Number(posted[4]) % 12;
    if (posted[6].toUpperCase() === 'PM') hour += 12;
    // India is UTC+5:30 all year.
    const utc = Date.UTC(Number(posted[3]), MONTHS[posted[2].toUpperCase()], Number(posted[1]), hour, Number(posted[5])) - 330 * 60 * 1000;
    publishedAt = new Date(utc).toISOString();
  }
  const start = text.search(/Posted On:?/i);
  const end = text.search(/\(Release ID:?\s*\d+\)/i);
  let body = start >= 0 ? text.slice(start, end > start ? end : undefined) : '';
  body = body.replace(/^Posted On:?\s*\d{1,2}\s+[A-Z]{3}[A-Z]*\s+\d{4}\s+\d{1,2}:\d{2}\s*[AP]M(\s+by\s+PIB\s+[A-Za-z ]+?(?=\s[A-Z][a-z]))?/i, '').trim();
  return { publishedAt, text: body.slice(0, 8000) };
}

module.exports = {
  FEEDS, PIB_RELEASES, PIB_MAX_RELEASES, USER_AGENT, fetchText, parseFeed, stripHtml, decodeEntities,
  parsePibReleaseList, extractPibRelease, pibReleaseUrl, isPibUrl,
};
