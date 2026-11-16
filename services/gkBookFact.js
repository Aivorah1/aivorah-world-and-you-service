// The World & You → GK tab "Did you know?" fact, from the checked
// important-days book (current-affairs/data/gk-events.json) instead of a
// fact the AI makes up each day. AI-written facts were often wrong (e.g.
// "the world's biggest desert is the Arctic"), and children learn from this.
const gk = require('../current-affairs/services/gk-facts');
const { localDate } = require('../current-affairs/services/content');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const LOOK_AHEAD_DAYS = 7; // a few dates have no entry in the book

function shiftDate(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function factFor(event) {
  return (event.facts || []).find((f) => f && f.length > 20) || event.description;
}

// { date, gk: { fact, category, eventName, eventDate } } for today's important
// day (India date), or the next one within a week; null if there is none.
function bookGKFact(now = new Date()) {
  const today = localDate(now);
  for (let ahead = 0; ahead <= LOOK_AHEAD_DAYS; ahead++) {
    const date = shiftDate(today, ahead);
    const [event] = gk.getEventsForDate(date);
    if (!event) continue;
    const when = ahead === 0 ? 'Today is' : `Coming up on ${event.day} ${MONTHS[Number(date.slice(5, 7)) - 1]}:`;
    return {
      date: today,
      gk: {
        fact: `${when} ${event.event_name}! ${factFor(event)}`,
        category: 'Important Day',
        eventName: event.event_name,
        eventDate: event.date,
      },
    };
  }
  return null;
}

module.exports = { bookGKFact };
