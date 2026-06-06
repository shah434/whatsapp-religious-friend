// IN PLAIN ENGLISH: the city flow logic. Do I have a city? If not, ask.
// When they reply, is it a number picking from a list or a new city name?
// Resolve it, save it, hand off to the journey. Shared by sunset & restaurant.
// ============================================
// rebuild-city-journey.js — shared core for city-needing journeys (v3.1)
// ============================================
// Sunset and restaurant are the same shape: they need ONE city, and once
// they have a resolved place they produce an answer. The ONLY difference is
// the answer step. Rather than copy the resolve/pending/resume machinery into
// two files that will drift apart, that machinery lives here ONCE, and each
// journey supplies:
//   - its journey name ('sunset' | 'restaurant')
//   - an askCityPrompt string ("Which city should I check sunset for?")
//   - an answer(phone, user, place, intent, env) function
//
// This is the same isolation contract as before: reads/writes ONLY
// users.pending_action, always returns true when it owns the turn, never
// touches the old flags, never replays raw text.
// ============================================

import { resolveLocation, formatCandidatePicker } from './resolveLocation.js';
import { serializePending, readPending } from './pending.js';
import { sendMessage } from './whatsapp.js';
import { updateUser } from './database.js';

// Does the new path own this turn for the given journey name?
//
// The rule has to balance two failure modes:
//   - HIJACK: a bare reply ("London", "1") to a pending "which city?" must NOT
//     be grabbed by a different journey's gate. The pending journey owns it.
//   - STUCK: a clear, self-contained NEW request ("find restaurants in Mumbai")
//     typed while a stale pending sunset record sits around must NOT be blocked
//     by that record. The new request wins and abandons the stale pending.
//
// The distinguishing signal is in the intent: classify() returns a real
// city-journey ('sunset'/'restaurant') for a self-contained request, but
// defaults a bare fragment ("London", "1", "yes") to 'food'. So:
//   - incoming intent IS a city-journey  -> fresh request, it wins outright
//     (whatever was pending is stale; the journey's own handler overwrites it)
//   - incoming intent is NOT a city-journey (bare reply) -> the pending record
//     governs: only the pending journey's gate claims it
//   - no pending + not a fresh city-journey -> nobody claims (old path)
const CITY_JOURNEYS = new Set(['sunset', 'restaurant', 'city_update', 'tithi']);
export function cityJourneyClaims(user, intent, journeyName, text) {
  // Fresh city-journey request (e.g. "sunset in tokyo") always wins.
  if (CITY_JOURNEYS.has(intent.journey)) {
    return intent.journey === journeyName;
  }
  // If classify() returned a real journey (not the 'food' default), the user
  // typed a recognizable request ("fasting", "tithi", etc.) — NOT a bare reply
  // to a city picker. Only unclassified messages (defaulting to 'food') are
  // candidates for resuming a pending city flow.
  if (intent.journey !== 'food') return false;

  // Claim ONLY if this journey is pending AND the message is a bare reply.
  const pending = readPending(user.pending_action);
  if (!pending || pending.intent.journey !== journeyName) return false;
  return isBareReply(text);
}

// Bare reply = a 1-2 digit number, OR a short 1-2 word string with no
// question/food words (a typed city name). Anything else is a fresh message.
export function isBareReply(text) {
  const t = (text || '').trim();
  if (/^[1-9][0-9]?$/.test(t)) return true;
  if (t.split(/\s+/).length > 2) return false;
  if (/\b(eat|safe|can|is|are|what|how|vegan|veg|jain)\b/i.test(t)) return false;
  return t.length >= 2 && t.length <= 50;
}

// Persist a resolved place onto the user (DB + in-memory), clearing pending.
async function saveCity(phone, user, place, env) {
  const display = `${place.name}${place.admin1 ? ', ' + place.admin1 : ''}${place.country ? ', ' + place.country : ''}`;
  await updateUser(phone, {
    city: display,
    timezone: place.timezone,
    latitude: place.latitude,
    longitude: place.longitude,
    pending_action: null,
  }, env);
  user.city = display;
  user.timezone = place.timezone;
  user.latitude = place.latitude;
  user.longitude = place.longitude;
  user.pending_action = null;
}

// Reconstruct a place from the user's saved coords (no re-geocode).
// Returns null if we don't have full saved coordinates.
function placeFromSaved(user) {
  if (!user.city || user.latitude == null || user.longitude == null || !user.timezone) {
    console.log(`[city] placeFromSaved null city=${user?.city} lat=${user?.latitude} lng=${user?.longitude} tz=${user?.timezone}`);
    return null;
  }
  return {
    name: user.city, latitude: user.latitude, longitude: user.longitude,
    timezone: user.timezone, admin1: null, country: null,
  };
}

// The shared handler. `journey` is { name, askCityPrompt, answer }.
// Returns true if it handled the turn (caller must then return).
export async function handleCityJourney(phone, text, user, intent, env, journey) {
  const pending = readPending(user.pending_action);

  // ---- RESUME: we previously asked this user for a city ----------------------
  if (pending && pending.intent.journey === journey.name && isBareReply(text)) {
    const reply = (text || '').trim();

    // Resume A: numbered pick from a city_pick list.
    if (pending.need === 'city_pick') {
      const n = /^[1-9][0-9]?$/.test(reply) ? parseInt(reply, 10) : null;
      const picked = n && pending.choices[n - 1];
      if (picked) {
        await saveCity(phone, user, picked, env);
        await journey.answer(phone, user, picked, pending.intent, env);
        return true;
      }
      // Non-numeric or out-of-range — try resolving as a fresh city name.
      // e.g. user typed "columbus, oh" or "new york" instead of picking a number.
      if (!n && reply.length >= 2) {
        // First: fuzzy-match against the existing choices so "Columbus Ohio USA"
        // doesn't re-geocode into another ambiguous list when the answer is
        // already in the list in front of them.
        const norm = reply.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ');

        // Match 1: reply contains both city name + state/country
        // e.g. "Columbus Ohio USA" → Columbus, Ohio, United States
        const fullMatch = pending.choices.find(c => {
          const name = (c.name || '').toLowerCase();
          const admin = (c.admin1 || '').toLowerCase();
          const country = (c.country || '').toLowerCase();
          return norm.includes(name) && (admin === '' || norm.includes(admin) || norm.includes(country));
        });
        if (fullMatch) {
          await saveCity(phone, user, fullMatch, env);
          await journey.answer(phone, user, fullMatch, pending.intent, env);
          return true;
        }

        // Match 2: reply is just the state/region to disambiguate
        // e.g. user replied "Ohio" to a Columbus picker → picks Columbus, Ohio
        // Only fires when exactly one choice has that admin1 (unambiguous).
        const adminMatches = pending.choices.filter(c => {
          const admin = (c.admin1 || '').toLowerCase();
          return admin && norm.trim() === admin;
        });
        if (adminMatches.length === 1) {
          await saveCity(phone, user, adminMatches[0], env);
          await journey.answer(phone, user, adminMatches[0], pending.intent, env);
          return true;
        }

        const res = await resolveLocation(reply);
        if (res.status === 'resolved') {
          await saveCity(phone, user, res.place, env);
          await journey.answer(phone, user, res.place, pending.intent, env);
          return true;
        }
        if (res.status === 'ambiguous') {
          const rec = serializePending({ need: 'city_pick', intent: pending.intent, choices: res.candidates });
          await updateUser(phone, { pending_action: rec }, env);
          user.pending_action = rec;
          await sendMessage(phone, formatCandidatePicker(reply, res.candidates), env);
          return true;
        }
      }
      // Still couldn't resolve — ask again
      const max = pending.choices.length;
      const msg = n
        ? `That number wasn't in the list. Reply with 1–${max}, or type the full city name 🙏🏾`
        : `I couldn't find that city. Reply with 1–${max}, or type the full city name with state or country 🙏🏾`;
      await sendMessage(phone, msg, env);
      return true; // keep pending so they can retry
    }

    // Resume B: they typed a city name in answer to "which city?".
    const res = await resolveLocation(reply);
    if (res.status === 'resolved') {
      await saveCity(phone, user, res.place, env);
      await journey.answer(phone, user, res.place, pending.intent, env);
      return true;
    }
    if (res.status === 'ambiguous') {
      const rec = serializePending({ need: 'city_pick', intent: pending.intent, choices: res.candidates });
      await updateUser(phone, { pending_action: rec }, env);
      user.pending_action = rec;
      await sendMessage(phone, formatCandidatePicker(reply, res.candidates), env);
      return true;
    }
    if (res.status === 'error') {
      await sendMessage(phone, `Sorry — I couldn't look that up right now. Please try again in a moment 🙏🏾`, env);
      return true; // keep pending; retry
    }
    // missing
    await sendMessage(phone, `I couldn't find that city. Please type the full city name with state or country 🙏🏾`, env);
    return true;
  }

  // ---- FRESH request ---------------------------------------------------------
  // Preserve original text so journey.answer() can save it to history.
  if (!intent.params.original_text) intent.params.original_text = text;

  const cityRaw = intent.params.city_raw || null;

  if (cityRaw) {
    const res = await resolveLocation(cityRaw);
    if (res.status === 'resolved') {
      await saveCity(phone, user, res.place, env);
      await journey.answer(phone, user, res.place, intent, env);
      return true;
    }
    if (res.status === 'ambiguous') {
      const rec = serializePending({ need: 'city_pick', intent, choices: res.candidates });
      await updateUser(phone, { pending_action: rec }, env);
      user.pending_action = rec;
      await sendMessage(phone, formatCandidatePicker(cityRaw, res.candidates), env);
      return true;
    }
    // missing/error → fall through to saved-city / ask
  }

  // Saved city? Use it without re-geocoding.
  // city_update sets fallbackToSaved:false — confirming the OLD city when the
  // user is trying to set a NEW one would be wrong. All other journeys default
  // to true (use saved city to answer sunset/restaurant without re-asking).
  const saved = placeFromSaved(user);
  if (saved && journey.fallbackToSaved !== false) {
    // Clear any stale pending from a previous journey before answering.
    // The new-city path clears it via saveCity; this path skips saveCity so
    // we must clear explicitly — otherwise a dangling 'strictness' or other
    // pending can intercept the user's next reply.
    if (user.pending_action) {
      await updateUser(phone, { pending_action: null }, env);
      user.pending_action = null;
    }
    await journey.answer(phone, user, saved, intent, env);
    return true;
  }

  // Nothing usable → store pending(need:city, intent) and ask.
  const rec = serializePending({ need: 'city', intent });
  await updateUser(phone, { pending_action: rec }, env);
  user.pending_action = rec;
  await sendMessage(phone, journey.askCityPrompt, env);
  return true;
}
