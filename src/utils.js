// ============================================
// utils.js — Utility and helper functions v2
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
  if (/\b(fast|fasting|upvas|ekasana|ayambil|biyasana|chauvihar|tivihar|duvihar|navkarsi|paryushana|ekadashi|nirjala|jalahar|farari|nom|punam|chaturmas)\b/.test(lower)) types.add('fasting');
  if (/\b(tithi|sunset|sunrise|calendar|today.*(safe|special|fast|tithi)|what.*day)\b/.test(lower)) types.add('calendar');

  // If nothing matched, default to general dietary
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

export function buildSystemPrompt(user, googleResults, calendarData, sunData, queryTypes) {
  const rules = user.community === 'baps' ? RULES_BAPS : RULES_JAIN;
  const today = new Date().toDateString();
  const sun = sunData ? `\n${sunData}` : '';

  // Assemble only the relevant use case blocks. queryTypes is an array;
  // fall back to general if missing or empty.
  const types = (Array.isArray(queryTypes) && queryTypes.length > 0) ? queryTypes : ['general'];
  const useCases = types.map(t => USE_CASE_BLOCKS[t] || '').join('\n');

  // STATIC — cached by Anthropic (same for all users of same community + query type)
  const staticContent = CORE_IDENTITY + rules + useCases;

  // DYNAMIC — changes every message, not cached
  const profile = `
  CURRENT USER PROFILE:
  Community: ${user.community || 'jain'}
  Strictness: ${user.strictness || 'not set'}
  Language: ${user.language || 'en'}
  Observance: ${user.observance || 'none'}
  City: ${user.city || 'not set'}
  Today's date: ${today}`;

  const history = `
CONVERSATION HISTORY (most recent last):
Q1: ${user.history_3_q || ''} A1: ${user.history_3_a || ''}
Q2: ${user.history_2_q || ''} A2: ${user.history_2_a || ''}
Q3: ${user.history_1_q || ''} A3: ${user.history_1_a || ''}`;

  const restaurantData = googleResults && googleResults.length > 0
    ? `\nNEARBY RESTAURANT RESULTS: ${JSON.stringify(googleResults)}
FORMATTING RULE: For each restaurant include name, address,
phone number (nationalPhoneNumber field — always include if present in data),
rating, and whether currently open.
Ask staff: "Do you avoid onion and garlic in any form including powder?"
End with: "Call ahead to confirm dietary requirements"`
    : '';

  const calendar = calendarData
    ? `\nJAIN CALENDAR — NEXT 30 DAYS:\n${calendarData}`
    : '';

  const dynamicContent = profile + history + restaurantData + calendar + sun;

  return [
    {
      type: 'text',
      text: staticContent,
      cache_control: { type: 'ephemeral' }
    },
    {
      type: 'text',
      text: dynamicContent
    }
  ];
}
