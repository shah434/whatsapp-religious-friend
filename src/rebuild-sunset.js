// IN PLAIN ENGLISH: the sunset-specific bit. Says what question to ask
// ("which city?") and what to do once we have a city (look up sun times).
// Hands the actual flow to rebuild-city-journey.js. Imported by worker.js.
// ============================================
// rebuild-sunset.js — v3.1 sunset journey (thin; uses shared city core)
// ============================================
// The resolve/pending/resume machinery lives in rebuild-city-journey.js.
// This file supplies ONLY what's unique to sunset: the prompt to ask for a
// city, and how to answer once we have a resolved place.
// ============================================

import { cityJourneyClaims, handleCityJourney } from './rebuild-city-journey.js';
import { getSunForPlace, formatSunDataForClaude } from './sunset.js';
import { sendMessage } from './whatsapp.js';
import { callClaude } from './claude.js';
import { buildSystemPrompt, buildHistoryMessages, buildHistoryUpdate } from './utils.js';
import { serializePending } from './pending.js';
import { updateUser } from './database.js';

export function rebuildSunsetClaims(user, intent, text) {
  return cityJourneyClaims(user, intent, 'sunset', text);
}

async function answerSunset(phone, user, place, intent, env) {
  const sunInfo = await getSunForPlace(place, intent.params?.sun_date || null);
  if (!sunInfo) {
    await sendMessage(phone, `Sorry — I couldn't look up that city right now. Please try again in a moment 🙏🏾`, env);
    return;
  }
  const sunData = formatSunDataForClaude(sunInfo);
  const system = buildSystemPrompt(user, '', sunData);
  const kind = intent.params?.sun_kind || 'sunset';
  const when = intent.params?.sun_date === 'tomorrow' ? ' tomorrow' : '';
  const reply = await callClaude([...buildHistoryMessages(user), { role: 'user', content: `${kind}${when}` }], system, env, 150);
  await sendMessage(phone, reply, env);

  // Save history + offer tithi check in parallel (both are post-send, non-blocking).
  const question = intent.params?.original_text || `${kind}${when}`;
  const historyUpdate = buildHistoryUpdate(user, question, reply);

  if (user.community !== 'baps' && !intent.params?.sun_date) {
    const rec = serializePending({ need: 'tithi_followup', intent: { journey: 'tithi', params: {} } });
    if (rec) await updateUser(phone, { ...historyUpdate, pending_action: rec }, env);
  } else {
    await updateUser(phone, historyUpdate, env);
  }
}

export async function handleRebuildSunset(phone, text, user, intent, env) {
  return handleCityJourney(phone, text, user, intent, env, {
    name: 'sunset',
    askCityPrompt: `Which city should I check sunset for? 🙏🏾`,
    answer: answerSunset,
  });
}
