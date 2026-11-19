# CHANGELOG — Current Affairs Module

## 2026-11-19 — Editorial approval: tomorrow's digest, approve all, schedule, history

- **The pipeline prepares tomorrow's digest.** Stories it collects are dated
  the next day (India time) and saved for review only. Editors approve them
  during the day; students see them the next morning. `CA_DIGEST_DAYS_AHEAD`
  (0-3, default 1) changes how far ahead; 0 is the old same-day behaviour.
- **Approve the whole digest.** `POST /admin/stories/bulk-status` accepts
  `publishDate` `'today'`, `'tomorrow'` or a date that has not passed (before:
  only `'today'`). Without it each story keeps its own date. The admin tool
  groups the review queue by day with an "Approve all" button.
- **Scheduling.** An approved (published) story dated later is scheduled: the
  digest and `GET /story/:id` hide it until its day (the story route now
  checks `publish_date <= today`). A story dated in a past day cannot be
  approved (it would never be shown).
- **Approval history.** Every create, edit (fields changed, with the text they
  replaced), approve, reject, unpublish and archive of a story or quiz
  question is recorded in `ca_audit_log` (aivorah-db
  `0029_current_affairs_audit_log.sql`), including the pipeline's collected
  stories (actor `pipeline`). `GET /admin/stories/:id/history` lists it.
  Until the migration is run, changes still work and each unrecorded entry is
  logged as `[ca-audit] NOT RECORDED`.

## 2026-11-16 — The World & You: GK fact from the book, safer On This Day

- **GK fact** (`GET /daily-tidbit`, GK tab card) now comes from today's
  important day in `current-affairs/data/gk-events.json` (India date; the next
  important day when the book skips a date), via `services/gkBookFact.js`.
  The AI-written fact was often wrong (e.g. "the world's biggest desert is
  the Arctic"). The AI fact remains only as a fallback if the book has nothing.
- **On This Day** filter (`services/onThisDay.js`) now also drops diseases and
  outbreaks, soap operas/weddings, crime, drugs and revolutionaries; "television"
  no longer counts as a child-friendly topic (it ranked a soap-opera wedding first).
- **Data**: 5 March is two events (Maha Shivaratri; International Day for
  Disarmament and Non-Proliferation): the book writes that header with " / ".

## 2026-11-16 — GK Facts (important days calendar) moved here

GK Facts was built in aivorah-current-affairs-service, which is not deployed,
so none of it was reachable from the app. It now lives in this module under
`/current-affairs/gk` (today, date, event, search, quiz, upcoming, calendar).

- `routes/gk-facts.js`, `services/gk-facts.js`, `data/gk-events.json`,
  `scripts/build-gk-events.py`, `tests/current-affairs/gk-facts.test.js`.
- Ported with the fixes made there: `/gk/today` used to always return no
  events, quiz wrong answers were always the same three January events, and
  the data is a clean re-extraction from the PDF (390 events; the old file
  had text from neighbouring days mixed into 142 entries).
- No database, no sign-in, no new environment variables.

## 2026-11-16 — Fix: student digest shows blank when nothing is published today

### Problem
The student-facing digest endpoint (`GET /current-affairs/digest/today`) was falling
back to the **most recent published day** when today had no published stories. This
caused students to see old content (e.g. the Nov 9 seed digest with only 3 stories)
instead of a blank digest for a day the admin has not yet published.

### Expected behaviour (per product spec)
- Admin reviews and publishes stories for today first.
- Students see **only today's published stories**, filtered by their age group
  (7-12 or 13-15).
- If nothing is published for today → student sees a **blank digest** (empty stories array).
- The weekly quiz page already behaves correctly: if no questions are published for
  the week, the endpoint returns `total: 0, questions: []` → blank quiz page.

### Change made
**File:** `current-affairs/routes/digest.js`

Changed the default date resolution in the `/today` route:

```js
// BEFORE
date = await latestDigestDate(today);   // fell back to the latest published day

// AFTER
date = today;                           // today only; blank if nothing published
```

The optional `?date=YYYY-MM-DD` query parameter still works, so the app can view any
specific past day if needed. The `latestDigestDate` helper is no longer used by the
default path but is left in place for reference.

### What was NOT changed (working features kept intact)
- Quiz endpoints (`GET /quiz/week`, `POST /quiz/check`, `POST /quiz/submit`) — unchanged.
- Progress/rewards endpoints (`GET /progress/:studentEmail`, `POST /progress/*`) — unchanged.
- Story endpoint (`GET /story/:id`) — unchanged.
- Admin routes (`/admin/stories`, `/admin/quiz`, `/admin/analytics`) — unchanged.
- Pipeline logic (`current-affairs/pipeline/*`) — unchanged.
- Age-group filtering (`toStory(row, ageGroup)`) — unchanged. Both age versions
  (`_kid` for 7-12, `_teen` for 13-15) continue to be served correctly.

### Result
- Admin publishes stories for today → students see today's digest immediately.
- Admin has not published yet → students see a blank digest (not old content).
- Admin review queue (`status = 'review'`) now shows the pipeline-generated stories
  once the pipeline runs successfully (see separate issue: pipeline scheduler).

### Rollback
To restore the old fallback behaviour, change `date = today;` back to
`date = await latestDigestDate(today);` in `current-affairs/routes/digest.js`.
