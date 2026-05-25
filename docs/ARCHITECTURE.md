# Architecture

WhatsApp bot answering Jain/BAPS dietary and tithi questions. A user messages
the bot on WhatsApp; the worker classifies the message, routes it to a journey,
and replies — usually via Claude, sometimes from deterministic code.

> Accuracy note: the request flow, system-prompt assembly, caching, and
> strictness logic below are documented from the code (`worker.js`, `utils.js`,
> `claude.js`, `prompts.js`). The journey/helper modules
> (`classify.js`, `pending.js`, `rebuild-*.js`, `fasting-rules.js`,
> `database.js`, `calendar.js`, `sunset.js`, `route-fallback.js`,
> `onboarding.js`, `whatsapp.js`) are documented at the interface level — how
> they're called and what they return — not their internals. Update those
> sections as the modules are read/verified.

---

## Stack

- **Cloudflare Workers** — the whole app is one `fetch` handler. Worker name
  `greenbite`. CPU-time limited, no wall-clock limit issue at current scale.
- **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) — the answer engine.
- **WhatsApp Cloud API** — message in/out.
- **Supabase** — durable user records (profile, history, pending state).
- **KV** (namespace `CACHE`) — fast ephemeral state: rate limits, spend
  tracking, pending-delete tokens, throttle switch, and a KV mirror of the user
  row (`getUser` reads KV first).

Deploy: edit in GitHub web editor → push to `main` → GitHub Actions
auto-deploys (~30s). Test against the live bot on WhatsApp.

---

## Request lifecycle

Everything happens in `export default { fetch }` in `worker.js`. High-level
order:

1. **Verb handling.** `GET` is the WhatsApp webhook verification handshake.
   Only `POST` carries messages.
2. **Envelope unwrap.** Pull the message out of the webhook body. Drop status
   callbacks and non-message events early. Drop reactions/system/interactive
   types silently. Reject non-text/non-image types with a short note.
3. **Identity.** Read `phone`, hash it once into `const u` (SHA-256, first 8
   hex chars) for use in all log lines — raw phone is never logged.
4. **Scale brakes** (in order): manual throttle switch (`mode:throttled` KV
   key), per-user daily rate limit (50/day, KV), global daily spend ceiling
   ($10 soft / $12 hard, image scans cut off first).
5. **Parallel I/O.** `sendReaction`, `getUser`, `getCalendarCached` run
   together via `Promise.all`. Image download (if any) is kicked off as a
   separate promise and awaited later.
6. **New-user creation + welcome** if no record exists.
7. **Keyword commands** (text only, each returns early):
   `delete me` → confirm flow, `help` → welcome, bare greeting → welcome,
   pending-delete `YES`/other.
8. **Journey routing** (see below) — the core dispatch.
9. **Fallthrough = food/general.** Anything not claimed by a journey builds a
   system prompt, calls Claude, post-processes, and replies.
10. **Deferred write.** History + message count written to Supabase via
    `ctx.waitUntil` after the response is sent, so it doesn't add latency.

---

## Routing model: classify → intent → journey

The rebuild moved dispatch onto a clean path:

```
classify(text) → intent { journey, params, prompt_blocks } → journey handler
```

`classify(text, isImage)` (in `classify.js`) turns a raw message into a
structured intent. Nothing downstream re-reads the raw text to decide routing —
the intent is the contract.

Journeys **claim early and return.** In `worker.js`, after the keyword commands,
each migrated journey gets a chance to handle the message and short-circuit:

- `rebuildSunsetClaims(user, intent, text)` → `handleRebuildSunset(...)`
- `rebuildRestaurantClaims(user, intent, text)` → `handleRebuildRestaurant(...)`
- code-driven fasting (see below)

If a journey claims the message, it sends its own reply and returns `OK`. If no
journey claims it, execution falls through to the food/general path at the
bottom. **Food is the fallthrough** — it's "everything not otherwise claimed,"
which is why it's still on the original pre-rebuild code path rather than its
own handler.

### Why journeys claim early
Sunset, restaurant, and fasting are narrow and self-contained — they can decide
"this is mine" from the intent alone and produce a complete answer without the
full food-prompt machinery. Claiming early keeps them fast and keeps the food
path from having to know about them.

### Fallback router
When `classify` defaults to `food` but the message has no real food signal
(no `food_text`, no image), it's treated as ambiguous. `routeFallback(text)`
asks Haiku for a journey + city, and if it comes back `sunset`/`restaurant`,
the message is re-routed through the same journey handlers (so pending/resume
state stays intact).

---

## State model

Two layers, by durability:

- **Supabase** — the user row: `community`, `strictness`, `city`, `timezone`,
  `latitude`/`longitude`, `language`, `observance`, conversation history
  (`history_1_q/a` … `history_3_q/a`), `message_count`, and pending-state
  columns.
- **KV** — ephemeral and fast: rate-limit counters (`ratelimit:<phone>:<date>`),
  spend (`spend:<date>`), pending-delete tokens
  (`pending_delete:<phone>`, 10-min TTL), throttle switch, and a mirror of the
  user row keyed `user:<phone>`. **`getUser` reads KV first**, so to clean-test
  a user you must clear BOTH the Supabase row AND the KV key.

### Pending actions
The rebuild introduced a single validated `pending_action` column (via
`pending.js`, `readPending`/`serializePending`) to replace scattered boolean
flags. `ALLOWED_NEEDS`: `city`, `strictness`, `city_pick`, `fast_pick`.

Legacy flags still in use and **not yet retired**:
`pending_strictness_ask`, `pending_tithi_city_ask`, `pending_city_choices`.
They remain load-bearing until the food and tithi-city flows migrate onto
`pending_action`. They are not dead code.

---

## System prompt assembly

`buildSystemPrompt(user, googleResults, calendarData, sunData, queryTypes)` in
`utils.js` returns a two-block system array, split by what's cacheable:

**Block 1 — static (cache-marked).**
`CORE_IDENTITY + rules + useCases`, where `rules` is `RULES_JAIN` or
`RULES_BAPS` by community, and `useCases` are the relevant `USE_CASE_*` blocks
selected by `classifyQuery`. Carries
`cache_control: { type: 'ephemeral', ttl: '1h' }`.

**Block 2 — dynamic (not cached).**
User profile (community, strictness, city, today's date in the user's
timezone), truncated conversation history, restaurant results, calendar data,
sun data. All per-message/per-user content lives here so it can't poison the
cached prefix.

`classifyQuery(text, hasImage)` (in `utils.js`) returns an array of use-case
keys (`general`, `label_scan`, `restaurant`, `substitution`, `medicine`,
`fasting`, `calendar`) so only the relevant prompt blocks are shipped. `general`
is the always-on fallback.

### Prompt blocks (`prompts.js`)
- `CORE_IDENTITY` — bot identity, response rules, strictness handling,
  profile/city/deletion/topic handling.
- `RULES_JAIN` / `RULES_BAPS` — the dietary verdict tables per community.
- `USE_CASE_*` — formatting/behavior for each query type.

---

## Strictness logic (three-level)

When `user.strictness` is unset and the question is strictness-sensitive, the
model computes a verdict at all three levels and shows only the *distinct*
outcomes:

- Per food → verdict at strict / moderate / flexible (from `RULES_JAIN`).
- Per level → dish verdict is the **worst** single food at that level
  (NOT SAFE > UNCERTAIN/flag > SAFE).
- Group levels sharing a verdict: all-3-same → one unified line (no labels);
  2 distinct → 2 lines; 3 distinct → 3 lines. Every shown line is labeled
  `If [level]:`.
- Offenders: up to 3 per line, worst-first (always-banned before strict-only).
  More than 3 → "several non-Jain ingredients like X, Y, Z".
- Hard override: if an always-banned food (meat, fish, egg, honey, gelatin,
  alcohol) is present, the dish is NOT SAFE at every level — one unified line,
  cite only that food, no level labels, no strictness question.

The strictness logic lives in `CORE_IDENTITY`; the verdict tables it relies on
are in `RULES_JAIN`. Currently Jain-only.

### The strictness-ask gate (`worker.js`)
After the model replies, the worker counts how many distinct levels the reply
showed:

```js
const levelsShown = [/\bif strict\b/i, /\bif moderate\b/i, /\bif flexible\b/i]
  .filter(re => re.test(cleanResponse)).length;
const hasDualVerdict = levelsShown > 1;
```

The strictness question is appended only when `>1` level is shown, the query
is strictness-sensitive, it's not fasting, not a greeting, and
`!user.strictness`. A user who has set strictness gets one clean verdict and is
never asked.

---

## Claude call (`claude.js`)

`callClaude(messages, system, env, maxTokens = 250)` posts to the Anthropic
Messages API. Notes:

- `max_tokens` defaults to 250 (tight, for ~3-line verdicts). Journeys that
  need longer answers (restaurant lists) pass a higher value.
- **No `anthropic-beta` header** — prompt caching is GA and driven by
  `cache_control` alone.
- Cost tracking: reads `usage`, accumulates approximate daily spend into
  `spend:<date>` KV, pricing input at $1/M, **cache writes at 1.25×, cache
  reads at 0.10×**, output at $5/M. Logs a `[cost]` line with
  `in / cache_w / cache_r / out` token counts.
- On any error, returns a friendly fallback string rather than throwing.

### Prompt caching status
Caching is implemented but cost-effectiveness is unconfirmed. **Haiku 4.5's
minimum cacheable prefix is 4,096 tokens** — below that, the API silently skips
caching (no error, full price). The static block (`CORE_IDENTITY + rules +
useCases`) must clear 4,096 for caching to engage. If it doesn't, the lever
becomes shrinking the prompt rather than caching it. Verify via the `[cost]`
log (`cache_w` > 0 on a fresh call means the cache is writing).

---

## Cost shape

Per message, input tokens dominate (~4,200 input vs 20–80 output). At Haiku
rates ($1/M in, $5/M out), ~94% of per-message cost is the input prompt.
Optimization effort belongs on the input prompt (caching or shrinking), not the
output.

---

## Telemetry / logging

- `[perf]` — timing checkpoints through the handler.
- `[turn]` — one structured decision line per food-path message
  (`journey, types, ask_strictness, tithi, img`). Logs decisions, not message
  content.
- `[cost]` — token + cache breakdown per Claude call.
- `[guard]`, `[empty_response]`, `[unmatched-short]` — diagnostic events.

All user references in logs use the hashed `u`, never the raw phone.
Content-logging policy: do not log raw message text.

---

## External integrations (interface level)

- `whatsapp.js` — `sendMessage`, `sendReaction`, `sendImage`,
  `getImageAsBase64`.
- `database.js` — `getUser`, `createUser`, `updateUser`, `deleteUser`,
  `setFlagKV`.
- `calendar.js` — `getCalendarCached`, `getTodayAndUpcomingEvents`,
  `formatEventsForClaude`. A scheduled handler pre-warms the calendar cache
  daily into KV (`jain_calendar_events`, 24h TTL).
- `sunset.js` — `geocodeCity`, `getSunForPlace`, `getSunriseSunset`,
  `placeFromUser`, `formatSunDataForClaude`, `detectSunsetQuery`,
  `extractCityFromSunQuery`.
- `fasting-rules.js` — `rulesFor`, `rulesForNumber`, `FAST_MENU`
  (deterministic, code-driven fasting menu + rules).

---

## Conventions

- Replies lead with a verdict (✅ SAFE / ✋ NOT SAFE / ⚠️ UNCERTAIN), max ~3
  lines, warm first-person tone.
- The bot is not a religious authority — defers edge cases to community elders.
- Calendar/tithi is Jain-only and gated on a live calendar feed; the model is
  forbidden from naming the tithi (the system prepends that line separately).
- New behavior ships one change at a time: push → clean-test live → next.
