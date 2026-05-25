# Samta — Handoff Context

> Drop this in front of a new conversation or teammate to get them up to speed
> on the project, the current code, the deploy flow, and the open work.

## What it is
**Samta** is a WhatsApp bot that answers Jain and BAPS Swaminarayan dietary
questions. Users send a text question or a photo of an ingredient label; the
bot replies with a SAFE / NOT SAFE / UNCERTAIN verdict personalized to the
user's community and strictness level. Non-profit; ~$1/month at pilot scale.

## Where the code lives
- **Repo:** https://github.com/shah434/whatsapp-religious-friend
- **Local clone:** `C:\Users\anish\dev\whatsapp-religious-friend` (kept out
  of OneDrive on purpose — OneDrive sync corrupted `.git/` early on)
- **Connected to Cowork** at the path above

## Stack
- **Runtime:** Cloudflare Workers (entry: `worker.js`)
- **AI:** Anthropic Claude Haiku (with prompt caching)
- **Messaging:** WhatsApp Cloud API (Meta)
- **DB:** Supabase Postgres — `users` table holds community, strictness,
  city, message_count, and the last 3 Q/A pairs
- **External APIs:** Google Places (restaurants), YJA Google Calendar
  (Jain tithis), sunrise-sunset.org, Open-Meteo
- **CI:** GitHub Actions on push to `main` → `wrangler deploy`

## Project structure
```
worker.js                 Cloudflare Worker entry — orchestrates everything
wrangler.toml             Cloudflare deploy config
.github/workflows/        Auto-deploy on push to main
src/
  prompts.js              All dietary rules + use case prompts (edit here for content changes)
  database.js             Supabase user CRUD + history
  whatsapp.js             Meta API: sendMessage / sendReaction / sendImage / getImageAsBase64
  claude.js               Anthropic API with prompt caching
  location.js             Google Places restaurant search
  onboarding.js           Onboarding state machine (text-first un-onboarded users)
  utils.js                buildSystemPrompt / buildNeutralSystemPrompt
  calendar.js             Jain tithi calendar
  sunset.js               Sunrise/sunset lookup
test/
  test-prompt.js          Pure prompt iteration loop (no infra)
  test-webhook.js         Fake WhatsApp webhook → local wrangler dev
.dev.vars.example         Template for local secrets (real .dev.vars is gitignored)
```

## What happened in the most recent work session
1. **GitHub → local repo wired up**, moved out of OneDrive, git identity set.
2. **Local dev scaffolding** added: `.gitignore`, `.dev.vars.example`,
   `package.json`, two test scripts.
3. **New pre-onboarding image flow** (commit `15ee0a3`): when an
   un-onboarded user sends an image, the bot scans it and replies with a
   2×3 grid (Jain Strict/Mod/Flex + BAPS Strict/Mod/Flex), then the
   onboarding question is appended to the same WhatsApp message. The
   calendar fetch is skipped here, and the donation nudge is suppressed
   until the user is fully onboarded.
   - New exports in `src/prompts.js`:
     `NEUTRAL_BOTH_COMMUNITIES_INSTRUCTIONS`,
     `STRICTNESS_LEVELS_INSTRUCTIONS`
   - New function in `src/utils.js`: `buildNeutralSystemPrompt(community)`
4. **Strengthened prompt overrides** after Claude refused to answer on a
   banana image (CORE_IDENTITY's "never assume a profile" rule was
   winning). Added an explicit `CRITICAL OVERRIDES` section that nullifies
   the offending rules in the pre-onboarding branch.
5. **Fixed spurious rejection message.** WhatsApp fires extra webhooks for
   reactions, system events, etc. — these were hitting the "I can only
   read text or images" rejection and spamming the user. Now silently
   drop: `reaction`, `system`, `interactive`, `button`, `unsupported`,
   `unknown`. Still verbally reject genuine unsupported media (video,
   audio, document, etc.).
6. **User self-deletion flow** added (commit `4cf65b2`). Users can hard-delete
   their account with a two-step confirmation entirely over WhatsApp:
   - User sends `delete me` → bot replies with Vin Diesel family meme +
     "Are you sure?" prompt. A `pending_delete:<phone>` KV key is set with
     a 10-minute TTL.
   - User replies `YES` → `deleteUser()` removes the Supabase row and clears
     the KV cache entry → bot replies with Vin goodbye meme.
   - User replies anything else → Vin stay meme, deletion cancelled.
   - TTL expiry with no reply = auto-cancelled, no action needed.
   - New `deleteUser(phone, env)` in `src/database.js`.
   - New `sendImage(to, imageUrl, caption, env)` in `src/whatsapp.js`.
   - Meme assets committed to repo: `vin family.png`, `vin goodbye.png`,
     `vin stay.png` (served via raw.githubusercontent.com URLs).
   - Designed for future pivot to anonymization: just update `deleteUser()`
     in one place if/when volume justifies keeping anonymized analytics rows.

## Open / next up
- **Add a strictness-levels legend to the community-pick onboarding nudge.**
  Decided but not implemented. The nudge in `worker.js` (around line
  114-116) should be expanded to explain what Strict / Moderate / Flexible
  mean alongside the community question, because the pre-onboarding
  verdict grid uses those terms without context. One-line edit when ready.

## Local dev workflow

**One-time setup:**
```powershell
cd C:\Users\anish\dev\whatsapp-religious-friend
npm install -g wrangler@4
Copy-Item .dev.vars.example .dev.vars
# fill .dev.vars with the secrets from Cloudflare Worker dashboard
```

**Fast prompt iteration (no infra, ~2 sec per cycle):**
```powershell
npm run test:prompt "Can I eat paneer?"
```
Edit the fake `user` object inside `test/test-prompt.js` to try different
community/strictness combos.

**Full local worker simulation (uses prod Supabase + sends real WhatsApp
messages to whatever phone number you pass — use your own number!):**
```powershell
# terminal 1 — loads .dev.vars automatically
npm run dev
# terminal 2
npm run test:webhook "YOUR_PHONE_NUMBER" "Can I eat paneer?"
```

**Feature-branch + deploy:**
```powershell
git checkout -b my-change
# ...edit, test locally...
git commit -am "what changed"
git push -u origin my-change
# happy? merge to main → GitHub Actions deploys in ~30s
git checkout main && git merge my-change && git push
```

**Roll back if a deploy breaks something:**
```powershell
git revert HEAD && git push
```

## Known gotchas — read before touching git or files
- **Cowork sandbox can't reach github.com.** `git push` and `git fetch`
  must be run from PowerShell. Commits CAN be made from the sandbox
  (commit objects are local).
- **Sandbox can't delete `.git/*.lock` files** on the Windows mount.
  If a commit fails with "Unable to create '.git/HEAD.lock': File exists",
  run in PowerShell:
  `Remove-Item -Force .git\HEAD.lock, .git\index.lock`
- **File-tool writes occasionally truncate** at the host-mount boundary —
  Edit/Write report success but the on-disk file is short. Workaround:
  write via `bash` (`cat > file << EOF`) and verify with `node --check`.
- **Line endings:** repo is LF, working tree is CRLF on Windows. Harmless
  `LF will be replaced by CRLF` warnings on `git add`. To silence,
  commit a `.gitattributes` with `* text=auto eol=lf`.
- **Cowork "Projects"** don't share folder context across conversations
  yet. Folders are bound to the chat. Workarounds: stay in one chat, or
  re-mount the folder when starting a new chat in the project.

## Where dietary logic lives
All rules and use cases live in **`src/prompts.js`** — community-specific
rules, E-number tiers, Paryushana overrides, restaurant guidance, all of
it. No infrastructure knowledge needed to tune Claude's behavior here.

## KV key patterns
```
user:<phone>              Cached Supabase user object (24h TTL)
jain_calendar_events      Pre-warmed Jain tithi calendar (24h TTL, cron-refreshed)
pending_delete:<phone>    Set when user types "delete me"; cleared on YES/cancel (10min TTL)
```

## Database schema (Supabase `users` table)
```
phone_number       text     WhatsApp phone number (PK)
community          text     jain | baps
strictness         text     strict | moderate | flexible
language           text     en | gu | hi | other
observance         text     none | ekadashi | paryushana | fasting
city               text     stored for sunset/restaurant queries
message_count      integer  total messages — triggers donation nudge at every 30
history_1_q / _a   text     most recent question / answer
history_2_q / _a   text     second most recent
history_3_q / _a   text     third most recent
```
