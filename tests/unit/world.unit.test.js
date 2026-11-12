const mockGroqCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: (...args) => mockGroqCreate(...args) } },
})));
jest.mock('axios');
const axios = require('axios');

const { getWorldDaily, prewarmWorldDaily, __reset } = require('../../services/world');
const onThisDay = require('../../services/onThisDay');

const NOW = new Date('2026-11-12T09:00:00');

function groqResponse(content) {
  return { choices: [{ message: { content } }] };
}
const challengeReply = (q = 'Why is the sky blue?', a = 'Light scattering.') =>
  groqResponse(JSON.stringify({ question: q, answer: a }));

// Wikipedia's "selected" feed for 12 November (shape of the real API).
const WIKI_SELECTED = {
  selected: [
    { year: 2014, text: "The European Space Agency's lander Philae touched down on a comet, the first spacecraft to land on one." },
    { year: 2001, text: 'American Airlines Flight 587 crashed into residential buildings shortly after takeoff.' },
    { year: 1973, text: 'The first episode of Last of the Summer Wine (pictured), the longest-running sitcom, premiered on the BBC.' },
    { year: 1944, text: 'Second World War: the Royal Air Force sank the German battleship Tirpitz, killing about 1,000.' },
    { year: 1911, text: 'The Corozal, the most powerful dredger ever built, was launched in London.' },
    { year: 1892, text: 'William Heffelfinger became the first professional American football player.' },
  ],
};

function mockWikipedia(data = WIKI_SELECTED) {
  axios.get.mockImplementation((url) => (url.includes('/selected/')
    ? Promise.resolve({ data })
    : Promise.resolve({ data: { events: [] } })));
}

beforeEach(() => {
  jest.clearAllMocks();
  __reset();
  onThisDay.__reset();
  mockWikipedia();
});

describe('On This Day comes from Wikipedia, not the AI', () => {
  test('three real, child-safe events for the date, newest first', async () => {
    mockGroqCreate.mockResolvedValueOnce(challengeReply());
    const result = await getWorldDaily('Grade 6', { now: NOW });

    expect(axios.get).toHaveBeenCalledWith(
      'https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/selected/11/12',
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) }),
    );
    expect(result.onThisDay).toHaveLength(3);
    const text = result.onThisDay.map((e) => e.fact).join(' ');
    expect(text).not.toMatch(/crashed|killing|sank/);
    expect(result.onThisDay[0].year).toBe(2014);
    expect(text).not.toMatch(/\(pictured\)/);
    // The AI is only asked for the puzzle.
    expect(mockGroqCreate).toHaveBeenCalledTimes(1);
    expect(mockGroqCreate.mock.calls[0][0].messages[0].content).not.toMatch(/On This Day/);
  });

  test('Wikipedia unreachable → no On This Day (the card hides) rather than made-up history', async () => {
    axios.get.mockRejectedValue(new Error('offline'));
    mockGroqCreate.mockResolvedValueOnce(challengeReply());
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await getWorldDaily('Grade 6', { now: NOW });
    expect(result.onThisDay).toEqual([]);
    expect(result.funChallenge.answer).toBe('Light scattering.');
    warn.mockRestore();
  });

  test('fetched once per day for every grade', async () => {
    mockGroqCreate.mockResolvedValue(challengeReply());
    await getWorldDaily('Grade 3', { now: NOW });
    await getWorldDaily('Grade 9', { now: NOW });
    expect(axios.get.mock.calls.filter(([u]) => u.includes('/selected/'))).toHaveLength(1);
  });
});

describe('speed: a student never waits for the AI', () => {
  test('full content is cached: the second request makes no new calls', async () => {
    mockGroqCreate.mockResolvedValueOnce(challengeReply());
    const first = await getWorldDaily('Grade 6', { now: NOW });
    mockGroqCreate.mockClear();
    axios.get.mockClear();
    const second = await getWorldDaily('Grade 6', { now: NOW });
    expect(second).toBe(first);
    expect(mockGroqCreate).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(first.partial).toBeUndefined();
  });

  test('a slow AI → a ready-made puzzle at once (partial), the AI one is cached for later', async () => {
    let finish;
    mockGroqCreate.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));

    const quick = await getWorldDaily('Grade 10', { now: NOW, fastReplyMs: 20 });
    expect(quick.partial).toBe(true);
    expect(quick.onThisDay).toHaveLength(3); // real events even in the quick reply
    expect(quick.funChallenge.question).toBeTruthy();

    finish(challengeReply('AI puzzle?', 'AI answer'));
    await new Promise((r) => setTimeout(r, 0));
    const later = await getWorldDaily('Grade 10', { now: NOW });
    expect(later.partial).toBeUndefined();
    expect(later.funChallenge).toEqual({ question: 'AI puzzle?', answer: 'AI answer' });
  });

  test('an AI error or unusable reply answers with the ready-made puzzle instead of a 500', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGroqCreate.mockResolvedValueOnce(groqResponse('not json at all'));
    const result = await getWorldDaily('Nursery', { now: NOW });
    expect(result.partial).toBe(true);
    expect(result.funChallenge.question).toMatch(/moo|red, blue/);
    warn.mockRestore();
  });

  test('current affairs are no longer generated here (they have their own tab)', async () => {
    mockGroqCreate.mockResolvedValueOnce(challengeReply());
    const result = await getWorldDaily('Grade 6', { now: NOW });
    expect(result.currentAffairs).toEqual([]);
    expect(result.gkFact.fact).toBeTruthy();
    expect(result.date).toBe('November 12');
  });

  test('prewarm prepares every grade in the background, two at a time', async () => {
    let running = 0;
    let peak = 0;
    mockGroqCreate.mockImplementation(async () => {
      running += 1; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return challengeReply();
    });
    await prewarmWorldDaily({ grades: ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4'], now: NOW });
    expect(mockGroqCreate).toHaveBeenCalledTimes(4);
    expect(peak).toBe(2);
    mockGroqCreate.mockClear();
    const cached = await getWorldDaily('Grade 3', { now: NOW });
    expect(cached.partial).toBeUndefined();
    expect(mockGroqCreate).not.toHaveBeenCalled();
  });
});

describe('pickEvents (child-safety filter)', () => {
  test('drops violent or tragic events and keeps one per year', () => {
    const picked = onThisDay.pickEvents([
      { year: 2000, text: 'A rocket was launched to study the Sun.' },
      { year: 2000, text: 'A museum opened.' },
      { year: 1990, text: 'Troops invaded the city.' },
      { year: 1980, text: 'An earthquake caused deaths.' },
      { year: 1970, text: 'The first email was sent.' },
    ]);
    expect(picked.map((e) => e.year)).toEqual([2000, 1970]);
  });
});
