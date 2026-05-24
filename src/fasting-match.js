// ============================================
// fasting-rules.js — code-driven fast rules + menu (flat: top 7)
// ============================================
// Deterministic. Named fast → its rules. Bare fasting → the 7-option menu.
// Number reply 1-7 → that fast's rules. Option 8 (complex) → handled by prompt.
// Rules text copied verbatim from prompts.js USE_CASE_FASTING.
// ============================================

const ELDERS = `\n\nYour family's tradition may differ — confirm with your community elders 🙏`;

// category → rules text
export const FAST_RULES = {
  upvas:     `*Upvas* — water or boiled water only. No food whatsoever.`,
  ekasan:    `*Ekasan* — one meal only, eaten before sunset. Full Jain dietary rules apply. No snacking before or after.`,
  ayambil:   `*Ayambil* — one bland meal. No dairy, oil, sugar, spices, or green vegetables. Only grains and pulses.`,
  biyasan:   `*Biyasan* — two meals only, both before sunset. Full Jain dietary rules apply to both.`,
  chauvihar: `*Chauvihar* — nothing after sunset, including water. Before sunset, full Jain rules apply.`,
  tivihar:   `*Tivihar* — nothing after sunset except boiled water. Before sunset, full Jain rules apply.`,
  navkarsi:  `*Navkarsi* — no food or water for 48 minutes after sunrise. After that, full Jain rules apply.`,
};

// menu number → category
const MENU = {
  1: 'upvas', 2: 'ekasan', 3: 'ayambil', 4: 'biyasan',
  5: 'chauvihar', 6: 'tivihar', 7: 'navkarsi',
};

export const FAST_MENU = `What fast are you observing?

1 — Upvas (no food)
2 — Ekasan (one meal before sunset)
3 — Ayambil (bland meal, no dairy/oil)
4 — Biyasan (two meals before sunset)
5 — Chauvihar (no food or water after sunset)
6 — Tivihar (water only after sunset)
7 — Navkarsi (no food 48 min after sunrise)
8 — More complex fasts

You can also type the name of your fast, or just ask something else 🙏`;

// Rules for a known category, or null if not a flat-menu fast.
export function rulesFor(category) {
  const r = FAST_RULES[category];
  return r ? r + ELDERS : null;
}

// Map a menu number (1-7) to rules. 8+ or invalid → null.
export function rulesForNumber(n) {
  const cat = MENU[n];
  return cat ? rulesFor(cat) : null;
}
