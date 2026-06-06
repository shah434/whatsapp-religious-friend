// Handles tithi / calendar questions.
// Needs city for timezone — uses shared city journey core (same as sunset/restaurant).
// If city is saved, uses it directly. If not, asks first.

import { cityJourneyClaims, handleCityJourney } from './rebuild-city-journey.js';
import { getCalendarCached, formatEventsForClaude } from './calendar.js';
import { callClaude } from './claude.js';
import { sendMessage } from './whatsapp.js';
import { buildSystemPrompt, buildHistoryMessages } from './utils.js';
import { serializePending } from './pending.js';
import { updateUser } from './database.js';

const TITHI_CLAIM_PATTERNS = [
  /\btoday\s+is\s+(a\s+)?(?:beej|bij|chaturdashi|chaumasi|paryushan(?:a)?|ekadashi|atthai|attham|chhath|punam|ashtami|nom|amavasya|purnima|fast day|tithi)\b/i,
  /\b(?:it\s+is|it'?s)\s+(?:beej|bij|chaturdashi|chaumasi|paryushan(?:a)?|ekadashi|atthai|attham|chhath|punam|ashtami|nom|amavasya|purnima)\b/i,
  /\bno food (?:should be eaten )?until tomorrow\b/i,
  /\btoday\s+is\s+a\s+fast(?:ing)?\s+day\b/i,
];

export function tithiClaims(user, intent, text) {
  return cityJourneyClaims(user, intent, 'tithi', text);
}

async function answerTithi(phone, user, place, intent, env) {
  const calendarEvents = await getCalendarCached(env); // KV hit, ~5ms
  const needsFull = /paryushana|coming|upcoming|next|when|week|wk/i.test(intent.params?.original_text || '');
  const calendarData = user.community === 'jain'
    ? formatEventsForClaude(calendarEvents, place.timezone, needsFull ? 10 : 3)
    : '';

  const todayIsTithi = /TODAY_IS_TITHI:\s*true/i.test(calendarData);

  // Use the shared buildSystemPrompt so tithi queries share the main Jain
  // cache bucket with food queries instead of having their own smaller bucket.
  const system = buildSystemPrompt(user, calendarData, '', null);

  // Use the original user question stored in intent params
  const question = intent.params?.original_text || 'What tithi is today?';
  let response = await callClaude([...buildHistoryMessages(user), { role: 'user', content: question }], system, env, 200);

  // Strip calendar markers
  response = response
    .replace(/TODAY_IS_TITHI:\s*(true|false)/gi, '')
    .replace(/TODAY_TITHI_NAME:.*$/gim, '')
    .trim();

  // Guard: prevent hallucinated tithi claims
  const claimsTithiToday = TITHI_CLAIM_PATTERNS.some(p => p.test(response));
  if (!todayIsTithi && claimsTithiToday) {
    const sentences = response.split(/(?<=[.!?])\s+/);
    response = sentences.filter(s => !TITHI_CLAIM_PATTERNS.some(p => p.test(s))).join(' ').trim()
      || "Let me know what you'd like to check 🙏🏾";
  }

  // Prepend tithi fact if today is a tithi
  const m = calendarData.match(/TODAY_IS_TITHI:\s*true[\s\S]*?TODAY_TITHI_NAME:\s*(.+)/i);
  const tithiFact = m ? `Today is ${m[1].trim()} 🙏🏾\n\n` : '';

  await sendMessage(phone, tithiFact + response, env);

  // Set pending whenever Claude ended with a question so a short reply
  // ("yes", "sure") is handled with context rather than getting lost.
  if (response.trimEnd().endsWith('?') || needsFull) {
    const rec = serializePending({ need: 'tithi_food_followup', intent: { journey: 'tithi', params: {} } });
    if (rec) await updateUser(phone, { pending_action: rec }, env);
  }
}

export async function handleRebuildTithi(phone, text, user, intent, env) {
  // Stash the original question in intent params so answerTithi can use it
  // after the city resolution (which may happen on a later turn).
  if (!intent.params) intent.params = {};
  if (!intent.params.original_text) intent.params.original_text = text;

  return handleCityJourney(phone, text, user, intent, env, {
    name: 'tithi',
    askCityPrompt: `Which city are you in? I need it to make sure the date is right for your timezone 🙏🏾`,
    answer: answerTithi,
    fallbackToSaved: true, // if city saved, use it without re-asking
  });
}
