// ============================================
// rebuild-restaurant.js — v3.1 restaurant journey (thin; shared city core)
// ============================================
// Same shape as rebuild-sunset.js. Supplies only what's unique to restaurant:
// the ask-city prompt and how to answer once we have a resolved place.
// ============================================
import { cityJourneyClaims, handleCityJourney } from './rebuild-city-journey.js';
import { searchRestaurants, searchTemples } from './location.js';
import { sendMessage } from './whatsapp.js';
import { updateUser } from './database.js';
import { serializePending } from './pending.js';
import { LOCATION_SHARE_FOR_RESULTS } from './prompts.js';

export function rebuildRestaurantClaims(user, intent, text) {
  return cityJourneyClaims(user, intent, 'restaurant', text);
}

function formatPlaces(results) {
  return results.slice(0, 5).map(p => {
    const name = p.displayName?.text || 'Unnamed';
    const addr = p.formattedAddress || '';
    const phoneNo = p.nationalPhoneNumber ? `\n📞 ${p.nationalPhoneNumber}` : '';
    const website = p.websiteUri ? `\n🌐 ${p.websiteUri}` : '';
    const rating = p.rating ? `⭐ ${p.rating}` : '';
    const open = p.regularOpeningHours?.openNow != null
      ? (p.regularOpeningHours.openNow ? ' | Open now' : ' | Closed now')
      : '';
    const ratingLine = (rating || open) ? `\n${rating}${open}` : '';
    return `*${name}*\n${addr}${phoneNo}${website}${ratingLine}`;
  }).join('\n\n');
}

async function answerRestaurant(phone, user, place, intent, env) {
  const isTemple = intent.params?.place_type === 'temple';

  // `place` already reflects the correct priority:
  //   1. WhatsApp location pin  →  reverseGeocoded pin coordinates
  //   2. City typed in message  →  geocoded city coordinates
  //   3. Saved profile city     →  placeFromSaved(user) coordinates
  // Always use place coords for locationBias so Google Places searches
  // the right spot regardless of which path resolved the location.
  const coords = { lat: place.latitude, lng: place.longitude };
  const loc = [place.name, place.admin1, place.country].filter(Boolean).join(', ') || user.city;

  // Show the location-sharing invite only when we silently used the saved city
  // (no pin shared, no city typed, and not already a pin-refined result).
  // _pin_refine flag is set on the stored intent when the invite fires so
  // the second pass — after the user shares their pin — never shows it again.
  const usedSavedCity = !intent.params?.locationPin
    && !intent.params?.city_raw
    && !intent.params?._pin_refine;
  const locationOffer = usedSavedCity ? LOCATION_SHARE_FOR_RESULTS : '';

  if (isTemple) {
    const results = await searchTemples(user.community, loc, env, coords);
    if (!results.length) {
      await sendMessage(phone, `I couldn't find any temples in ${loc} right now. Try searching "Jain center ${loc}" on Google Maps, or check jainworld.com 🙏🏾${locationOffer}`, env);
    } else {
      const label = user.community === 'baps' ? 'BAPS mandirs' : 'Jain temples';
      await sendMessage(phone, `Here are some ${label} near ${loc}:\n\n${formatPlaces(results)}\n\nCall ahead to confirm timings 🙏🏾${locationOffer}`, env);
    }
  } else {
    const cuisine = intent.params?.cuisine || null;
    const communityTag = user.community === 'baps' ? 'BAPS Swaminarayan friendly' : 'Jain friendly';

    let results;
    if (cuisine) {
      const [r1, r2] = await Promise.all([
        searchRestaurants(`${cuisine} ${communityTag}`, loc, env, coords),
        searchRestaurants(`${cuisine} vegetarian`, loc, env, coords),
      ]);
      const seen = new Set();
      results = [...r1, ...r2].filter(p => {
        const key = (p.displayName?.text || '').toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 5);
    } else {
      results = await searchRestaurants(communityTag, loc, env, coords);
    }

    if (!results.length) {
      await sendMessage(phone, `I couldn't find vegetarian-friendly spots in ${loc} right now. Try a nearby larger city 🙏🏾${locationOffer}`, env);
    } else {
      await sendMessage(phone, `${formatPlaces(results)}${locationOffer}`, env);
    }
  }

  // Always arm a one-time city pending after restaurant results.
  // If the user shares a location pin (whether or not we showed the invite),
  // the search re-runs near the pin immediately without them having to retype.
  // _pin_refine=true on the stored intent prevents the invite from appearing
  // on the pin-based result, breaking any potential loop.
  if (!intent.params?._pin_refine) {
    const oneTimeIntent = { ...intent, params: { ...intent.params, _pin_refine: true } };
    const rec = serializePending({ need: 'city', intent: oneTimeIntent });
    if (rec) await updateUser(phone, { pending_action: rec }, env);
  }
}

export async function handleRebuildRestaurant(phone, text, user, intent, env) {
  const isTemple = intent.params?.place_type === 'temple';
  return handleCityJourney(phone, text, user, intent, env, {
    name: 'restaurant',
    askCityPrompt: isTemple
      ? `Which city should I search for temples in? 🙏🏾${LOCATION_SHARE_FOR_RESULTS}`
      : `Which city should I find restaurants in? 🙏🏾${LOCATION_SHARE_FOR_RESULTS}`,
    answer: answerRestaurant,
  });
}
