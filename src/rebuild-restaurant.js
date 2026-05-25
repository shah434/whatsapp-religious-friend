// ============================================
// rebuild-restaurant.js — v3.1 restaurant journey (thin; shared city core)
// ============================================
// Same shape as rebuild-sunset.js. Supplies only what's unique to restaurant:
// the ask-city prompt and how to answer once we have a resolved place.
// ============================================
import { cityJourneyClaims, handleCityJourney } from './rebuild-city-journey.js';
import { searchRestaurants } from './location.js';
import { sendMessage } from './whatsapp.js';

export function rebuildRestaurantClaims(user, intent, text) {
  return cityJourneyClaims(user, intent, 'restaurant', text);
}

async function answerRestaurant(phone, user, place, intent, env) {
  const communityQuery = user.community === 'baps'
    ? 'BAPS Swaminarayan friendly'
    : 'Jain friendly';
const loc = user.city || [place.name, place.admin1, place.country].filter(Boolean).join(', ');
  const results = await searchRestaurants(communityQuery, loc, env);

  if (!results.length) {
    await sendMessage(phone, `I couldn't find vegetarian-friendly spots in ${loc} right now. Try a nearby larger city 🙏`, env);
    return;
  }

  const blocks = results.slice(0, 5).map(p => {
    const name = p.displayName?.text || 'Unnamed';
    const addr = p.formattedAddress || '';
    const phoneNo = p.nationalPhoneNumber ? `\n📞 ${p.nationalPhoneNumber}` : '';
    const rating = p.rating ? `⭐ ${p.rating}` : '';
    const open = p.regularOpeningHours?.openNow != null
      ? (p.regularOpeningHours.openNow ? ' | Open now' : ' | Closed now')
      : '';
    const ratingLine = (rating || open) ? `\n${rating}${open}` : '';
    return `*${name}*\n${addr}${phoneNo}${ratingLine}`;
  }).join('\n\n');

  await sendMessage(phone, blocks, env);
}

export async function handleRebuildRestaurant(phone, text, user, intent, env) {
  return handleCityJourney(phone, text, user, intent, env, {
    name: 'restaurant',
    askCityPrompt: `Which city should I find restaurants in? 🙏`,
    answer: answerRestaurant,
  });
}
