// ============================================
// utils.js — Utility and helper functions v2.2
// ============================================
// Changes in v2.2:
//   - Per-user timezone for "Today's date" line
//   - History truncation tightened (Q=80 chars, A=120 chars)
//   - History block skipped entirely for first-turn users
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
import { detectFastTerm } from './fasting-match.js';

const USE_CASE_BLOCKS = {
  general: USE_CASE_GENERAL,
  label_scan: USE_CASE_LABEL_SCAN,
  restaurant: USE_CASE_RESTAURANT,
  substitution: USE_CASE_SUBSTITUTION,
  medicine: USE_CASE_MEDICINE,
  fasting: USE_CASE_FASTING,
  calendar: USE_CASE_CALENDAR,
};

// Classify an incoming query so we send only the relevant USE_CASE block.
// Returns an array of use case keys (most queries return one, but some need two,
// e.g. fasting + substitution if a user asks "what can I substitute for ghee
// during my fast"). General is always included as a fallback.
export function classifyQuery(text, hasImage) {
  const lower = (text || '').toLowerCase();
  const types = new Set();

  if (hasImage) types.add('label_scan');
  if (/\b(restaurant|restaurants|eat near|food near|where to eat|where can i eat|find jain|find baps)\b/.test(lower)) types.add('restaurant');
  if (/\b(substitute|substitution|alternative|alternatives|instead of|replace|swap)\b/.test(lower)) types.add('substitution');
  if (/\b(medicine|medication|supplement|capsule|tablet|drug|pill|pharma|prescription|vitamin)\b/.test(lower)) types.add('medicine');

  // Fasting detection — two layers:
  //   1. Literal regex for common English keywords and well-spelled fast names
  //   2. Fuzzy match for transliteration variants (pachkhan / paccakkhana,
  //      ayambhil, navakarsi, porsee, etc.) that the regex would miss
  const englishFastHit = /\b(fast|fasting|paryushana|paryushan|ekadashi|nirjala|jalahar|farari|nom|punam|chaturmas|sadh.porsi|navapad|oli|varshitap|vardhaman|visasthanak)\b/.test(lower);
  const fuzzyFastHit = detectFastTerm(text).matched;
  if (englishFastHit || fuzzyFastHit) types.add('fasting');

  if (/\b(tithi|sunset|sunrise|calendar|today.*(safe|special|fast|tithi)|what.*day)\b/.test(lower)) types.add('calendar');

  if (types.size === 0) types.add('general');

  return Array.from(types);
}

export function parseProfileUpdate(text) {
  const strictnessMatch = text.match(/\[STRICTNESS_UPDATE:\s*(strict|moderate|flexible)\]/i);
  const communityMatch = text.match(/\[COMMUNITY_UPDATE:\s*(jain|baps)\]/i);
  const cityMatch = text.match(/\[CITY_UPDATE:\s*([^\]]+)\]/i);
  return {
    strictness: strictnessMatch ? strictnessMatch[1] : null,
    community: communityMatch ? communityMatch[1] : null,
    city: cityMatch ? cityMatch[1].trim() : null
  };
}

export function stripTags(text) {
  return text
    .replace(/\[STRICTNESS_UPDATE:.*?\]/gi, '')
    .replace(/\[COMMUNITY_UPDATE:.*?\]/gi, '')
    .replace(/\[CITY_UPDATE:.*?\]/gi, '')
    .trim();
}

export function buildSystemPrompt(user, googleResults, calendarData, sunData, queryTypes, searchSnippets = null) {
  const rules = user.community === 'baps' ? RULES_BAPS : RULES_JAIN;

  // Date computed in the user's timezone (falls back to ET, YJA's publication tz)
  const userTz = user.timezone || 'America/New_York';
  const today = new Date().toLocaleDateString('en-US', {
    timeZone: userTz,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });

  const sun = sunData ? `\n${sunData}` : '';

  // Assemble only the relevant use case blocks
  const types = (Array.isArray(queryTypes) && queryTypes.length > 0) ? queryTypes : ['general'];
  const useCases = types.map(t => USE_CASE_BLOCKS[t] || '').join('\n');

  // STATIC content — cached by Anthropic
  const staticContent = CORE_IDENTITY + rules + useCases;

  // DYNAMIC content — changes per message, not cached
  // Profile block
  const profile = `
CURRENT USER PROFILE:
Community: ${user.community || 'jain'}
Strictness: ${user.strictness || 'not set'}
Language: ${user.language || 'en'}
Observance: ${user.observance || 'none'}
City: ${user.city || 'not set'}
Today's date: ${today}`;

  // History block — skip entirely for first-turn users.
  // Q's stay short (~80 chars); A's may be longer but verdict is in first 120.
  const truncQ = (s) => s && s.length > 80 ? s.slice(0, 80) + '…' : (s || '');
  const truncA = (s) => s && s.length > 120 ? s.slice(0, 120) + '…' : (s || '');

  const history = user.history_1_q ? `
CONVERSATION HISTORY (most recent last):
Q1: ${truncQ(user.history_3_q)} A1: ${truncA(user.history_3_a)}
Q2: ${truncQ(user.history_2_q)} A2: ${truncA(user.history_2_a)}
Q3: ${truncQ(user.history_1_q)} A3: ${truncA(user.history_1_a)}` : '';

  // Restaurant block
  const restaurantData = googleResults && googleResults.length > 0
    ? `\nNEARBY RESTAURANT RESULTS: ${JSON.stringify(googleResults)}
FORMATTING RULE: For each restaurant include name, address,
phone number (nationalPhoneNumber field — always include if present in data),
rating, and whether currently open.
Ask staff: "Do you avoid onion and garlic in any form including powder?"
End with: "Call ahead to confirm dietary requirements"`
    : '';

  // Calendar block
 const calendar = calendarData
    ? `\nJAIN CALENDAR — NEXT 30 DAYS:\n${calendarData}
TITHI RULE: Never state the tithi name or that today is/isn't a tithi — that line is added separately. If today is a tithi, give ONLY a 2-line explanation of its dietary practice. Do not name it. Do NOT open with any greeting (no "Jai Jinendra", "🙏", etc.) — a greeting is already added separately.`
    : '';

  const searchData = searchSnippets ? `\n${searchSnippets}` : '';

const dynamicContent = profile + history + restaurantData + calendar + sun + searchData;
  return [
    {
      type: 'text',
      text: staticContent,
cache_control: { type: 'ephemeral', ttl: '1h' }    },
    {
      type: 'text',
      text: dynamicContent
    }
  ];
}
