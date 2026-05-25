// ============================================
// test-classify.js — unit tests for the v3.1 classifier
// Run: node test/test-classify.js 
// ============================================
import { classify } from '../src/classify.js';

let pass = 0, fail = 0;
const fails = [];

// check journey, and optionally that certain params/prompt_blocks are present
function t(desc, msg, hasImage, expectJourney, opts = {}) {
  const intent = classify(msg, hasImage);
  const probs = [];
  if (intent.journey !== expectJourney)
    probs.push(`journey=${intent.journey} want=${expectJourney}`);
  if (opts.fast_term && intent.params.fast_term !== opts.fast_term)
    probs.push(`fast_term=${intent.params.fast_term} want=${opts.fast_term}`);
  if (opts.fast_term === false && intent.params.fast_term)
    probs.push(`fast_term=${intent.params.fast_term} want=none`);
  if (opts.blocks)
    for (const b of opts.blocks)
      if (!intent.prompt_blocks.includes(b)) probs.push(`missing block ${b} (got ${intent.prompt_blocks.join('+')})`);
  if (opts.noBlocks)
    for (const b of opts.noBlocks)
      if (intent.prompt_blocks.includes(b)) probs.push(`unwanted block ${b}`);
  if (opts.city && intent.params.city_raw !== opts.city)
    probs.push(`city_raw=${intent.params.city_raw} want=${opts.city}`);

  if (probs.length) { fail++; fails.push(`✗ ${desc}\n    "${msg}"\n    ${probs.join('; ')}`); }
  else pass++;
}

// ── THE CRITICAL CASE: food during fast → food, NOT pachkhan/calendar ──────
// fasting block loads (so model can deny), but journey stays food.
t('potato during ayambil → food', 'can I eat potato during ayambil', false, 'food',
  { fast_term: 'ayambil', blocks: ['fasting'], noBlocks: ['calendar'] });
t('rice on upvas → food', 'is rice ok on upvas?', false, 'food',
  { fast_term: 'upvas', blocks: ['fasting'] });
t('substitute ghee during fast → food + substitution + fasting', 'what can I substitute for ghee during my fast', false, 'food',
  { blocks: ['fasting', 'substitution'] });
t('medicine during paryushana → food + medicine + fasting', 'can I take this capsule during paryushana', false, 'food',
  { fast_term: 'paryushana', blocks: ['fasting', 'medicine'] });

// ── PACHKHAN: rules question, no specific food ──────────────────────────────
t('what is ayambil → pachkhan', 'what is ayambil', false, 'pachkhan', { fast_term: 'ayambil' });
t('what can I eat during upvas → pachkhan', 'what can I eat during upvas', false, 'pachkhan',
  { fast_term: 'upvas', noBlocks: ['calendar'] });
t('fuzzy ayambhil rules → pachkhan', 'tell me about ayambhil', false, 'pachkhan', { fast_term: 'ayambil' });

// ── BARE TOPIC WORDS: open a journey, never offtopic ────────────────────────
t('bare pachkhan', 'pachkhan', false, 'pachkhan');
t('bare pachkhan gujarati', 'પચ્ચક્ખાણ', false, 'pachkhan');
t('bare calendar → tithi', 'calendar', false, 'tithi');
t('bare tithi', 'tithi', false, 'tithi');
t('bare sunset', 'sunset', false, 'sunset');
t('bare restaurants', 'restaurants', false, 'restaurant');
t('bare medicine → food', 'medicine', false, 'food');
t('bare label → food', 'label', false, 'food');
t('bare substitution → food', 'substitution', false, 'food');

// ── GREETING: only bare greetings ───────────────────────────────────────────
t('bare hi → greeting', 'hi', false, 'greeting');
t('jai jinendra → greeting', 'Jai Jinendra', false, 'greeting');
t('greeting + question is NOT greeting', 'hi can I eat paneer', false, 'food');

// ── SUNSET / SUNRISE ────────────────────────────────────────────────────────
t('sunset in london', 'what time is sunset in London', false, 'sunset', { city: 'London' });
t('sunrise tomorrow', 'when is sunrise', false, 'sunset'); // sun_kind sunrise, journey sunset
t('sunset → sun_kind set', 'sunset today', false, 'sunset');

// ── RESTAURANT ──────────────────────────────────────────────────────────────
t('restaurants in NYC', 'find jain restaurants in New York', false, 'restaurant', { city: 'New York' });
t('where to eat', 'where can I eat near me', false, 'restaurant');

// ── CALENDAR / TITHI (no fast term) ─────────────────────────────────────────
t('is today a tithi → tithi', 'is today a special day', false, 'tithi');
t('whats the tithi today', "what's the tithi today", false, 'tithi');

// ── PLAIN FOOD ──────────────────────────────────────────────────────────────
t('can I eat paneer → food, no fast', 'can I eat paneer', false, 'food', { fast_term: false });
t('is gelatin jain → food', 'is gelatin jain safe', false, 'food');
t('bare food noun → food', 'jaggery?', false, 'food');

// ── IMAGE: always food/label scan ───────────────────────────────────────────
t('image no caption → food/label', '', true, 'food', { blocks: ['label_scan'] });
t('image + fast caption → food/label + fasting', 'during ayambil?', true, 'food',
  { fast_term: 'ayambil', blocks: ['label_scan', 'fasting'] });

// ── ACCOUNT ─────────────────────────────────────────────────────────────────
t('delete me → account', 'delete me', false, 'account');
t('remove my data → account', 'please remove my data', false, 'account');

// ── OFFTOPIC: genuinely unrelated only ──────────────────────────────────────
t('football → offtopic', 'who won the football last night', false, 'offtopic');
t('write code → offtopic', 'write me some python code', false, 'offtopic');
// guard: an on-topic word near an offtopic word should NOT be offtopic
t('cricket-flour edge stays food-ish', 'can I eat this during the cricket match', false, 'food');

// ── REGRESSION: food-intent overrides offtopic ──────────────────────────────
t('movie snack question → food not offtopic', 'can I eat popcorn at the movie', false, 'food');

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fails.length) { console.log(fails.join('\n\n')); process.exit(1); }
