// ============================================
// fasting-rules.js — code-driven fast rules + menu (flat: top 7)
// ============================================
// Deterministic. Code emits the menu and rules verbatim — the model never
// touches this flow (Haiku drifts on fixed menus). Option 8 (complex fasts)
// falls through to the prompt, which owns that sub-tree.
// Video links are placeholders for now — swap real URLs in RESOURCE below.
// ============================================

const ELDERS = `Your family's tradition may differ — confirm with your community elders 🙏`;
const RESOURCE = `Here is a helpful resource: [video coming soon]`;

// category → short rules text (copied from prompts.js USE_CASE_FASTING)
const FAST_RULES = {
  upvas:     `*Upvas* — water or boiled water only. No food whatsoever.`,
  ekasan:    `*Ekasan* — one meal only, eaten before sunset. Full Jain dietary rules apply. No snacking before or after.`,
  ayambil:   `*Ayambil* — one bland meal. No dairy, oil, sugar, spices, or green vegetables. Only grains and pulses.`,
  biyasan:   `*Biyasan* — two meals only, both before sunset. Full Jain dietary rules apply to both.`,
  chauvihar: `*Chauvihar* — nothing after sunset, including water. Before sunset, full Jain rules apply.`,
  tivihar:   `*Tivihar* — nothing after sunset except boiled water. Before sunset, full Jain rules apply.`,
  navkarsi:  `*Navkarsi* — no food or water for 48 minutes after sunrise. After that, full Jain rules apply.`,
};

const MENU_NUM = {
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

You can also type the name of your fast, or just ask something else 🙏`;

// 8 — More complex fasts

// Build the full reply for a known flat fast. null if not a flat-menu fast.
export function rulesFor(category) {
  const r = FAST_RULES[category];
  if (!r) return null;
  return `${r}\n\n${RESOURCE}\n\n${ELDERS}`;
}

// number 1-7 → rules. 8+ / invalid → null (caller lets prompt handle).
export function rulesForNumber(n) {
  const cat = MENU_NUM[n];
  return cat ? rulesFor(cat) : null;
}
