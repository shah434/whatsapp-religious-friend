# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                           # run all vitest tests (pure-logic only)
npx vitest run tests/foo.test.js   # run a single test file
npx wrangler deploy                # deploy to Cloudflare Workers
npx wrangler tail                  # stream live logs from production
```

There is no local dev server — the worker runs exclusively on Cloudflare. Live behaviour is tested by deploying and messaging the WhatsApp number directly.

## Architecture

See `ARCHITECTURE.md` for the full picture. Key points for day-to-day work:

**Entry point:** `worker.js` handles WhatsApp webhook POSTs. It does dispatch only — no business logic lives here. A scheduled cron (midnight UTC) pre-warms the Jain calendar in KV.

**Classify → dispatch.** `classify.js` is the only place raw text is read for routing. It returns one structured intent:
```js
{ journey, params: { city_raw?, food_text?, fast_term?, sun_kind?, sun_date?, has_image? }, prompt_blocks: [] }
```
`worker.js` never re-reads `text` to decide routing — only the intent object.

**Journey list** (must stay in sync between `classify.js` and `ALLOWED_JOURNEYS` in `pending.js`):
`food | tithi | sunset | restaurant | city_update | profile_update | pachkhan | greeting | offtopic`

**City-needing journeys** (sunset, restaurant, tithi, city_update) all share one resolve/pending/resume core in `rebuild-city-journey.js`. To add a new city journey, supply only an `askCityPrompt` string and an `answer(phone, user, place, intent, env)` function — the shared core handles geocoding, picker, pending, and resume.

**Pending state** is ONE validated JSON column (`users.pending_action`). Shape:
```js
{ need: 'city' | 'city_pick' | 'strictness' | 'fast_pick', intent, choices? }
```
`readPending()` returns `null` on any corruption — always treat null as "start fresh". `serializePending()` refuses unknown `need` values or journeys. Never write `pending_action` directly to KV — always use `updateUser`.

**Prompt cache.** `buildSystemPrompt(user, calendarData, sunData, searchSnippets)` returns a two-block array. Block 1 (CORE_IDENTITY + community rules + ALL use cases) is `cache_control: ephemeral, ttl: 1h` — shared across all users of the same community. Block 2 (profile, history, calendar, search data) is dynamic and never cached. Static content must stay first or the cache breaks.

**Storage write order.** `updateUser` always writes Supabase then merges into KV. Never write user data KV-only — it won't survive eviction.

## Key Conventions

- All dietary rules and prompt text live in `src/prompts.js`. Edit there; nowhere else.
- `resolveLocation()` returns `resolved | ambiguous | missing | error`. `missing` = re-ask; `error` = geocoder down. Never conflate them.
- `routeFallback()` (Haiku, JSON-only) is called only when classify defaults to `food` with no food signal AND text is ≥ 3 chars. It re-routes to `sunset` or `restaurant` only.
- Fasting is code-driven (`fasting-rules.js`) for named fasts 1–7. Claude is only invoked for option 8 (complex fasts). The fasting menu is sent verbatim — never paraphrase it.
- Tests cover pure-logic only: `classify`, `readPending`/`serializePending`, `cityJourneyClaims`, `detectFastTerm`, `stripTags`. Network-dependent code is tested live.
- `sun_date: 'tomorrow'` in intent params causes `getSunForPlace(place, 'tomorrow')` to fetch the next day's times. The sunrise-sunset.org API accepts a `date` param.
- Spend tracking in `claude.js` is best-effort (KV has no atomic increment). Thresholds are set conservatively; the Anthropic billing alert is the real backstop.
