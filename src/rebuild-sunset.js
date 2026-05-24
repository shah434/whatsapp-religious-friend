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
import { buildSystemPrompt } from './utils.js';

export function rebuildSunsetClaims(user, intent) {
  return cityJourneyClaims(user, intent, 'sunset');
}

async function answerSunset(phone, user, place, intent, env) {
  const sunInfo = await getSunForPlace(place);
  if (!sunInfo) {
    await sendMessage(phone, `Sorry — I couldn't look up that city right now. Please try again in a moment 🙏`, env);
    return;
  }
  const sunData = formatSunDataForClaude(sunInfo);
  const system = buildSystemPrompt(user, [], '', sunData, ['calendar']);
  const reply = await callClaude([{ role: 'user', content: 'sunset' }], system, env);
  await sendMessage(phone, reply, env);
}

export async function handleRebuildSunset(phone, text, user, intent, env) {
  return handleCityJourney(phone, text, user, intent, env, {
    name: 'sunset',
askCityPrompt: `🟢NEWPATH🟢 Which city should I check sunset for?`,    answer: answerSunset,
  });
}
