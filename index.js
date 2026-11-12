require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aivorah-world-and-you-service' }));

app.use('/daily-tidbit', require('./routes/daily-tidbit'));
app.use('/world',        require('./routes/world'));

const PORT = process.env.PORT || 3010;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Aivorah World & You service running on http://localhost:${PORT}`);
    startPrewarm();
  });
}

// Prepare today's content for every grade at start-up (Render restarts the
// service after it sleeps) and again when the date changes, so students don't
// wait for the AI. Runs in the background; requests are served meanwhile.
function startPrewarm() {
  if (process.env.PREWARM === 'off') return;
  const { prewarmWorldDaily, ALL_GRADES } = require('./services/world');
  const { prewarmDailyTidbits } = require('./services/dailyTidbit');
  let lastDay = '';
  const run = () => {
    const day = new Date().toDateString();
    if (day === lastDay) return;
    lastDay = day;
    Promise.all([prewarmWorldDaily(), prewarmDailyTidbits(ALL_GRADES)])
      .then(() => console.log(`[prewarm] content ready for ${ALL_GRADES.length} grades`))
      .catch((e) => console.warn('[prewarm]', e.message));
  };
  setTimeout(run, 1000);
  const timer = setInterval(run, 30 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = app;
