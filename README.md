# Samta — WhatsApp Dietary Guidance Bot

A WhatsApp bot that helps Jain and BAPS Swaminarayan communities 
determine if food is safe to eat based on their dietary profile.
Built as a non-profit service for South Asian religious communities.

---

## What Samta Does

- **Dietary guidance** — checks if food, dishes, or ingredients are safe
- **Food label scanning** — reads ingredient lists from photos and flags concerns
- **Cosmetic and skincare scanning** — checks personal care product ingredients
- **Restaurant finder** — finds Jain and BAPS friendly restaurants nearby via Google Places
- **Fasting guidance** — helps users navigate Jain tithi fasts and BAPS Ekadashi observances
- **Jain tithi calendar** — pulls live data from the YJA Jain calendar
- **Sunrise and sunset** — gives exact times for any city worldwide
- **Ingredient substitution** — suggests community-compliant alternatives with exact ratios
- **Medicine and supplement checking** — flags gelatin capsules, suggests vegetarian alternatives
- **Multi-language** — responds in the language the user writes in including Gujarati and Hindi
- **City memory** — remembers your city for sunset and restaurant queries

---

## Communities Supported

| Community | Strictness Levels |
|-----------|------------------|
| Jain | Strict, Moderate, Flexible |
| BAPS Swaminarayan | Strict, Moderate, Flexible |

---

## Stack

| Service | Purpose | Cost |
|---------|---------|------|
| WhatsApp Meta Cloud API | Messaging | Free |
| Cloudflare Workers | Bot infrastructure | Free |
| Supabase (PostgreSQL) | User database | Free |
| Anthropic Claude Haiku | AI responses | ~$0.31/month |
| Google Places API | Restaurant finder | Free tier |
| Open-Meteo | Sunrise/sunset geocoding | Free |
| sunrise-sunset.org | Sun times | Free |
| YJA Google Calendar | Jain tithi calendar | Free |

**Total cost at pilot scale (50 msg/day): ~$0.31/month**

---

## Project Structure

```
worker.js                 — Main Cloudflare Worker handler
wrangler.toml             — Cloudflare deployment config
.github/workflows/        — GitHub Actions auto-deploy
src/
  prompts.js              — All dietary rules and use case prompts
  database.js             — Supabase user management
  whatsapp.js             — Meta WhatsApp API functions
  claude.js               — Anthropic Claude API with prompt caching
  location.js             — Google Places restaurant search
  onboarding.js           — User onboarding flow
  utils.js                — System prompt builder
  calendar.js             — Jain tithi calendar integration
  sunset.js               — Sunrise/sunset lookup
```

---

## File Ownership

| File | Owner | Notes |
|------|-------|-------|
| worker.js | Core team | Main handler — touch carefully |
| src/prompts.js | Content team | Edit dietary rules and use cases here |
| src/database.js | Core team | Supabase functions |
| src/whatsapp.js | Core team | Meta API functions |
| src/claude.js | Core team | Anthropic API with caching |
| src/location.js | Core team | Google Places integration |
| src/onboarding.js | Either | User onboarding flow |
| src/utils.js | Core team | System prompt builder |
| src/calendar.js | Either | Jain calendar integration |
| src/sunset.js | Either | Sunrise/sunset integration |

---

## Database Schema

Supabase `users` table:

```sql
phone_number       text    -- WhatsApp phone number
community          text    -- jain | baps
strictness         text    -- strict | moderate | flexible
language           text    -- en | gu | hi | other
observance         text    -- none | ekadashi | paryushana | fasting
city               text    -- stored city for sunset/restaurant queries
message_count      integer -- total messages sent (for donation nudge)
history_1_q        text    -- most recent question
history_1_a        text    -- most recent answer
history_2_q        text    -- second most recent question
history_2_a        text    -- second most recent answer
history_3_q        text    -- third most recent question
history_3_a        text    -- third most recent answer
```

---

## Key Features

### Prompt Caching
Static content (dietary rules, use cases) is cached by Anthropic.
Saves ~70% on Claude API costs for repeat users.

### Conversation Threading
Last 3 exchanges stored in Supabase and passed to Claude.
Enables natural follow-up questions without repeating context.

### Donation Nudge
Every 30 messages Samta sends a gentle donation request.
Update `DONATION_LINK_PLACEHOLDER` in worker.js with your real link.

### City Memory
When a user provides a city for sunset or restaurant queries it is
stored in Supabase and reused automatically. Users can update anytime
by mentioning a new city.

---

## Updating Dietary Rules

All dietary rules and use cases live in `src/prompts.js`.
No infrastructure knowledge needed to update prompts.

```
1. Edit src/prompts.js in GitHub
2. Commit with a clear message
3. GitHub Actions deploys in 30 seconds
4. Test on WhatsApp
```

---

## Non-Profit

Samta is built as a non-profit service for South Asian religious 
communities. Distribution is via existing Jain and BAPS WhatsApp 
community groups. All infrastructure costs are under $1/month at 
pilot scale.
