// ============================================
// classify.js — v3.1 single-pass intent classifier
// ============================================
// Turns a raw inbound message into ONE structured intent object.
// After this runs, NOTHING downstream reads the raw message again.
// 
//   classify(message, hasImage) -> intent
//
//   intent = {
//     journey:  'food' | 'tithi' | 'sunset' | 'restaurant' | 'pachkhan'
//             | 'greeting' | 'account' | 'offtopic',
//     params: {
//       food_text?:  string,
//       has_image?:  boolean,
//       city_raw?:   string,
//       fast_term?:  string,    // canonical fast category, from detectFastTerm
//       sun_kind?:   'sunset' | 'sunrise',
//     },
//     prompt_blocks: string[]    // derived; which USE_CASE_* blocks to load
//   }
//
// Design rules (from the v3.1 spec):
//  - Journey is SINGLE. prompt_blocks is the multi-value channel for the
//    system-prompt assembler (e.g. food-during-fast loads general+fasting).
//  - A fast term present + a specific food named => journey 'food'
//    (NOT pachkhan, NOT calendar), with fast_term carried in params and
//    'fasting' added to prompt_blocks so the verdict engine sees the rules.
//  - pachkhan is reserved for asking what the RULES are, no specific food.
//  - A single on-topic noun opens that journey (bare topic word), it is
//    NEVER offtopic. offtopic fires only for genuinely unrelated input.
// ============================================

import { detectFastTerm } from './fasting-match.js';

// ── Bare topic nouns → the journey they open ────────────────────────────────
// A message that is essentially JUST one of these (no real question, no food)
// is the user opening that topic. The need-gate then asks the right question.
const BARE_TOPIC = {
  pachkhan:     'pachkhan',
  'પચ્ચક્ખાણ':  'pachkhan',
  'પચખાણ':      'pachkhan',
  fast:         'pachkhan',
  fasting:      'pachkhan',
  calendar:     'tithi',
  tithi:        'tithi',
  panchang:     'tithi',
  sunset:       'sunset',
  sunrise:      'sunset',
  restaurant:   'restaurant',
  restaurants:  'restaurant',
  label:        'food',
  scan:         'food',
  medicine:     'food',
  supplement:   'food',
  substitution: 'food',
  substitute:   'food',
};

// ── Keyword sets ────────────────────────────────────────────────────────────
const RE_RESTAURANT = /\b(restaurant|restaurants|eat near|food near|where to eat|where can i eat|find jain|find baps|places to eat|somewhere to eat)\b/i;
const RE_SUBSTITUTE = /\b(substitute|substitution|alternative|alternatives|instead of|replace|replacement|swap)\b/i;
const RE_MEDICINE   = /\b(medicine|medication|supplement|capsule|tablet|drug|pill|pharma|prescription|vitamin|tablets|capsules)\b/i;
const RE_SUNSET     = /\b(sunset|sun set|when does the sun set|what time.*sun.*down)\b/i;
const RE_SUNRISE    = /\b(sunrise|sun rise|when does the sun rise)\b/i;
const RE_CALENDAR   = /\b(tithi|calendar|panchang|ekadashi|paryushan(?:a)?|is today|today.*(special|fast|tithi)|what.*(tithi|day is)|special day)\b/i;
const RE_ENGLISH_FAST = /\b(fast|fasting|paryushana|paryushan|ekadashi|nirjala|jalahar|farari|nom|punam|chaturmas|sadh.porsi|navapad|oli|varshitap|vardhaman|visasthanak|upvas|upavas|ekasan|biyasan|ayambil|chauvihar|tivihar|navkarsi|porsi|atthai|attham|chhath)\b/i;

const RE_GREETING = /^(hi|hello|hey|hiya|yo|namaste|namaskar|jai jinendra|jai swaminarayan|hola|good (morning|afternoon|evening))\b[\s!.?]*$/i;
const RE_ACCOUNT  = /\b(delete me|delete my account|delete my data|remove my data|remove me|unsubscribe|stop using|forget me|opt out|wipe my)\b/i;
const RE_CITY_STATEMENT = /^(?:my city is|i live in|i'?m in|set my city to|change my city to|update my city to)\s+([a-zA-Z][a-zA-Z\s,]+?)[?.!]*$/i;

// Genuinely-unrelated signals. Deliberately conservative — we would rather
// answer a borderline message than wrongly reject a real one. offtopic is the
// LAST resort, only when nothing on-topic matched AND one of these fired.
const RE_OFFTOPIC = /\b(football|cricket|soccer|nba|election|president|stock|bitcoin|crypto|weather forecast|movie|netflix|song|lyrics|write me (a|some) (code|poem|essay)|javascript|python|who won|score)\b/i;

// Food-intent verbs/markers. Used to decide pachkhan(rules) vs food(verdict)
// and to detect a food question that has no obvious keyword.
const RE_FOOD_INTENT = /\b(can i (eat|have|drink|take)|is .* (safe|ok|okay|allowed|vegan|veg|jain)|safe to eat|allowed to eat|may i (eat|have)|is this|are these|check (this|the)|what about|ingredients?)\b/i;

// OPEN-ENDED rules question ("what can I eat during X", "what's allowed on X").
// No specific food named — this is pachkhan (recite the rules), NOT a food
// verdict. Must be checked BEFORE the food-during-fast branch.
const RE_OPEN_ENDED_FAST = /\b(what (can|should|am i allowed to) (i )?(eat|have|drink)|what'?s allowed|what foods?|which foods?|what to eat|tell me about|rules (for|of|during)|how does .* work)\b/i;

// ── Helpers ─────────────────────────────────────────────────────────────────

function normToken(t) {
  return t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// Is the whole message essentially one bare topic noun? (allow trailing
// punctuation and a leading article). Returns the journey or null.
function bareTopic(text) {
  const stripped = text.trim().replace(/[?!.]+$/, '').replace(/^(the|a|an)\s+/i, '').trim();
  const tokens = stripped.split(/\s+/);
  if (tokens.length > 2) return null;            // more than 2 words => not bare
  const key = normToken(stripped);
  if (BARE_TOPIC[stripped] ) return BARE_TOPIC[stripped];   // gujarati script exact
  if (BARE_TOPIC[key]) return BARE_TOPIC[key];
  return null;
}

// Best-effort extraction of the city the user typed (pre-resolution).
// Intentionally light — the resolver does the real work in step 2. We only
// capture the raw string so the resolver has something to geocode.
function extractCityRaw(text) {
  const cleaned = text
    .replace(/\b(today|tonight|now|currently|please|pls)\b/gi, '')
    .trim();
  const patterns = [
    /(?:sunset|sunrise|restaurants?|eat|tithi)\s+(?:in|for|at|near)\s+([a-zA-Z][a-zA-Z\s,]+?)(?:\?|$)/i,
    /\bin\s+([a-zA-Z][a-zA-Z\s,]+?)(?:\?|$)/i,
    /\b(\d{5})\b/,
    /\b([A-Z]{1,2}\d{1,2}\s?\d[A-Z]{2})\b/i,
  ];
  for (const p of patterns) {
    const m = cleaned.match(p);
    if (m && m[1]) {
      const c = m[1].trim();
      if (['me', 'here', 'my area', 'nearby', 'near me'].includes(c.toLowerCase())) return null;
      if (c.length < 2 || c.length > 50) return null;
      return c;
    }
  }
  return null;
}

// Strip obvious non-food words to get a rough food_text. Best-effort only;
// the model still sees the full message, this is for telemetry/params.
function extractFoodText(text) {
  const m = text.match(/\b(?:can i (?:eat|have|drink|take)|is|are)\s+(.+?)(?:\s+(?:safe|ok|okay|allowed|vegan|jain|during|on)\b|\?|$)/i);
  if (m && m[1] && m[1].trim().length > 1) return m[1].trim();
  return null;
}

// ── Main ────────────────────────────────────────────────────────────────────

export function classify(message, hasImage = false) {
  const text = (message || '').trim();
  const lower = text.toLowerCase();

  const intent = { journey: 'food', params: {}, prompt_blocks: [] };
  if (hasImage) intent.params.has_image = true;

  // 1. ACCOUNT — explicit, highest precedence (overrides everything).
  if (RE_ACCOUNT.test(lower)) {
    intent.journey = 'account';
    intent.prompt_blocks = ['general'];
    return intent;
  }

  // 2. IMAGE — a photo is always a food/label scan, regardless of caption.
  //    (Caption may add a fast term; we still capture it.)
  if (hasImage) {
    intent.journey = 'food';
    intent.prompt_blocks = ['label_scan'];
    const fast = detectFastTerm(text);
    if (fast.matched) {
      intent.params.fast_term = fast.category;
      intent.prompt_blocks.push('fasting');
    }
    const food = extractFoodText(text);
    if (food) intent.params.food_text = food;
    return intent;
  }

  // 3. GREETING — bare greeting only (a greeting + question is not a greeting).
  if (RE_GREETING.test(text)) {
    intent.journey = 'greeting';
    intent.prompt_blocks = ['general'];
    return intent;
  }

  // 4. BARE TOPIC WORD — single on-topic noun opens that journey.
  //    NEVER offtopic. Empty params => need-gate asks the right question.
 const bare = bareTopic(text);
  if (bare) {
    intent.journey = bare;
    if (bare === 'pachkhan') {
      const f = detectFastTerm(text);
      intent.params.fast_term = f.matched ? f.category : 'pachkhan_general';
    }
    intent.prompt_blocks = bare === 'pachkhan' ? ['fasting']
      : bare === 'tithi'   ? ['calendar']
      : bare === 'sunset'  ? ['calendar']
      : bare === 'restaurant' ? ['restaurant']
      : ['general'];
    // For a bare 'sunset'/'sunrise' word, record which one.
    if (bare === 'sunset') intent.params.sun_kind = /sunrise/i.test(lower) ? 'sunrise' : 'sunset';
    return intent;
  }

  // 4b. CITY STATEMENT — bare profile update ("my city is brooklyn").
  //     Not a journey question; just save the city and confirm.
  const cityStmt = text.match(RE_CITY_STATEMENT);
  if (cityStmt && cityStmt[1]) {
    const c = cityStmt[1].trim();
    if (c.length >= 2 && c.length <= 50 && !/^(here|me|nearby)$/i.test(c)) {
      intent.journey = 'city_update';
      intent.params.city_raw = c;
      intent.prompt_blocks = [];
      return intent;
    }
  }
  // 5. Detect signals (order below resolves multi-signal messages).
  const fast = detectFastTerm(text);
  const englishFast = RE_ENGLISH_FAST.test(lower);
  const hasFast = fast.matched || englishFast;
  const hasFoodIntent = RE_FOOD_INTENT.test(lower);
  const isSunset = RE_SUNSET.test(lower) || RE_SUNRISE.test(lower);
  const isRestaurant = RE_RESTAURANT.test(lower);
  const isSubstitute = RE_SUBSTITUTE.test(lower);
  const isMedicine = RE_MEDICINE.test(lower);
  const isCalendar = RE_CALENDAR.test(lower);

  // 6. SUNSET / SUNRISE — strong, unambiguous signal.
  if (isSunset) {
    intent.journey = 'sunset';
    intent.params.sun_kind = RE_SUNRISE.test(lower) ? 'sunrise' : 'sunset';
    const city = extractCityRaw(text);
    if (city) intent.params.city_raw = city;
    intent.prompt_blocks = ['calendar'];
    return intent;
  }

  // 7. RESTAURANT — location-finding journey.
  if (isRestaurant) {
    intent.journey = 'restaurant';
    const city = extractCityRaw(text);
    if (city) intent.params.city_raw = city;
    intent.prompt_blocks = ['restaurant'];
    return intent;
  }

  // 8. FOOD-DURING-FAST — fast term AND a specific food/food-intent.
  //    Per the product decision: journey = food (verdict), NOT pachkhan,
  //    NOT calendar. fast_term rides in params; fasting rules load so the
  //    model can say "no, not during ayambil".
  //    GUARD: an OPEN-ENDED rules question ("what can I eat during upvas")
  //    names no specific food → that is pachkhan, handled in step 9. Only
  //    route here when it's NOT open-ended.
  const openEnded = RE_OPEN_ENDED_FAST.test(lower);
  if (hasFast && !openEnded && (hasFoodIntent || isSubstitute || isMedicine)) {
    intent.journey = 'food';
    if (fast.matched) intent.params.fast_term = fast.category;
    const food = extractFoodText(text);
    if (food) intent.params.food_text = food;
    intent.prompt_blocks = ['general', 'fasting'];
    if (isSubstitute) intent.prompt_blocks.push('substitution');
    if (isMedicine) intent.prompt_blocks.push('medicine');
    return intent;
  }

  // 9. PACHKHAN — fast present but NO specific food: asking the rules.
  //    ("what is ayambil", "what can I eat during upvas", bare-ish fast Q)
  if (hasFast) {
    intent.journey = 'pachkhan';
    if (fast.matched) intent.params.fast_term = fast.category;
    intent.prompt_blocks = ['fasting'];
    return intent;
  }

  // 10. CALENDAR / TITHI — no fast term, but asking about the day itself.
  if (isCalendar) {
    intent.journey = 'tithi';
    const city = extractCityRaw(text);
    if (city) intent.params.city_raw = city;
    intent.prompt_blocks = ['calendar'];
    return intent;
  }

  // 11. SUBSTITUTION / MEDICINE without a fast — still a food journey,
  //     just load the matching block(s).
  if (isSubstitute || isMedicine) {
    intent.journey = 'food';
    intent.prompt_blocks = ['general'];
    if (isSubstitute) intent.prompt_blocks.push('substitution');
    if (isMedicine) intent.prompt_blocks.push('medicine');
    const food = extractFoodText(text);
    if (food) intent.params.food_text = food;
    return intent;
  }

  // 12. OFFTOPIC — last resort. Only if a genuinely-unrelated signal fired
  //     and nothing on-topic matched above.
  if (RE_OFFTOPIC.test(lower) && !hasFoodIntent) {
    intent.journey = 'offtopic';
    intent.prompt_blocks = [];
    return intent;
  }

  // 13. DEFAULT — treat as a food question. This is the safe fallback:
  //     a stray on-topic message ("paneer?", "what about jaggery") becomes
  //     a food verdict rather than a rejection.
  intent.journey = 'food';
  intent.prompt_blocks = ['general'];
  const food = extractFoodText(text);
  if (food) intent.params.food_text = food;
  return intent;
}
