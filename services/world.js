const Groq = require('groq-sdk');
const { getOnThisDay } = require('./onThisDay');
const { within, fallbackChallenge, fallbackGKFact } = require('./fastReply');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// GET /world/daily: On This Day (Wikipedia) + Fun Challenge (AI) per grade.
//
// Speed: students used to wait 13-19 s (and often got a 500) because every
// grade's content was generated on its first request of the day, by three AI
// calls, and the cache lived only in memory — lost each time Render put the
// service to sleep. Now:
//   - On This Day comes from Wikipedia (one ~0.6 s request per day, all grades);
//   - only the Fun Challenge uses the AI, and a request never waits for it more
//     than FAST_REPLY_MS — a ready-made puzzle is sent instead (partial: true)
//     while the AI finishes in the background and fills the cache;
//   - prewarmWorldDaily() prepares every grade when the service starts.
// Current affairs moved to the Current Affairs tab (aivorah-current-affairs-
// service), so this endpoint no longer generates them (currentAffairs: []).

const cache = {};    // `${date}_${grade}` -> full data
const pending = {};  // `${date}_${grade}` -> in-flight generation

function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ── Grade → age mapping for age-appropriate content ─────────────────
const GRADE_INFO = {
  'Nursery': { age: '3-4', tone: 'tiny words, one idea, animals, colours and shapes' },
  'LKG': { age: '4-5', tone: 'tiny words, one idea, animals, colours and counting to 10' },
  'UKG': { age: '5-6', tone: 'very simple words, counting, shapes and everyday things' },
  'Grade 1': { age: '6-7',  tone: 'very simple, short sentences, familiar topics like animals and colors' },
  'Grade 2': { age: '7-8',  tone: 'simple language, relatable everyday examples' },
  'Grade 3': { age: '8-9',  tone: 'curious explorers, fun facts, vivid descriptions, exciting tone' },
  'Grade 4': { age: '9-10', tone: 'more detail, comparisons, slightly complex ideas' },
  'Grade 5': { age: '10-11', tone: 'deeper explanations, cause-and-effect, broader world view' },
  'Grade 6': { age: '11-12', tone: 'analytical thinking, global awareness, scientific reasoning' },
  'Grade 7': { age: '12-13', tone: 'critical thinking, connecting concepts across subjects' },
  'Grade 8': { age: '13-14', tone: 'mature reasoning, real-world applications, nuanced understanding' },
  'Grade 9': { age: '14-15', tone: 'advanced concepts, current global issues, research-style' },
  'Grade 10': { age: '15-16', tone: 'exam-level rigor, structured analytical reasoning, board/IGCSE-appropriate depth' },
  'Grade 11': { age: '16-17', tone: 'pre-university complexity, genuine critical analysis, IB DP / Std XI depth — never simplify to primary-school level' },
  'Grade 12': { age: '17-18', tone: 'university-preparatory, sophisticated cross-disciplinary reasoning, IB DP / Std XII depth — never simplify to primary-school level' },
};
const ALL_GRADES = Object.keys(GRADE_INFO);

function gradeInfo(grade) {
  return GRADE_INFO[grade] || GRADE_INFO['Grade 3'];
}

// ── Fun Challenge difficulty guidance per grade band ─────────────────
function challengeDifficultyHint(grade) {
  const n = parseInt(String(grade).replace(/\D/g, ''), 10);
  if (!Number.isFinite(n) || n <= 2) return 'Keep it to single-digit counting or simple shape/pattern recognition.';
  if (n <= 5)  return 'A short logic or basic-math puzzle a curious primary-schooler can solve with a bit of thought — not trivial single-step arithmetic.';
  if (n <= 8)  return 'A genuine multi-step logic, ratio, or pattern puzzle requiring real reasoning, not a one-line sum.';
  return 'A genuinely challenging puzzle requiring multi-step reasoning, real-world application, or subject-level thinking appropriate for a pre-university student — nothing that would look out of place in a competition/olympiad warm-up.';
}

function parseJSONObject(raw) {
  const clean = String(raw || '').replace(/```json\n?/g, '').replace(/```/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  return JSON.parse(match[0]);
}

async function generateChallenge(grade) {
  const info = gradeInfo(grade);
  const resp = await groq.chat.completions.create({
    model: 'openai/gpt-oss-20b',
    messages: [{
      role: 'user',
      content: `You are Ms. Zara, a warm teacher for ${grade} students (age ${info.age}). Style: ${info.tone}.
Write ONE thinking question with its answer. ${challengeDifficultyHint(grade)}
Do not mention any age or grade in the question. Make sure the answer is correct.
Respond ONLY with JSON: {"question":"...","answer":"..."}`,
    }],
    temperature: 0.7,
    // gpt-oss-20b is a reasoning model: keep its thinking short so it answers.
    reasoning_effort: 'low',
    max_tokens: 1200,
  });
  const parsed = parseJSONObject(resp.choices?.[0]?.message?.content);
  if (!parsed.question || !parsed.answer) throw new Error('Challenge without question/answer');
  return { question: String(parsed.question), answer: String(parsed.answer) };
}

function assemble(grade, date, onThisDay, funChallenge, partial) {
  const month = date.toLocaleString('en-US', { month: 'long' });
  return {
    date: `${month} ${date.getDate()}`,
    grade,
    onThisDay,
    gkFact: { title: 'Did You Know?', ...fallbackGKFact(date) },
    currentAffairs: [],
    funChallenge,
    ...(partial ? { partial: true } : {}),
  };
}

// Full content for a grade (AI challenge). Shared by every request for that
// grade+day while it runs; cached when it succeeds.
function generate(grade, date) {
  const key = `${todayKey(date)}_${grade}`;
  if (!pending[key]) {
    pending[key] = Promise.all([getOnThisDay(date), generateChallenge(grade)])
      .then(([onThisDay, challenge]) => {
        const data = assemble(grade, date, onThisDay, challenge, false);
        cache[key] = data;
        return data;
      })
      .finally(() => { delete pending[key]; });
  }
  return pending[key];
}

async function getWorldDaily(grade, { now = new Date(), fastReplyMs } = {}) {
  const key = `${todayKey(now)}_${grade}`;
  if (cache[key]) return cache[key];

  const result = await within(generate(grade, now), fastReplyMs);
  if (result.done && !result.error) return result.value;
  if (result.error) console.warn(`[world/daily] AI challenge failed for ${grade}:`, result.error.message);

  // AI slow or failed: answer now with real On This Day + a ready-made puzzle.
  const onThisDay = await getOnThisDay(now).catch(() => []);
  return assemble(grade, now, onThisDay, fallbackChallenge(grade, now), true);
}

// Prepare today's content for every grade, a few at a time, so the first
// students of the day (or after a restart) get it instantly.
async function prewarmWorldDaily({ grades = ALL_GRADES, concurrency = 2, now = new Date() } = {}) {
  const queue = grades.filter((g) => !cache[`${todayKey(now)}_${g}`]);
  const worker = async () => {
    while (queue.length) {
      const grade = queue.shift();
      try { await generate(grade, now); } catch (e) { console.warn(`[world/daily] prewarm ${grade}:`, e.message); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

function __reset() {
  for (const k of Object.keys(cache)) delete cache[k];
}

module.exports = { getWorldDaily, prewarmWorldDaily, ALL_GRADES, __reset };
