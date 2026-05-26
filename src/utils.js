// ============================================
// utils.js — Utility and helper functions v2.3
// ============================================
// Changes in v2.3:
//   - All USE_CASE blocks always included in static (cached) layer.
//     Two cache buckets total: one for Jain, one for BAPS.
//     Cache hits shared across all users of the same community.
//   - classifyQuery removed (dead code — classify.js + prompt_blocks replaced it)
//   - queryTypes parameter removed from buildSystemPrompt
// ============================================

import {
  CORE_IDENTITY,
  RULES_JAIN,
  RULES_BAPS,
  USE_CASE_GENERAL,
  USE_CASE_LABEL_SCAN,
  USE_CASE_RESTAURANT,
  USE_CASE_SUBSTITUTION,
  USE_CASE_MEDICINE,
  USE_CASE_FASTING,
  USE_CASE_CALENDAR,
} from './prompts.js';

// All use cases joined once — this is the constant static block per community.
const ALL_USE_CASES =
  USE_CASE_GENERAL +
  USE_CASE_LABEL_SCAN +
  USE_CASE_RESTAURANT +
  USE_CASE_SUBSTITUTION +
  USE_CASE_MEDICINE +
  USE_CASE_FASTING +
  USE_CASE_CALENDAR;

export function stripTags(text) {
  return (text || '').trim();
}

export function buildSystemPrompt(user, googleResults, calendarData, sunData, searchSnippets = null) {
  const rules = user.community === 'baps' ? RULES_BAPS : RULES_JAIN;

  // STATIC content — cached by Anthropic.
  // Always identical for the same community → reliable cache hits.
  const staticContent = CORE_IDENTITY + rules + ALL_USE_CASES;

  // DYNAMIC content — changes per message, never cached.
  const userTz = user.timezone || 'America/New_York';
  const today = new Date().toLocaleDateString('en-US', {
    timeZone: userTz,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });

  const profile = `
CURRENT USER PROFILE:
Community: ${user.community || 'jain'}
Strictness: ${user.strictness || 'not set'}
Language: ${user.language || 'en'}
Observance: ${user.observance || 'none'}
City: ${user.city || 'not set'}
Today's date: ${today}`;

  // History — skip entirely for first-turn users.
  const truncQ = (s) => s && s.length > 80  ? s.slice(0, 80)  + '…' : (s || '');
  const truncA = (s) => s && s.length > 120 ? s.slice(0, 120) + '…' : (s || '');
  const history = user.history_1_q ? `
CONVERSATION HISTORY (most recent last):
Q1: ${truncQ(user.history_3_q)} A1: ${truncA(user.history_3_a)}
Q2: ${truncQ(user.history_2_q)} A2: ${truncA(user.history_2_a)}
Q3: ${truncQ(user.history_1_q)} A3: ${truncA(user.history_1_a)}` : '';

  const restaurantData = googleResults && googleResults.length > 0
    ? `\nNEARBY RESTAURANT RESULTS: ${JSON.stringify(googleResults)}
FORMATTING RULE: For each restaurant include name, address,
phone number (nationalPhoneNumber field — always include if present in data),
rating, and whether currently open.
Ask staff: "Do you avoid onion and garlic in any form including powder?"
End with: "Call ahead to confirm dietary requirements"`
    : '';

  const calendar = calendarData
    ? `\nJAIN CALENDAR — NEXT 30 DAYS:\n${calendarData}
TITHI RULE: Never state the tithi name or that today is/isn't a tithi — that line is added separately. If today is a tithi, give ONLY a 2-line explanation of its dietary practice. Do not name it. Do NOT open with any greeting (no "Jai Jinendra", "🙏", etc.) — a greeting is already added separately.`
    : '';

  const sun    = sunData       ? `\n${sunData}`       : '';
  const search = searchSnippets ? `\n${searchSnippets}` : '';

  const dynamicContent = profile + history + restaurantData + calendar + sun + search;

  return [
    {
      type: 'text',
      text: staticContent,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
    {
      type: 'text',
      text: dynamicContent,
    },
  ];
}
