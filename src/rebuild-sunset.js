// ============================================
// rebuild-sunset.js — v3.1 sunset journey (Option A, switch-gated)
// ============================================
// This is the FIRST journey wired through the new foundation:
//   classify (already done) -> need-gate -> resolveLocation -> pending -> dispatch
//
// It is reached ONLY when env.REBUILD_MODE === 'on' AND the message is a
// sunset request (or a reply to a sunset pending record). Every other journey,
// and the entire bot when REBUILD_MODE is off, stays on the existing path
// untouched. See handleRebuildSunset's contract below.
//
// ISOLATION FROM THE OLD PATH (critical):
//  - This path reads/writes ONLY users.pending_action (the new validated
//    record). It NEVER touches pending_tithi_city_ask, pending_strictness_ask,
//    or pending_city_choices.
//  - When it owns a turn it ALWAYS returns true, so the caller returns before
//    the old pending checks run. The two systems cannot interleave.
//
// NO MESSAGE REPLAY: on resume we dispatch the STORED intent, never re-read or
// re-classify the user's original text.
// ============================================

import { classify } from './classify.js';
import { resolveLocation, formatCandidatePicker } from './resolveLocation.js';
import { serializePending, readPending } from './pending.js';
import { getSunForPlace, formatSunDataForClaude } from './sunset.js';
import { sendMessage } from './whatsapp.js';
import { callClaude } from './claude.js';
import { updateUser } from './database.js';
import { buildSystemPrompt } from './utils.js';

// Decide whether the new sunset path should own this turn.
// Returns true if EITHER:
//   (a) there's a valid pending record from THIS path waiting on a city, or
//   (b) this is a fresh sunset request.
// Anything else → false → caller stays on the old flow.
export function rebuildSunsetClaims(user, intent) {
  const pending = readPending(user.pending_action);
  if (pending && pending.intent.journey === 'sunset') return true;
  if (intent.journey === 'sunset') return true;
  return false;
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

// Run the actual sunset answer once we HAVE a resolved place.
async function answerSunset(phone, user, place, intent, env) {
  const sunInfo = await getSunForPlace(place);
  if (!sunInfo) {
    await sendMessage(phone, `Sorry — I couldn't look up that city right now. Please try again in a moment 🙏`, env);
    return;
  }
  const sunData = formatSunDataForClaude(sunInfo);
  // queryTypes 'calendar' carries the sunset formatting rules in the prompt.
  const system = buildSystemPrompt(user, [], '', sunData, ['calendar']);
  const reply = await callClaude([{ role: 'user', content: 'sunset' }], system, env);
  await sendMessage(phone, reply, env);
}

// ── Main entry ───────────────────────────────────────────────────────────────
// Returns true if this path handled the turn (caller must then return), false
// if it declined (shouldn't happen if rebuildSunsetClaims() gated correctly,
// but defensive).
//
//   handleRebuildSunset(phone, text, user, intent, env) -> boolean
export async function handleRebuildSunset(phone, text, user, intent, env) {
  const pending = readPending(user.pending_action);

  // ---- RESUME: we previously asked this user for a city ----------------------
  if (pending && pending.intent.journey === 'sunset') {
    const reply = (text || '').trim();

    // Resume A: a numbered pick from a city_pick list.
    if (pending.need === 'city_pick') {
      const n = /^[1-9][0-9]?$/.test(reply) ? parseInt(reply, 10) : null;
      const picked = n && pending.choices[n - 1];
      if (!picked) {
        await sendMessage(phone, `That number didn't match the list. Please type your city name again 🙏`, env);
        // keep the pending record so they can try again
        return true;
      }
      await saveCity(phone, user, picked, env);
      await answerSunset(phone, user, picked, pending.intent, env);
      return true;
    }

    // Resume B: they typed a city name in answer to "which city?".
    const res = await resolveLocation(reply);
    if (res.status === 'resolved') {
      await saveCity(phone, user, res.place, env);
      await answerSunset(phone, user, res.place, pending.intent, env);
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
      await sendMessage(phone, `Sorry — I couldn't look that up right now. Please try again in a moment 🙏`, env);
      return true; // keep pending; they can retry
    }
    // missing
    await sendMessage(phone, `I couldn't find that city. Please type the full city name with state or country 🙏`, env);
    return true;
  }

  // ---- FRESH sunset request --------------------------------------------------
  // Need-gate: sunset needs a city. Try (1) a city in the message, (2) the
  // saved city, else ask.
  const cityRaw = intent.params.city_raw || null;

  if (cityRaw) {
    const res = await resolveLocation(cityRaw);
    if (res.status === 'resolved') {
      await saveCity(phone, user, res.place, env);
      await answerSunset(phone, user, res.place, intent, env);
      return true;
    }
    if (res.status === 'ambiguous') {
      const rec = serializePending({ need: 'city_pick', intent, choices: res.candidates });
      await updateUser(phone, { pending_action: rec }, env);
      user.pending_action = rec;
      await sendMessage(phone, formatCandidatePicker(cityRaw, res.candidates), env);
      return true;
    }
    // missing/error fall through to the "ask for city" branch below
  }

  // Saved city? Reconstruct a place from saved coords (no re-geocode).
  if (user.city && user.latitude != null && user.longitude != null && user.timezone) {
    const place = {
      name: user.city, latitude: user.latitude, longitude: user.longitude,
      timezone: user.timezone, admin1: null, country: null,
    };
    await answerSunset(phone, user, place, intent, env);
    return true;
  }

  // Nothing usable → store pending(need:city, intent) and ask.
  const rec = serializePending({ need: 'city', intent });
  await updateUser(phone, { pending_action: rec }, env);
  user.pending_action = rec;
  await sendMessage(phone, `Which city should I check sunset for? 🙏`, env);
  return true;
}
