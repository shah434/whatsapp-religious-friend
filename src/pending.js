// ============================================
// pending.js — the ONE validated pending record (v3.1)
// ============================================
// Replaces the three colliding flags (pending_tithi_city_ask,
// pending_strictness_ask, pending_city_choices) with a single validated
// record stored in one Supabase column: users.pending_action (text/JSON).
//
// When a journey can't proceed because a field is missing, we store the
// STRUCTURED intent we already classified (never the raw message), ask for
// the missing field, and on the user's reply we resolve the field and
// dispatch the stored intent directly. No message replay, no re-classify,
// no suppression flag.
//
// SHAPE (what gets stored):
//   {
//     need:    'city' | 'strictness' | 'city_pick',
//     intent:  <the structured intent object from classify()>,
//     choices?: [ place, ... ]   // present ONLY when need === 'city_pick'
//   }
//
// HARD RULE (spec point 3): the record is VALIDATED on read. A corrupt or
// unrecognized value resets to null instead of crashing mid-flow. This is
// the whole reason the record exists — to kill the "unvalidated string"
// risk that produced the recurring bug class.
// ============================================

// The journeys classify() can emit. Kept in sync with classify.js (frozen).
const ALLOWED_JOURNEYS = new Set([
  'food', 'tithi', 'sunset', 'restaurant', 'pachkhan',
  'greeting', 'account', 'offtopic',
]);

// The fields a journey can be waiting on.
const ALLOWED_NEEDS = new Set(['city', 'strictness', 'city_pick']);

// ── Serialize ───────────────────────────────────────────────────────────────
// Build the JSON string to store in users.pending_action.
// Returns null if the input is structurally invalid — callers should treat a
// null return as "don't set a pending record" rather than storing garbage.
export function serializePending({ need, intent, choices }) {
  if (!ALLOWED_NEEDS.has(need)) {
    console.log(`[pending] refuse_serialize bad_need=${need}`);
    return null;
  }
  if (!isValidIntent(intent)) {
    console.log(`[pending] refuse_serialize bad_intent`);
    return null;
  }
  if (need === 'city_pick') {
    if (!Array.isArray(choices) || choices.length === 0) {
      console.log(`[pending] refuse_serialize city_pick_without_choices`);
      return null;
    }
  }

  const record = { need, intent };
  if (need === 'city_pick') record.choices = choices;

  try {
    return JSON.stringify(record);
  } catch (err) {
    console.log(`[pending] serialize_error err=${err.message}`);
    return null;
  }
}

// ── Deserialize (validate-on-read) ───────────────────────────────────────────
// Parse and VALIDATE the stored value. On ANY failure, return null so the
// caller treats the message as a fresh classify() instead of resuming into a
// broken state. Never throws.
//
//   readPending(storedValue) -> { need, intent, choices? } | null
export function readPending(storedValue) {
  if (storedValue == null || storedValue === '') return null;

  let parsed;
  try {
    parsed = typeof storedValue === 'string' ? JSON.parse(storedValue) : storedValue;
  } catch {
    console.log(`[pending] event=corrupt reason=unparseable`);
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    console.log(`[pending] event=corrupt reason=not_object`);
    return null;
  }
  if (!ALLOWED_NEEDS.has(parsed.need)) {
    console.log(`[pending] event=corrupt reason=bad_need need=${parsed.need}`);
    return null;
  }
  if (!isValidIntent(parsed.intent)) {
    console.log(`[pending] event=corrupt reason=bad_intent`);
    return null;
  }
  if (parsed.need === 'city_pick') {
    if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) {
      console.log(`[pending] event=corrupt reason=city_pick_without_choices`);
      return null;
    }
  }

  const clean = { need: parsed.need, intent: parsed.intent };
  if (parsed.need === 'city_pick') clean.choices = parsed.choices;
  return clean;
}

// ── Intent validation ────────────────────────────────────────────────────────
// The minimum a stored intent must satisfy to be safely dispatched on resume.
// Deliberately shallow: journey must be a known value and params must be an
// object. We do NOT deep-validate params here — classify() owns that, and an
// over-strict check would reject valid intents as classify() grows.
function isValidIntent(intent) {
  if (!intent || typeof intent !== 'object') return false;
  if (!ALLOWED_JOURNEYS.has(intent.journey)) return false;
  if (intent.params != null && typeof intent.params !== 'object') return false;
  return true;
}
