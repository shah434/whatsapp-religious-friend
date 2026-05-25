// ============================================
// pending.test.js — tests for the validated pending record
// Run: npm test
// ============================================
// No network — pure serialize/validate logic. The intent objects here are
// hand-made stand-ins for what classify() emits (classify is frozen, so the
// shape is stable). The real bot-emitted intents meet this code at the wiring
// step, which is tested locally.
// ============================================

import { describe, it, expect } from 'vitest';
import { serializePending, readPending } from '../src/pending.js';

// A minimal valid intent, shaped like classify() output.
function intent(journey = 'food', params = {}) {
  return { journey, params, prompt_blocks: ['general'] };
}

// ── ROUND TRIP: serialize then read gives the same thing back ───────────────
describe('pending — round trip', () => {

  it('city need round-trips', () => {
    const stored = serializePending({ need: 'city', intent: intent('tithi') });
    expect(stored).not.toBeNull();
    const back = readPending(stored);
    expect(back.need).toBe('city');
    expect(back.intent.journey).toBe('tithi');
    expect(back.choices).toBeUndefined();
  });

  it('strictness need round-trips', () => {
    const stored = serializePending({ need: 'strictness', intent: intent('food') });
    const back = readPending(stored);
    expect(back.need).toBe('strictness');
    expect(back.intent.journey).toBe('food');
  });

  it('city_pick round-trips WITH choices', () => {
    const choices = [
      { name: 'London', admin1: 'England', country: 'United Kingdom' },
      { name: 'London', admin1: 'Ontario', country: 'Canada' },
    ];
    const stored = serializePending({ need: 'city_pick', intent: intent('sunset'), choices });
    const back = readPending(stored);
    expect(back.need).toBe('city_pick');
    expect(back.choices.length).toBe(2);
    expect(back.choices[0].name).toBe('London');
  });

  it('preserves intent params through the round trip', () => {
    const stored = serializePending({
      need: 'city',
      intent: intent('restaurant', { city_raw: 'Surat' }),
    });
    const back = readPending(stored);
    expect(back.intent.params.city_raw).toBe('Surat');
  });
});

// ── SERIALIZE REFUSES bad input (returns null, never stores garbage) ────────
describe('pending — serialize refuses bad input', () => {

  it('unknown need → null', () => {
    expect(serializePending({ need: 'banana', intent: intent() })).toBeNull();
  });

  it('missing intent → null', () => {
    expect(serializePending({ need: 'city', intent: null })).toBeNull();
  });

  it('intent with unknown journey → null', () => {
    expect(serializePending({ need: 'city', intent: intent('sportsball') })).toBeNull();
  });

  it('city_pick with no choices → null', () => {
    expect(serializePending({ need: 'city_pick', intent: intent('sunset') })).toBeNull();
  });

  it('city_pick with empty choices array → null', () => {
    expect(serializePending({ need: 'city_pick', intent: intent('sunset'), choices: [] })).toBeNull();
  });
});

// ── READ resets on ANY corruption (returns null, never throws) ──────────────
describe('pending — read validates and resets', () => {

  it('null stored value → null', () => {
    expect(readPending(null)).toBeNull();
  });

  it('empty string → null', () => {
    expect(readPending('')).toBeNull();
  });

  it('unparseable JSON → null (no throw)', () => {
    expect(readPending('{not json')).toBeNull();
  });

  it('valid JSON but not an object → null', () => {
    expect(readPending('"just a string"')).toBeNull();
    expect(readPending('42')).toBeNull();
  });

  it('object with unknown need → null', () => {
    expect(readPending(JSON.stringify({ need: 'xyz', intent: intent() }))).toBeNull();
  });

  it('object with bad intent journey → null', () => {
    expect(readPending(JSON.stringify({ need: 'city', intent: { journey: 'nope' } }))).toBeNull();
  });

  it('city_pick missing choices → null', () => {
    expect(readPending(JSON.stringify({ need: 'city_pick', intent: intent('sunset') }))).toBeNull();
  });

  it('city_pick with non-array choices → null', () => {
    expect(readPending(JSON.stringify({
      need: 'city_pick', intent: intent('sunset'), choices: 'oops',
    }))).toBeNull();
  });

  it('accepts a pre-parsed object (not just a string)', () => {
    const back = readPending({ need: 'city', intent: intent('tithi') });
    expect(back.need).toBe('city');
  });
});

// ── INTENT params tolerance: shallow validation only ────────────────────────
describe('pending — intent validation is shallow by design', () => {

  it('intent with no params is fine (params optional)', () => {
    const stored = serializePending({ need: 'city', intent: { journey: 'food' } });
    expect(stored).not.toBeNull();
    expect(readPending(stored).intent.journey).toBe('food');
  });

  it('intent with non-object params → rejected', () => {
    expect(serializePending({
      need: 'city', intent: { journey: 'food', params: 'nope' },
    })).toBeNull();
  });
});
