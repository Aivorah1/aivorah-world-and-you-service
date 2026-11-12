// Students must never wait on the AI: if generated content isn't ready within
// FAST_REPLY_MS, the request answers right away with a ready-made fact /
// puzzle (marked partial: true) while the AI keeps working in the background
// and fills the cache for the next request.
const FAST_REPLY_MS = Number(process.env.FAST_REPLY_MS || 2000);

// { done: true, value } | { done: true, error } | { done: false } after `ms`.
function within(promise, ms = FAST_REPLY_MS) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([
    promise.then((value) => ({ done: true, value }), (error) => ({ done: true, error })),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

function gradeNumber(grade) {
  const g = String(grade || '').toLowerCase();
  if (/nursery|lkg|ukg|pre|kg/.test(g)) return 0;
  const n = parseInt(g.replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : 3;
}

// Checked, uncontroversial facts.
const GK_FACTS = [
  { fact: 'Octopuses have three hearts and blue blood.', category: 'Animals' },
  { fact: 'A day on Venus (243 Earth days) is longer than its whole year (225 Earth days).', category: 'Space & Universe' },
  { fact: 'An adult human body has 206 bones.', category: 'Human Body' },
  { fact: 'Some kinds of bamboo can grow almost a metre in a single day.', category: 'Science & Nature' },
  { fact: 'Lightning is about five times hotter than the surface of the Sun.', category: 'Science & Nature' },
  { fact: 'India’s Chandrayaan-3 landed near the Moon’s south pole on 23 August 2023.', category: 'Space & Universe' },
  { fact: 'The Great Wall of China cannot be seen with the naked eye from the Moon.', category: 'Geography' },
  { fact: 'Honey does not spoil: sealed honey can stay edible for a very long time.', category: 'Science & Nature' },
];

const CHALLENGES = {
  young: [
    { question: 'I have four legs, I give milk and I say "moo". Who am I?', answer: 'A cow!' },
    { question: 'What comes next: red, blue, red, blue, ...?', answer: 'Red.' },
  ],
  primary: [
    { question: 'You have 3 boxes with 4 pencils in each and give away 5 pencils. How many pencils are left?', answer: '7 pencils (3 × 4 = 12, and 12 − 5 = 7).' },
    { question: 'Which is heavier: a kilogram of feathers or a kilogram of stones?', answer: 'Neither — both weigh exactly one kilogram.' },
  ],
  middle: [
    { question: 'A train leaves at 9:40 and the journey takes 2 hours 35 minutes. When does it arrive?', answer: '12:15.' },
    { question: 'What is the next number: 2, 6, 12, 20, 30, ...?', answer: '42 — the gaps grow by 2 each time (4, 6, 8, 10, 12).' },
  ],
  senior: [
    { question: 'The sum of three consecutive odd numbers is 75. What are they?', answer: '23, 25 and 27.' },
    { question: 'A car drives 60 km at 30 km/h and comes back the same 60 km at 60 km/h. What is its average speed for the whole trip?', answer: '40 km/h — 120 km in 3 hours, not the average of the two speeds.' },
  ],
};

function fallbackChallenge(grade, date = new Date()) {
  const n = gradeNumber(grade);
  const band = n <= 2 ? 'young' : n <= 5 ? 'primary' : n <= 8 ? 'middle' : 'senior';
  const list = CHALLENGES[band];
  return list[date.getDate() % list.length];
}

function fallbackGKFact(date = new Date()) {
  return GK_FACTS[date.getDate() % GK_FACTS.length];
}

module.exports = { FAST_REPLY_MS, within, gradeNumber, fallbackChallenge, fallbackGKFact };
