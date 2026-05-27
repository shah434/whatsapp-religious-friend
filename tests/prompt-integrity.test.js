// ============================================
// prompt-integrity.test.js — guard rails on prompts.js
// Run: npm test
// ============================================
// No network, no Claude calls. These tests assert that the dietary rules,
// safety overrides, and structural markers in prompts.js haven't been
// accidentally edited or deleted. They catch the most common failure mode:
// someone refactors a prompt block and silently removes a critical rule.
// ============================================

import { describe, it, expect } from 'vitest';
import {
  CORE_IDENTITY,
  RULES_JAIN,
  RULES_BAPS,
  USE_CASE_FASTING,
  USE_CASE_CALENDAR,
  USE_CASE_LABEL_SCAN,
} from '../src/prompts.js';

// ── CORE_IDENTITY ───────────────────────────────────────────────────────────
describe('CORE_IDENTITY — always-banned food override', () => {
  it('contains the hard override rule heading', () => {
    expect(CORE_IDENTITY).toContain('ALWAYS-BANNED FOODS OVERRIDE EVERYTHING');
  });

  it('lists all always-banned foods in the override rule', () => {
    // These must appear together — if any one is dropped, the override is incomplete
    for (const food of ['meat', 'fish', 'egg', 'honey', 'gelatin', 'alcohol']) {
      expect(CORE_IDENTITY.toLowerCase()).toContain(food);
    }
  });

  it('instructs Claude to name only the always-banned food and nothing else', () => {
    expect(CORE_IDENTITY).toContain('Name nothing else');
  });

});

// ── RULES_JAIN ──────────────────────────────────────────────────────────────
describe('RULES_JAIN — always-banned E-numbers', () => {
  it('lists E120 as Tier 1 always not safe', () => {
    expect(RULES_JAIN).toContain('E120');
  });

  it('lists E542 as Tier 1 always not safe', () => {
    expect(RULES_JAIN).toContain('E542');
  });

  it('lists E441 (gelatin) as Tier 3 not permitted', () => {
    expect(RULES_JAIN).toContain('E441');
  });

  it('lists E904 (shellac) as Tier 3 not permitted', () => {
    expect(RULES_JAIN).toContain('E904');
  });
});

describe('RULES_JAIN — onion and garlic strictness', () => {
  it('marks onion/garlic as NOT PERMITTED at strict', () => {
    // The rule must be explicit — not just "flag"
    expect(RULES_JAIN).toMatch(/strict.*NOT PERMITTED/is);
  });

  it('marks onion/garlic as PERMITTED at flexible', () => {
    expect(RULES_JAIN).toMatch(/flexible.*PERMITTED/is);
  });
});

describe('RULES_JAIN — root vegetables', () => {
  it('lists potato as a root vegetable', () => {
    expect(RULES_JAIN.toLowerCase()).toContain('potato');
  });

  it('marks root veg as NOT PERMITTED at strict', () => {
    expect(RULES_JAIN).toContain('strict: NOT PERMITTED');
  });

  it('marks root veg as PERMITTED at moderate', () => {
    expect(RULES_JAIN).toContain('moderate: PERMITTED');
  });
});

describe('RULES_JAIN — Paryushana override', () => {
  it('contains Paryushana override section', () => {
    expect(RULES_JAIN).toContain('PARYUSHANA OVERRIDE');
  });

  it('defers Paryushana edge cases to community elders', () => {
    expect(RULES_JAIN).toContain('confirm with your community elders');
  });
});

// ── RULES_BAPS ──────────────────────────────────────────────────────────────
describe('RULES_BAPS — key differences from Jain', () => {
  it('explicitly permits root vegetables for ALL BAPS levels', () => {
    expect(RULES_BAPS).toContain('PERMITTED for ALL BAPS levels');
  });

  it('says never flag root veg for BAPS users', () => {
    expect(RULES_BAPS).toContain('never flag for BAPS users');
  });

  it('explicitly permits mushrooms for ALL BAPS levels', () => {
    expect(RULES_BAPS).toContain('Permitted for ALL BAPS levels');
  });

  it('contains Ekadashi farari section', () => {
    expect(RULES_BAPS).toContain('EKADASHI FARARI FOODS');
  });

  it('lists sabudana as permitted on Ekadashi', () => {
    expect(RULES_BAPS.toLowerCase()).toContain('sabudana');
  });
});

// ── USE_CASE_FASTING ─────────────────────────────────────────────────────────
describe('USE_CASE_FASTING — code-driven menu note', () => {
  // Common fasts are code-driven — Claude should be told it never sees them.
  it('tells Claude common fasts are code-handled', () => {
    expect(USE_CASE_FASTING).toContain('code-handled before you are called');
  });

  it('still contains Ekasan rules in FAST TYPE RULES', () => {
    expect(USE_CASE_FASTING).toContain('Ekasan:');
  });

  it('still contains Ayambil rules in FAST TYPE RULES', () => {
    expect(USE_CASE_FASTING).toContain('Ayambil:');
  });

  it('still contains Navkarsi rules in FAST TYPE RULES', () => {
    expect(USE_CASE_FASTING).toContain('Navkarsi:');
  });

  it('contains complex fasts sub-menu', () => {
    expect(USE_CASE_FASTING).toContain('Time-based eating windows (Porsi');
  });
});

describe('USE_CASE_FASTING — Jain/BAPS separation', () => {
  it('warns never to use Ekadashi for Jain users', () => {
    expect(USE_CASE_FASTING).toContain('Never use the word Ekadashi for Jain users');
  });

  it('warns Ekadashi is BAPS only', () => {
    expect(USE_CASE_FASTING).toContain('Ekadashi is a BAPS observance');
  });
});

// ── USE_CASE_CALENDAR ────────────────────────────────────────────────────────
describe('USE_CASE_CALENDAR — tithi guard', () => {
  it('contains TODAY_IS_TITHI: true marker', () => {
    expect(USE_CASE_CALENDAR).toContain('TODAY_IS_TITHI: true');
  });

  it('contains TODAY_IS_TITHI: false marker', () => {
    expect(USE_CASE_CALENDAR).toContain('TODAY_IS_TITHI: false');
  });

  it('instructs Claude NEVER to mention tithi unless calendar confirms it', () => {
    expect(USE_CASE_CALENDAR).toContain('NEVER mention today\'s tithi');
  });

  it('forbids estimating tithi from training data', () => {
    expect(USE_CASE_CALENDAR).toContain('Inferring tithi from training data');
  });

  it('instructs Claude to copy sunset time verbatim', () => {
    expect(USE_CASE_CALENDAR).toContain('time string verbatim');
  });
});

// ── USE_CASE_LABEL_SCAN ──────────────────────────────────────────────────────
describe('USE_CASE_LABEL_SCAN — always-flag ingredients', () => {
  it('flags gelatin', () => {
    expect(USE_CASE_LABEL_SCAN.toLowerCase()).toContain('gelatin');
  });

  it('flags carmine / E120', () => {
    expect(USE_CASE_LABEL_SCAN.toLowerCase()).toContain('carmine');
    expect(USE_CASE_LABEL_SCAN).toContain('E120');
  });

  it('flags honey', () => {
    expect(USE_CASE_LABEL_SCAN.toLowerCase()).toContain('honey');
  });

  it('flags natural flavors as uncertain', () => {
    expect(USE_CASE_LABEL_SCAN.toLowerCase()).toContain('natural flavors');
  });

  it('flags Vitamin D3 as uncertain', () => {
    expect(USE_CASE_LABEL_SCAN).toContain('Vitamin D3');
  });
});
