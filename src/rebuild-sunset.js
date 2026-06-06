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
import { buildSystemPrompt, buildHistoryMessages } from './utils.js';
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
  const reply = await callClaude([...buildHistoryMessages(user), { role: 'user', content: `${kind}${when}` }], system, env);
  await sendMessage(phone, reply, env);

  // Offer a tithi check after today's sunset (Jain only, not for tomorrow queries).
  // Stores a pending so "yes/yea/sure" on the next turn routes to answerTithi.
  if (user.community !== 'baps' && !intent.params?.sun_date) {
    const rec = serializePending({ need: 'tithi_followup', intent: { journey: 'tithi', params: {} } });
    if (rec) {
      await updateUser(phone, { pending_action: rec }, env);
      console.log(`[sunset] tithi_followup pending set phone=${phone}`);
    }
  }
}

export async function handleRebuildSunset(phone, text, user, intent, env) {
  return handleCityJourney(phone, text, user, intent, env, {
    name: 'sunset',
    askCityPrompt: `Which city should I check sunset for? 🙏🏾`,
    answer: answerSunset,
  });
}
