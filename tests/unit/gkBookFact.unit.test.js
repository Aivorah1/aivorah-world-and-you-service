// The World & You GK fact comes from the checked important-days book
// (current-affairs/data/gk-events.json), by India date — real data, no mocks.
const { bookGKFact } = require('../../services/gkBookFact');
const gk = require('../../current-affairs/services/gk-facts');

test("today's important day and one of its facts", () => {
  const r = bookGKFact(new Date('2026-11-16T06:00:00Z'));
  expect(r.date).toBe('2026-11-16');
  expect(r.gk).toMatchObject({ category: 'Important Day', eventName: 'National Legal Services Day', eventDate: '11-16' });
  expect(r.gk.fact).toMatch(/^Today is National Legal Services Day! \S/);
});

test('uses the India date: 20:00 UTC on 25 Jan is already Republic Day', () => {
  const r = bookGKFact(new Date('2026-01-25T20:00:00Z'));
  expect(r.date).toBe('2026-01-26');
  expect(r.gk.eventName).toBe('Republic Day');
  const facts = gk.getEventsForDate('01-26').find((e) => e.event_name === 'Republic Day').facts;
  expect(facts.some((f) => r.gk.fact.endsWith(f))).toBe(true);
});

test('a date the book skips gets the next important day', () => {
  expect(gk.getEventsForDate('03-02')).toEqual([]);
  const r = bookGKFact(new Date('2026-03-02T06:00:00Z'));
  expect(r.date).toBe('2026-03-02');
  expect(r.gk.fact).toMatch(/^Coming up on \d{1,2} March: /);
});

test('every day of the year has a fact', () => {
  for (let d = new Date('2026-01-01T06:00:00Z'); d.getUTCFullYear() === 2026; d.setUTCDate(d.getUTCDate() + 1)) {
    const r = bookGKFact(d);
    expect(r && r.gk.fact.length).toBeGreaterThan(30);
  }
});

test('5 March is two separate events (the book writes them with " / ")', () => {
  expect(gk.getEventsForDate('03-05').map((e) => e.event_name))
    .toEqual(['Maha Shivaratri', 'International Day for Disarmament and Non-Proliferation']);
});
