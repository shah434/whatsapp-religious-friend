// ============================================
// unit.test.js — Pure function tests for Samta
// Covers: classify (classify.js), stripTags (utils.js),
//         detectFastTerm (fasting-match.js),
//         readPending/serializePending (pending.js),
//         cityJourneyClaims (rebuild-city-journey.js)
// Run: npm test
// ============================================

import { describe, it, expect } from 'vitest';
import { stripTags } from '../src/utils.js';
import { classify } from '../src/classify.js';
import { detectFastTerm } from '../src/fasting-match.js';

// ============================================
// profile_update journey (classify)
// ============================================

describe('profile_update journey', () => {

  it('"make me strict" → profile_update, strictness_level: strict', () => {
    const r = classify('make me strict');
    expect(r.journey).toBe('profile_update');
    expect(r.params.strictness_level).toBe('strict');
    expect(r.prompt_blocks).toEqual([]);
  });

  it('"set me to moderate" → profile_update', () => {
    const r = classify('set me to moderate');
    expect(r.journey).toBe('profile_update');
    expect(r.params.strictness_level).toBe('moderate');
  });

  it('"I\'m flexible" → profile_update', () => {
    const r = classify("I'm flexible");
    expect(r.journey).toBe('profile_update');
    expect(r.params.strictness_level).toBe('flexible');
  });

  it('"I\'m BAPS" → profile_update, community: baps', () => {
    const r = classify("I'm BAPS");
    expect(r.journey).toBe('profile_update');
    expect(r.params.community).toBe('baps');
  });

  it('"I\'m Jain" → profile_update, community: jain', () => {
    const r = classify("I'm Jain");
    expect(r.journey).toBe('profile_update');
    expect(r.params.community).toBe('jain');
  });

  it('"switch me to BAPS" → profile_update', () => {
    const r = classify('switch me to BAPS');
    expect(r.journey).toBe('profile_update');
    expect(r.params.community).toBe('baps');
  });

  it('"I\'m Jain, can I eat paneer?" stays food (not profile_update)', () => {
    const r = classify("I'm Jain, can I eat paneer?");
    expect(r.journey).not.toBe('profile_update');
  });
});

// ============================================
// stripTags
// ============================================

describe('stripTags', () => {

  it('returns text unchanged when no tags present', () => {
    const text = '✅ SAFE — tofu is fine at all levels 🙏';
    expect(stripTags(text)).toBe(text);
  });

  it('trims leading/trailing whitespace', () => {
    expect(stripTags('  Some response  ')).toBe('Some response');
  });

  it('handles empty string', () => {
    expect(stripTags('')).toBe('');
  });
});

// ============================================
// detectFastTerm
// ============================================

describe('detectFastTerm', () => {

  // --- Exact matches ---
  it('"ayambil" → matched, category ayambil', () => {
    const r = detectFastTerm('ayambil');
    expect(r.matched).toBe(true);
    expect(r.category).toBe('ayambil');
  });

  it('"pachkhan" → matched, category pachkhan_general', () => {
    const r = detectFastTerm('pachkhan');
    expect(r.matched).toBe(true);
    expect(r.category).toBe('pachkhan_general');
  });

  it('"porsi" → matched, category porsi', () => {
    const r = detectFastTerm('porsi');
    expect(r.matched).toBe(true);
    expect(r.category).toBe('porsi');
  });

  it('"upvas" → matched, category upvas', () => {
    const r = detectFastTerm('upvas');
    expect(r.matched).toBe(true);
    expect(r.category).toBe('upvas');
  });

  it('"atthai" → matched, category atthai', () => {
    const r = detectFastTerm('atthai');
    expect(r.matched).toBe(true);
    expect(r.category).toBe('atthai');
  });

  // --- Spelling variants (exact in FAST_TERMS) ---
  it('"ayambhil" → matched, category ayambil', () => {
    const r = detectFastTerm('ayambhil');
    expect(r.matched).toBe(true);
    expect(r.category).toBe('ayambil');
  });

  it('"porsee" → matched, category porsi', () => {
    const r = detectFastTerm('porsee');
    expect(r.matched).toBe(true);
    expect(r.category).toBe('porsi');
  });

  it('"porasi" → matched, category porsi', () => {
    const r = detectFastTerm('porasi');
    expect(r.matched).toBe(true);
    expect(r.category).toBe('porsi');
  });

  it('"navakarsi" → matched, category navkarsi', () => {
    const r = detectFastTerm('navakarsi');
    expect(r.matched).toBe(true);
    expect(r.category).toBe('navkarsi');
  });

  it('"pacchakhan" → matched, category pachkhan_general', () => {
    const r = detectFastTerm('pacchakhan');
    expect(r.matched).toBe(true);
    expect(r.category).toBe('pachkhan_general');
  });

  // --- Gujarati script ---
  it('Gujarati "પચ્ચક્ખાણ" → matched, category pachkhan_general', () => {
    const r = detectFastTerm('પચ્ચક્ખાણ');
    expect(r.matched).toBe(true);
    expect(r.category).toBe('pachkhan_general');
  });

  it('Gujarati "પચખાણ" → matched, category pachkhan_general', () => {
    const r = detectFastTerm('પચખાણ');
    expect(r.matched).toBe(true);
    expect(r.category).toBe('pachkhan_general');
  });

  // --- Term embedded in a sentence ---
  it('fast term in a sentence is found', () => {
    const r = detectFastTerm('I am doing ayambhil today, what can I eat?');
    expect(r.matched).toBe(true);
    expect(r.category).toBe('ayambil');
  });

  // --- No match ---
  it('"tofu" → no match', () => {
    expect(detectFastTerm('tofu').matched).toBe(false);
  });

  it('"is this safe" → no match', () => {
    expect(detectFastTerm('is this safe').matched).toBe(false);
  });

  it('null → no match, no crash', () => {
    const r = detectFastTerm(null);
    expect(r.matched).toBe(false);
  });

  it('empty string → no match', () => {
    expect(detectFastTerm('').matched).toBe(false);
  });

  // --- Short tokens skipped (< 4 chars) ---
  it('very short tokens do not false-positive', () => {
    expect(detectFastTerm('eat').matched).toBe(false);
  });
});
