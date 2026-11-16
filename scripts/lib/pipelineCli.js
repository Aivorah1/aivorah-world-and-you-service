// Shared checks for the command-line pipeline scripts run by GitHub Actions
// (.github/workflows/daily-digest.yml, weekly-quiz.yml).

// Settings each script needs. On GitHub these come from the repository's
// Actions secrets, under exactly these names.
const DAILY_SETTINGS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'GROQ_API_KEY'];
const QUIZ_SETTINGS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'GROQ_API_KEY'];

function missingSettings(names, env = process.env) {
  return names.filter((name) => !String(env[name] || '').trim());
}

function missingSettingsMessage(tag, missing) {
  return `${tag} missing settings: ${missing.join(', ')}. `
    + 'On GitHub add them as repository secrets with exactly these names '
    + '(Settings → Secrets and variables → Actions); locally put them in .env.';
}

// A daily run that could not pick any stories because a step errored (e.g. the
// AI call failed) must fail the job, not report success with nothing written.
function dailyRunFailure(report) {
  if (report?.selected?.error) return `story selection failed: ${report.selected.error}`;
  return null;
}

module.exports = { DAILY_SETTINGS, QUIZ_SETTINGS, missingSettings, missingSettingsMessage, dailyRunFailure };
