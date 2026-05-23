// ============================================
// rebuild-restaurant.js — v3.1 restaurant journey (thin; uses shared city core)
// ============================================
// Same shape as sunset: needs ONE city. Supplies only the ask-prompt and the
// answer step. The answer calls the existing Google Places search and formats
// via buildSystemPrompt with queryTypes ['restaurant'].
// ============================================

import { cityJourneyClaims, handleCityJourney } from './rebuild-city-journey.js';
import { searchRestaurants } from './location.js';
import { sendMessage } from './whatsapp.js';
import { callClaude } from './claude.js';
import { buildSystemPrompt } from './utils.js';

export function rebuildRestaurantClaims(user, intent) {
  return cityJourneyClaims(user, intent, 'restaurant');
}

async function answerRestaurant(phone, user, place, intent, env) {
  const communityQuery = user.community === 'baps'
    ? 'BAPS Swaminarayan friendly'
    : 'Jain friendly';
  // Use the resolved display name as the location string for Places.
  const location = `${place.name}${place.admin1 ? ', ' + place.admin1 : ''}${place.country ? ', ' + place.country : ''}`;
  let googleResults = [];
  try {
    googleResults = await searchRestaurants(communityQuery, location, env);
  } catch (err) {
    console.log(`[rebuild-restaurant] places_error err=${err.message}`);
  }
  const system = buildSystemPrompt(user, googleResults, '', '', ['restaurant']);
  // Restaurant lists (name + address + phone + rating + status per place) far
  // exceed the 250-token verdict default, which truncated the reply mid-list.
  // Give this journey more room; every other journey stays at the 250 default.
  const reply = await callClaude([{ role: 'user', content: 'restaurants' }], system, env, 600);
  await sendMessage(phone, reply, env);
}

export async function handleRebuildRestaurant(phone, text, user, intent, env) {
  return handleCityJourney(phone, text, user, intent, env, {
    name: 'restaurant',
    askCityPrompt: `Which city or area should I find restaurants in? 🙏`,
    answer: answerRestaurant,
  });
}
