// Runs the daily Current Affairs pipeline once from the command line.
//   node scripts/runDailyPipeline.js --dry-run   prints the report and the rows it would save; writes nothing
//   node scripts/runDailyPipeline.js             saves for review only when CA_PIPELINE_ENABLED=true
// A dry run without SUPABASE_URL skips the "already saved" check (said in the report).
require('dotenv').config();
const { runDailyPipeline, summarize } = require('../current-affairs/pipeline/run');
const { DAILY_SETTINGS, missingSettings, missingSettingsMessage, dailyRunFailure } = require('./lib/pipelineCli');

// Answers every query with no rows: for a dry run with no database settings.
function offlineSupabase() {
  const query = { select: () => query, in: () => query, then: (resolve) => resolve({ data: [], error: null }) };
  return { from: () => query };
}

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  // A real run needs every setting; say which are missing instead of failing
  // inside the Supabase client with "supabaseUrl is required."
  const missing = missingSettings(DAILY_SETTINGS);
  if (!dryRun && missing.length) {
    console.error(missingSettingsMessage('[ca-pipeline]', missing));
    process.exit(1);
  }
  const offline = dryRun && !process.env.SUPABASE_URL;
  const supabase = offline ? offlineSupabase() : require('../services/supabase');
  const report = await runDailyPipeline({ supabase, dryRun });
  if (offline) report.note = 'No SUPABASE_URL: stories already in the database were not checked for this dry run.';
  console.log(JSON.stringify(report, null, 2));
  console.log(summarize(report));
  const failure = dailyRunFailure(report);
  if (failure) {
    console.error(`[ca-pipeline] failed: ${failure}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error('[ca-pipeline] failed:', err.message);
  process.exit(1);
});
