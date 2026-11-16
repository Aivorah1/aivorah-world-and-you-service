# CHANGELOG — Current Affairs Module

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
