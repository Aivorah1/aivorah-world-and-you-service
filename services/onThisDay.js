// "On This Day" from Wikipedia's curated feed (real, dated events) instead of
// asking the AI to recall them — the AI regularly put real events on the
// wrong date (e.g. "12 November 1960: first televised presidential debate",
// which was 26 September). Fetched once per calendar day for every grade.
const axios = require('axios');

const FEED = 'https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday';
const USER_AGENT = 'AivorahWorldAndYou/1.0 (school learning app)';
const TIMEOUT_MS = 4000;

// Not for a children's app: violence, disasters, war, death.
const UNSUITABLE = /\b(kill(ed|ing|s)?|death|deaths|dead|die[sd]?|dying|murder\w*|massacre\w*|war|wars|battle\w*|invasion|invaded|invade\w*|attack\w*|bomb\w*|explosion\w*|explod\w*|shot|shoot\w*|fire on|opened fire|terror\w*|assassinat\w*|execut\w*|crash\w*|collid\w*|sank|sunk|sinking|shipwreck|disaster\w*|cyclone|earthquake|tsunami|famine|epidemic|plague|riot\w*|coup|genocide|massacre|hostage\w*|missile\w*|weapon\w*|nuclear test|troops|soldiers|military|army|navy|perish\w*|bodies|corpse|dynamite|slave\w*|lynch\w*|hanged|suicide|injur\w*|casualt\w*|disease\w*|virus\w*|coronavirus|outbreak\w*|pandemic\w*|infect\w*|SARS|AIDS|HIV|ebola|cholera|cancer|zoonotic|soap opera\w*|fictional|wed|weds|wedding\w*|married|marriage|divorc\w*|affair|scandal\w*|crime\w*|criminal\w*|arrest\w*|prison\w*|jail\w*|convict\w*|sentenced|trial|drug\w*|alcohol\w*|prohibition|tobacco|cigarette\w*|gambl\w*|casino\w*|sex\w*|porn\w*|rape\w*|abus\w*|kidnap\w*|hijack\w*|smuggl\w*|mafia|gang\w*|nazi\w*|fascis\w*|dictator\w*|overthr\w*|resign\w*|impeach\w*|revolutionar\w*|guerrill\w*)\b/i;

// Prefer events children enjoy.
const FRIENDLY = /\b(space|spacecraft|lander|rover|satellite|moon|planet|comet|telescope|astronaut|discover\w*|invent\w*|first|record|olympic|football|cricket|sport\w*|film|music|song|book|novel|museum|zoo|animal|park|bridge|railway|airline|flight|computer|internet|science|scientist|vaccine|medal|prize|nobel|founded|opened|launched|premiered|published|unesco|world heritage)\b/i;

function clean(text) {
  return String(text || '')
    .replace(/\s*\((pictured|depicted|video featured|illustrated|shown)\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function suitable(event) {
  return event && Number.isInteger(event.year) && event.text && !UNSUITABLE.test(event.text);
}

// Up to `count` child-friendly events, friendly topics first, newest first.
function pickEvents(events, count = 3) {
  const ok = (events || []).filter(suitable);
  const ranked = [...ok].sort((a, b) => {
    const fa = FRIENDLY.test(a.text) ? 1 : 0;
    const fb = FRIENDLY.test(b.text) ? 1 : 0;
    return fb - fa || b.year - a.year;
  });
  const seenYears = new Set();
  const picked = [];
  for (const e of ranked) {
    if (picked.length >= count) break;
    if (seenYears.has(e.year)) continue;
    seenYears.add(e.year);
    picked.push({ year: e.year, fact: clean(e.text) });
  }
  return picked.sort((a, b) => b.year - a.year);
}

const byDay = {};      // 'MM/DD' -> events
const pending = {};    // 'MM/DD' -> in-flight promise

function monthDay(date) {
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
}

async function fetchFeed(kind, md) {
  const res = await axios.get(`${FEED}/${kind}/${md}`, {
    timeout: TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT },
  });
  return Array.isArray(res.data?.[kind]) ? res.data[kind] : [];
}

// Three real events for the date, or [] if Wikipedia can't be reached (the
// app hides the card rather than show made-up history).
async function getOnThisDay(date = new Date()) {
  const md = monthDay(date);
  if (byDay[md]) return byDay[md];
  if (!pending[md]) {
    pending[md] = (async () => {
      try {
        let events = pickEvents(await fetchFeed('selected', md));
        if (events.length < 3) {
          const more = await fetchFeed('events', md).catch(() => []);
          events = pickEvents([...events.map((e) => ({ year: e.year, text: e.fact })), ...more]);
        }
        if (events.length) byDay[md] = events;
        return events;
      } catch (e) {
        console.warn('[on-this-day] Wikipedia feed unavailable:', e.message);
        return [];
      } finally {
        delete pending[md];
      }
    })();
  }
  return pending[md];
}

function __reset() {
  for (const k of Object.keys(byDay)) delete byDay[k];
}

module.exports = { getOnThisDay, pickEvents, UNSUITABLE, __reset };
