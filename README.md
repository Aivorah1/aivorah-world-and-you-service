# Aivorah World & You Service

Standalone microservice for "The World & You" — GK Fact, On This Day, Fun
Challenge, Current Affairs, and the comprehension quiz — extracted from
`ai-mentor/server`.

## Structure

```
routes/
  daily-tidbit.js   — thin route handlers: GET /, POST /quiz, POST /quiz-complete
  world.js          — thin route handler: GET /daily
services/
  dailyTidbit.js    — GK Fact generation, Current Affairs fetch/fallback,
                       quiz generation + option normalization, XP leveling
  world.js          — On This Day + GK Fact + Fun Challenge generation,
                       Current Affairs fetch/fallback (separate cache/prompt
                       set from dailyTidbit.js — both currently generate
                       overlapping content independently, not yet unified)
  supabase.js       — Supabase client
```

## Setup

```bash
npm install
cp .env.example .env   # fill in real keys
npm run dev             # nodemon, or `npm start` for a plain run
```

Runs on `PORT` (default `3010`).

## Endpoints

- `GET /daily-tidbit?grade=&bust=&currentAffairs=1` — today's GK Fact (grade-specific, cached per day); `currentAffairs=1` also adds the old current-affairs item. Answers within ~2 s: if the AI is slow a checked fact is returned with `partial: true`
- `POST /daily-tidbit/quiz` — generate 2 MCQ comprehension questions from a current-affairs article
- `POST /daily-tidbit/quiz-complete` — award XP for quiz results
- `GET /world/daily?grade=` — On This Day (3 real events from Wikipedia's feed, child-safe filter), Fun Challenge (AI; a ready-made puzzle with `partial: true` if the AI is slow). Every grade is prepared at start-up and when the date changes (`PREWARM=off` disables)
- `GET /health`

## Current Affairs (`/current-affairs`)

The daily news digest and the weekly quiz shown in the app's
The World & You → Current Affairs tab. **This service is the source of truth**
(moved here from aivorah-attendance-service, which now only forwards old app
versions' `/current-affairs` calls to this service).

```
current-affairs/
  routes/       digest, story, quiz, progress, admin (content tool)
  services/     content (age groups, stories), quiz, progress, rewards, analytics
  middleware/   auth.js (student = token email), adminAuth.js (editor allowlist)
services/firebaseAdmin.js   — verifies Firebase ID tokens
tests/current-affairs/      — supertest + an in-memory Supabase fake
```

- Tables `ca_*` and the `ca_apply_progress()` function: aivorah-db migrations
  (`0023_current_affairs.sql` and later).
- Stories and quiz questions are written by the pipeline in
  aivorah-current-affairs-service (GitHub Actions) and the admin content tool.
- Environment: see the Current Affairs block in `.env.example`
  (`FIREBASE_SERVICE_ACCOUNT_B64`, `AUTH_ENFORCE` — never `monitor` in production).

Endpoints: `GET /current-affairs/digest/today`, `GET /current-affairs/digest/list`,
`GET /current-affairs/story/:id`, `GET /current-affairs/quiz/week`,
`POST /current-affairs/quiz/check`, `POST /current-affairs/quiz/submit`,
`GET /current-affairs/progress/:studentEmail`,
`POST /current-affairs/progress/{digest-complete,story-read,quiz-complete}`,
`/current-affairs/admin/*` (editors only).

## Known gaps (carried over from the monolith, not introduced here)

- `POST /daily-tidbit/quiz-complete` has no server-side "already awarded
  today" check — XP can be awarded more than once per day if the client's
  local completion flag is bypassed (cleared storage, different device/
  browser context).
- `routes/daily-tidbit.js` and `routes/world.js` both independently
  generate a GK fact for the same day via separate prompts/caches — not
  reconciled into one source of truth.

## Branching

`main` is protected by convention — no direct pushes. Work on a feature
branch and open a PR.
