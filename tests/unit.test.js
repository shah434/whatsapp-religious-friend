// ============================================
// unit.test.js — Pure function tests for Samta
// Covers: classifyQuery, parseProfileUpdate,
//         stripTags (utils.js), detectFastTerm
//         (fasting-match.js)
// Run: npm test
// ============================================

import { describe, it, expect } from 'vitest';
import { classifyQuery, parseProfileUpdate, stripTags } from '../src/utils.js';
import { detectFastTerm } from '../src/fasting-match.js';

// ============================================
// classifyQuery
// ============================================

describe('classifyQuery', () => {

  // --- Image ---
  it('image with no text → label_scan', () => {
    expect(classifyQuery('', true)).toContain('label_scan');
  });

  it('image with text → label_scan included', () => {
    const result = classifyQuery('is this safe?', true);
    expect(result).toContain('label_scan');
  });

  // --- Restaurant ---
  it('"restaurant near me" → restaurant', () => {
    expect(classifyQuery('restaurant near me', false)).toContain('restaurant');
  });

  it('"where to eat in chicago" → restaurant', () => {
    expect(classifyQuery('where to eat in chicago', false)).toContain('restaurant');
  });

  it('"find jain food nearby" → restaurant', () => {
    expect(classifyQuery('find jain food nearby', false)).toContain('restaurant');
  });

  // --- Substitution ---
  it('"substitute for onion" → substitution', () => {
    expect(classifyQuery('substitute for onion', false)).toContain('substitution');
  });

  it('"what can I use instead of garlic" → substitution', () => {
    expect(classifyQuery('what can I use instead of garlic', false)).toContain('substitution');
  });

  // --- Medicine ---
  it('"is my vitamin safe" → medicine', () => {
    expect(classifyQuery('is my vitamin safe', false)).toContain('medicine');
  });

  it('"can I take this supplement" → medicine', () => {
    expect(classifyQuery('can I take this supplement', false)).toContain('medicine');
  });

  it('"is this capsule jain safe" → medicine', () => {
    expect(classifyQuery('is this capsule jain safe', false)).toContain('medicine');
  });

  // --- Fasting (English keywords) ---
  it('"I am fasting today" → fasting', () => {
    expect(classifyQuery('I am fasting today', false)).toContain('fasting');
  });

  it('"paryushan is coming up" → fasting', () => {
    expect(classifyQuery('paryushan is coming up', false)).toContain('fasting');
  });

  it('"ekadashi tomorrow" → fasting', () => {
    expect(classifyQuery('ekadashi tomorrow', false)).toContain('fasting');
  });

  // --- Fasting (fuzzy match via detectFastTerm) ---
  it('"porsee" → fasting via fuzzy match', () => {
    expect(classifyQuery('porsee', false)).toContain('fasting');
  });

  it('"ayambhil" → fasting via fuzzy match', () => {
    expect(classifyQuery('ayambhil', false)).toContain('fasting');
  });

  it('"pachkhan" → fasting via fuzzy match', () => {
    expect(classifyQuery('pachkhan', false)).toContain('fasting');
  });

  it('Gujarati "પચ્ચક્ખાણ" → fasting', () => {
    expect(classifyQuery('પચ્ચક્ખાણ', false)).toContain('fasting');
  });

  // --- Calendar ---
  it('"what tithi is today" → calendar', () => {
    expect(classifyQuery('what tithi is today', false)).toContain('calendar');
  });

  it('"sunset in chicago" → calendar', () => {
    expect(classifyQuery('sunset in chicago', false)).toContain('calendar');
  });

  it('"what time is sunrise" → calendar', () => {
    expect(classifyQuery('what time is sunrise', false)).toContain('calendar');
  });

  // --- General fallback ---
  it('"is tofu safe" → general', () => {
    expect(classifyQuery('is tofu safe', false)).toContain('general');
  });

  it('empty text, no image → general', () => {
    expect(classifyQuery('', false)).toContain('general');
  });

  it('null text → general', () => {
    expect(classifyQuery(null, false)).toContain('general');
  });

  // --- Multi-type ---
  it('"substitute for onion during my fast" → substitution + fasting', () => {
    const result = classifyQuery('substitute for onion during my fast', false);
    expect(result).toContain('substitution');
    expect(result).toContain('fasting');
  });

  it('"restaurant near me, I am fasting" → restaurant + fasting', () => {
    const result = classifyQuery('restaurant near me, I am fasting', false);
    expect(result).toContain('restaurant');
    expect(result).toContain('fasting');
  });

  // --- No duplicates ---
  it('returns no duplicate keys', () => {
    const result = classifyQuery('substitute for onion during my fast', false);
    expect(result.length).toBe(new Set(result).size);
  });
});

// ============================================
// parseProfileUpdate
// ============================================

describe('parseProfileUpdate', () => {

  it('parses STRICTNESS_UPDATE: strict', () => {
    const r = parseProfileUpdate('Got it 🙏 [STRICTNESS_UPDATE: strict]');
    expect(r.strictness).toBe('strict');
    expect(r.community).toBeNull();
    expect(r.city).toBeNull();
  });

  it('parses STRICTNESS_UPDATE: moderate', () => {
    expect(parseProfileUpdate('[STRICTNESS_UPDATE: moderate]').strictness).toBe('moderate');
  });

  it('parses STRICTNESS_UPDATE: flexible', () => {
    expect(parseProfileUpdate('[STRICTNESS_UPDATE: flexible]').strictness).toBe('flexible');
  });

  it('parses COMMUNITY_UPDATE: baps', () => {
    const r = parseProfileUpdate('Updated 🙏 [COMMUNITY_UPDATE: baps]');
    expect(r.community).toBe('baps');
    expect(r.strictness).toBeNull();
  });

  it('parses COMMUNITY_UPDATE: jain', () => {
    expect(parseProfileUpdate('[COMMUNITY_UPDATE: jain]').community).toBe('jain');
  });

  it('parses CITY_UPDATE with plain city', () => {
    expect(parseProfileUpdate('[CITY_UPDATE: Chicago]').city).toBe('Chicago');
  });

  it('parses CITY_UPDATE with multi-word city', () => {
    expect(parseProfileUpdate('[CITY_UPDATE: New York]').city).toBe('New York');
  });

  it('trims whitespace from CITY_UPDATE', () => {
    expect(parseProfileUpdate('[CITY_UPDATE:  San Francisco  ]').city).toBe('San Francisco');
  });

  it('parses all three tags in one response', () => {
    const text = 'All updated! [STRICTNESS_UPDATE: moderate] [COMMUNITY_UPDATE: baps] [CITY_UPDATE: Dallas]';
    const r = parseProfileUpdate(text);
    expect(r.strictness).toBe('moderate');
    expect(r.community).toBe('baps');
    expect(r.city).toBe('Dallas');
  });

  it('returns all nulls when no tags present', () => {
    const r = parseProfileUpdate('✅ SAFE — tofu is fine at all levels 🙏');
    expect(r.strictness).toBeNull();
    expect(r.community).toBeNull();
    expect(r.city).toBeNull();
  });

  it('case-insensitive tag matching', () => {
    expect(parseProfileUpdate('[strictness_update: strict]').strictness).toBe('strict');
    expect(parseProfileUpdate('[COMMUNITY_UPDATE: BAPS]').community).toBe('BAPS');
  });

  it('invalid strictness value → null (not in allowed list)', () => {
    expect(parseProfileUpdate('[STRICTNESS_UPDATE: very_strict]').strictness).toBeNull();
  });

  it('handles empty string input', () => {
    const r = parseProfileUpdate('');
    expect(r.strictness).toBeNull();
    expect(r.community).toBeNull();
    expect(r.city).toBeNull();
  });
});

// ============================================
// stripTags
// ============================================

describe('stripTags', () => {

  it('strips STRICTNESS_UPDATE tag', () => {
    const result = stripTags('Got it 🙏 [STRICTNESS_UPDATE: strict]');
    expect(result).toBe('Got it 🙏');
    expect(result).not.toContain('[STRICTNESS_UPDATE');
  });

  it('strips COMMUNITY_UPDATE tag', () => {
    const result = stripTags('Updated [COMMUNITY_UPDATE: baps]');
    expect(result).toBe('Updated');
  });

  it('strips CITY_UPDATE tag', () => {
    const result = stripTags('Got it — updated your city to Chicago. [CITY_UPDATE: Chicago]');
    expect(result).not.toContain('[CITY_UPDATE');
  });

  it('strips all three tags from one response', () => {
    const text = 'All done! [STRICTNESS_UPDATE: moderate] [COMMUNITY_UPDATE: baps] [CITY_UPDATE: Dallas]';
    const result = stripTags(text);
    expect(result).not.toContain('[STRICTNESS_UPDATE');
    expect(result).not.toContain('[COMMUNITY_UPDATE');
    expect(result).not.toContain('[CITY_UPDATE');
    expect(result).toBe('All done!');
  });

  it('returns text unchanged when no tags present', () => {
    const text = '✅ SAFE — tofu is fine at all levels 🙏';
    expect(stripTags(text)).toBe(text);
  });

  it('trims leading/trailing whitespace after stripping', () => {
    const result = stripTags('[CITY_UPDATE: Austin] Some response ');
    expect(result).toBe('Some response');
  });

  it('strips tag in middle of text cleanly', () => {
    const result = stripTags('Updated [COMMUNITY_UPDATE: jain] your profile.');
    expect(result).not.toContain('[COMMUNITY_UPDATE');
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
