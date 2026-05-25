// ============================================
// route-fallback.js — Claude journey router (fallback only)
// ============================================
// Runs ONLY when classify() defaulted to 'food' with no clear food signal —
// i.e. an ambiguous message nothing matched. Asks Haiku to pick the journey
// and pull a city if present. Output is validated; junk falls back to food.
// ============================================
import { callClaude } from './claude.js';

const VALID = new Set(['food', 'tithi', 'sunset', 'restaurant', 'pachkhan', 'offtopic']);

const ROUTER_PROMPT = `You are a router for a Jain/vegetarian WhatsApp bot. Read the user message and reply ONLY with compact JSON, no other text:
{"journey":"<one of: food|tithi|sunset|restaurant|pachkhan|offtopic>","city":"<city name if the message names one, else empty>"}

Rules:
- restaurant: asking where to eat / find places / food spots in a location.
- sunset: asking sunset/sunrise time.
- tithi: asking if today is a fast day / tithi / religious calendar.
- pachkhan: asking the RULES of a fast (no specific food named).
- food: asking if a specific food/ingredient/product is safe to eat.
- offtopic: unrelated to diet/fasting/food (sports, politics, code, chitchat).
- city: only if the message explicitly names a place. Else "".
Reply with JSON only.`;

// Returns { journey, city } or null on any failure (caller keeps food default).
export async function routeFallback(text, env) {
  try {
    const raw = await callClaude(
      [{ role: 'user', content: text }],
      ROUTER_PROMPT,
      env
    );
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (!VALID.has(parsed.journey)) return null;
    const city = typeof parsed.city === 'string' ? parsed.city.trim() : '';
    return { journey: parsed.journey, city: city || null };
  } catch (err) {
    console.log(`[router] fail err=${err.message}`);
    return null;
  }
}
