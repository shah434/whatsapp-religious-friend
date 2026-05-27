// ============================================
// fasting-rules.js — code-driven fast rules + menu (flat: top 7)
// ============================================
// Deterministic. Code emits the menu and rules verbatim — the model never
// touches this flow (Haiku drifts on fixed menus). Option 8 (complex fasts)
// falls through to the prompt, which owns that sub-tree.
// Video links are placeholders for now — swap real URLs in RESOURCE below.
// ============================================

const ELDERS = `Your family's tradition may differ — confirm with your community elders 🙏`;

// Per-fast YouTube resource links
const RESOURCES = {
  upvas_chovihar: `You can find the pachkhan here: 🎥 https://youtu.be/HbOW_otXCbA?si=2vffo2s2SjlQiGF3`,
  upvas_tivihar:  `You can find the pachkhan here: 🎥 https://youtu.be/Au27vybub2w?si=Oe5tyJwgTdovt5v8`,
  ekasan:         `You can find the pachkhan here: 🎥 https://youtu.be/aNsVfkYH-go`,
  ayambil:        `You can find the pachkhan here: 🎥 https://youtu.be/gA5qocBjQB8?si=9bacIZU3JgIkW8IR`,
  biyasan:        `You can find the pachkhan here: 🎥 https://youtu.be/aNsVfkYH-go`,
  chauvihar:      `You can find the pachkhan here: 🎥 https://youtu.be/2mleQQW5ML8?si=F4-ZRyjk_mBbQJYZ`,
  tivihar:        `You can find the pachkhan here: 🎥 https://youtu.be/zooJU5gN810?si=VIPXpmrZSBDjAPvD`,
  navkarsi:       `You can find the pachkhan here: 🎥 https://youtu.be/7xcyNkR1t64`,
};

// category → short rules text (copied from prompts.js USE_CASE_FASTING)
const FAST_RULES = {
  upvas_chovihar: `*Upvas Chovihar* — complete fast, no food and no water at all.`,
  upvas_tivihar:  `*Upvas Tivihar* — complete fast, no food whatsoever. Boiled water is allowed throughout the day.`,
  ekasan:    `*Ekasan* — one meal only, eaten before sunset. Full Jain dietary rules apply. No snacking before or after.`,
  ayambil:   `*Ayambil* — one bland meal. No dairy, oil, sugar, spices, or green vegetables. Only grains and pulses.`,
  biyasan:   `*Biyasan* — two meals only, both before sunset. Full Jain dietary rules apply to both.`,
  chauvihar: `*Chauvihar* — nothing after sunset, including water. Before sunset, full Jain rules apply.`,
  tivihar:   `*Tivihar* — nothing after sunset except boiled water. Before sunset, full Jain rules apply.`,
  navkarsi:  `*Navkarsi* — no food or water for 48 minutes after sunrise. After that, full Jain rules apply.`,
};

const MENU_NUM = {
  1: 'upvas_chovihar', 2: 'upvas_tivihar', 3: 'ekasan', 4: 'ayambil',
  5: 'biyasan', 6: 'chauvihar', 7: 'tivihar', 8: 'navkarsi',
};

export const UPVAS_MENU = `Which type of Upvas?

1 — Upvas Chovihar (no food, no water at all)
2 — Upvas Tivihar (no food, boiled water allowed)

Type 1, 2, or the name 🙏`;

export const FAST_MENU = `What fast are you observing?

1 — Upvas Chovihar (no food, no water at all)
2 — Upvas Tivihar (no food, boiled water allowed)
3 — Ekasan (one meal before sunset)
4 — Ayambil (bland meal, no dairy/oil)
5 — Biyasan (two meals before sunset)
6 — Chauvihar (nothing after sunset, including water)
7 — Tivihar (nothing after sunset, boiled water ok)
8 — Navkarsi (no food 48 min after sunrise)

You can also type the name of your fast, or just ask something else 🙏`;

// Build the full reply for a known flat fast. null if not a flat-menu fast.
export function rulesFor(category) {
  const r = FAST_RULES[category];
  if (!r) return null;
  const link = RESOURCES[category];
  return `${r}${link ? `\n\n${link}` : ''}\n\n${ELDERS}`;
}

// number 1-8 → rules. 9+ / invalid → null (caller lets prompt handle).
export function rulesForNumber(n) {
  const cat = MENU_NUM[n];
  return cat ? rulesFor(cat) : null;
}
