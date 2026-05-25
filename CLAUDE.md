# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                        # run all vitest tests (pure-logic only)
npx vitest run tests/foo.test.js  # run a single test file
npx wrangler deploy             # deploy to Cloudflare Workers
npx wrangler tail               # stream live logs from production
```

There is no local dev server — the worker runs exclusively on Cloudflare. Live behaviour is tested by deploying and messaging the WhatsApp number directly.

## Architecture

**Cloudflare Worker** (`worker.js`) is the single entry point. It handles WhatsApp webhook POSTs from Meta, orchestrates all I/O, and returns `200 OK`. A scheduled cron (midnight UTC) pre-warms the Jain calendar cache in KV.

**Storage: two-layer write-through.**
- Supabase is the source of truth (one row per user in `users`).
- KV is a speed cache (~5 ms hit vs ~200 ms Supabase). `getUser` reads KV first; on miss it fetches Supabase and writes KV. `updateUser` always writes Supabase then merges into KV. A city write MUST go through `updateUser`, never KV-only.

**Classify → dispatch (v3.1 design).**
`classify.js` is the only place raw message text is read for routing. It returns one structured intent:
```js
{ journey, params: { city_raw?, food_text?, fast_term?, sun_kind?, has_image? }, prompt_blocks: [] }
```
`worker.js` never re-reads `text` to decide what to do — only the intent object.

**Journey list** (must stay in sync between `classify.js` and `ALLOWED_JOURNEYS` in `pending.js`):
`food | tithi | sunset | restaurant | pachkhan | greeting | account | offtopic`

**Ambiguous fallback:** if `classify()` defaults to `food` with no real food signal, `worker.js` calls `routeFallback()` (Haiku, JSON-only prompt) to re-route to `sunset` or `restaurant`.

**City-needing journeys (sunset + restaurant)** share a single resolve/pending/resume core in `rebuild-city-journey.js`. Each journey supplies only its `askCityPrompt` string and `answer()` function. The shared core:
1. On a fresh request with `city_raw` → geocode → save → answer (or offer picker if ambiguous).
2. On no city → store `pending_action = {need:'city', intent}` and ask.
3. On a bare reply ("1", "London") while pending → resume that stored intent.

**Pending state** is ONE validated JSON record in `users.pending_action`. The shape is:
```js
{ need: 'city' | 'city_pick' | 'strictness' | 'fast_pick', intent, choices? }
```
`readPending()` validates on every read and returns `null` on any corruption — always treat null as "start fresh". `serializePending()` refuses to write a record with an unknown `need` or journey.

**Claims pattern** (`cityJourneyClaims`): a fresh city-journey intent always wins over any pending record. A bare reply ("1" / short city name) is claimed by whichever journey is currently pending. A real food/question message abandons any stale pending.

**System prompt caching.** `buildSystemPrompt()` returns a two-block array. The first block (CORE_IDENTITY + community rules + USE_CASE blocks) is marked `cache_control: ephemeral, ttl: 1h` — this is the Anthropic prompt cache hit. The second block (user profile, history, calendar, sun data) is dynamic and never cached. Keep static content first, dynamic content second, or the cache breaks.

**Legacy city flags** (`pending_tithi_city_ask`, `pending_city_choices`) still exist in `worker.js` and collide with the `pending_action` system. The active refactor task is to route city statements through `city_update` journey (using the shared core) and then delete those legacy blocks. Do not add new code that touches those flags.

## Key Conventions

- `prompt_blocks: []` on an intent means "no Claude call needed" (e.g. a `city_update` confirm).
- `resolveLocation()` (Open-Meteo geocoder) returns `resolved | ambiguous | missing | error`. `missing` = re-ask for city; `error` = geocoder down, ask to retry. Never conflate them.
- Tests cover only pure-logic functions (`cityJourneyClaims`, `readPending`/`serializePending`). Network-dependent handlers (`handleCityJourney`, Claude calls, WhatsApp sends) are tested live.
- `setFlagKV` writes KV only (no Supabase). Use only for transient UI flags like `pending_strictness_ask`. Anything that must survive a KV eviction must use `updateUser`.
