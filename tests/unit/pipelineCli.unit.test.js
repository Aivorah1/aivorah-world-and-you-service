// The GitHub Actions pipeline scripts must fail loudly, naming what is
// missing, instead of crashing on "supabaseUrl is required." or reporting
// success after writing nothing.
const path = require('path');
const { spawnSync } = require('child_process');
const {
  DAILY_SETTINGS, missingSettings, missingSettingsMessage, dailyRunFailure,
} = require('../../scripts/lib/pipelineCli');

const ROOT = path.join(__dirname, '..', '..');

// Settings set to '' (not just absent) so a developer's local .env can't fill them in.
function runScript(script, args = []) {
  const blank = Object.fromEntries(DAILY_SETTINGS.map((k) => [k, '']));
  return spawnSync(process.execPath, [path.join('scripts', script), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...blank, CA_PIPELINE_ENABLED: 'true' },
  });
}

describe('missingSettings', () => {
  test('lists unset and blank settings', () => {
    expect(missingSettings(DAILY_SETTINGS, { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: '  ' }))
      .toEqual(['SUPABASE_SERVICE_KEY', 'GROQ_API_KEY']);
    expect(missingSettings(DAILY_SETTINGS, { SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k', GROQ_API_KEY: 'g' })).toEqual([]);
  });

  test('the message names each setting and where to add it on GitHub', () => {
    const msg = missingSettingsMessage('[ca-pipeline]', ['SUPABASE_URL', 'GROQ_API_KEY']);
    expect(msg).toMatch(/SUPABASE_URL, GROQ_API_KEY/);
    expect(msg).toMatch(/Secrets and variables → Actions/);
  });
});

describe('dailyRunFailure', () => {
  test('a selection error (e.g. the AI call failed) is a failure', () => {
    expect(dailyRunFailure({ selected: { selected: 0, error: 'AI selection failed: bad key' } }))
      .toBe('story selection failed: AI selection failed: bad key');
  });

  test('a normal run, even one that saved nothing new, is not', () => {
    expect(dailyRunFailure({ selected: { selected: 6 }, saved: 0 })).toBeNull();
  });
});

describe('the scripts as GitHub Actions runs them', () => {
  test('daily digest without secrets exits 1 and names them', () => {
    const r = runScript('runDailyPipeline.js');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing settings: SUPABASE_URL, SUPABASE_SERVICE_KEY, GROQ_API_KEY/);
  });

  test('weekly quiz without secrets exits 1 and names them', () => {
    const r = runScript('generateWeeklyQuiz.js');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[ca-quiz\] missing settings: SUPABASE_URL, SUPABASE_SERVICE_KEY, GROQ_API_KEY/);
  });
});
