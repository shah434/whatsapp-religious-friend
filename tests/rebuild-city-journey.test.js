// ============================================
// rebuild-city-journey.test.js — claim/isolation logic for city journeys
// Run: npm test 
// ============================================
// Tests cityJourneyClaims() — the rule that decides which journey owns a turn.
// The handler itself (handleCityJourney) calls network/WhatsApp/Claude and is
// tested live in WhatsApp, not here. This file locks the PENDING-ALWAYS-WINS
// rule that prevents one journey from hijacking another's pending flow.
// ============================================

import { describe, it, expect } from 'vitest';
import { cityJourneyClaims } from '../src/rebuild-city-journey.js';
import { serializePending } from '../src/pending.js';

const sunsetIntent = { journey: 'sunset', params: {}, prompt_blocks: ['calendar'] };
const restIntent = { journey: 'restaurant', params: {}, prompt_blocks: ['restaurant'] };
const foodIntent = { journey: 'food', params: {}, prompt_blocks: ['general'] };

const pendingSunset = { pending_action: serializePending({ need: 'city', intent: sunsetIntent }) };
const pendingRest = { pending_action: serializePending({ need: 'city', intent: restIntent }) };
const noPending = { pending_action: null };

describe('cityJourneyClaims — fresh requests', () => {
  it('fresh sunset → sunset gate claims', () => {
    expect(cityJourneyClaims(noPending, sunsetIntent, 'sunset')).toBe(true);
  });
  it('fresh restaurant → restaurant gate claims', () => {
    expect(cityJourneyClaims(noPending, restIntent, 'restaurant')).toBe(true);
  });
  it('fresh sunset → restaurant gate does NOT claim', () => {
    expect(cityJourneyClaims(noPending, sunsetIntent, 'restaurant')).toBe(false);
  });
  it('fresh food → neither city gate claims', () => {
    expect(cityJourneyClaims(noPending, foodIntent, 'sunset')).toBe(false);
    expect(cityJourneyClaims(noPending, foodIntent, 'restaurant')).toBe(false);
  });
});
describe('cityJourneyClaims — resume (bare reply, pending owns the turn)', () => {
  it('pending sunset + bare reply → sunset claims', () => {
    expect(cityJourneyClaims(pendingSunset, foodIntent, 'sunset', 'London')).toBe(true);
  });
  it('pending restaurant + bare reply → restaurant claims', () => {
    expect(cityJourneyClaims(pendingRest, foodIntent, 'restaurant', 'Mumbai')).toBe(true);
  });
});

describe('cityJourneyClaims — fresh request supersedes STALE pending', () => {
  // The bug that shipped: a fresh restaurant request was blocked by a leftover
  // sunset pending record. A clearly-classified new city-journey must win.
  it('fresh restaurant intent + stale sunset pending → restaurant claims', () => {
    expect(cityJourneyClaims(pendingSunset, restIntent, 'restaurant')).toBe(true);
  });
  it('fresh restaurant intent + stale sunset pending → sunset does NOT claim', () => {
    expect(cityJourneyClaims(pendingSunset, restIntent, 'sunset')).toBe(false);
  });
  it('fresh sunset intent + stale restaurant pending → sunset claims', () => {
    expect(cityJourneyClaims(pendingRest, sunsetIntent, 'sunset')).toBe(true);
  });
  it('fresh sunset intent + stale restaurant pending → restaurant does NOT claim', () => {
    expect(cityJourneyClaims(pendingRest, sunsetIntent, 'restaurant')).toBe(false);
  });
});

describe('cityJourneyClaims — bare reply resumes, real question abandons', () => {
  // The text decides, not the intent. A bare reply ("1", "London") resumes
  // the pending journey. A real question ("can i eat paneer") does NOT — it
  // abandons the pending and runs fresh.
  it('bare number reply + pending sunset → sunset claims', () => {
    expect(cityJourneyClaims(pendingSunset, foodIntent, 'sunset', '1')).toBe(true);
  });
  it('bare city reply + pending sunset → sunset claims', () => {
    expect(cityJourneyClaims(pendingSunset, foodIntent, 'sunset', 'London')).toBe(true);
  });
  it('bare reply + pending sunset → restaurant does NOT claim', () => {
    expect(cityJourneyClaims(pendingSunset, foodIntent, 'restaurant', '1')).toBe(false);
  });
  it('real food question + pending sunset → sunset does NOT claim', () => {
    expect(cityJourneyClaims(pendingSunset, foodIntent, 'sunset', 'can i eat paneer')).toBe(false);
  });
  it('bare number reply + pending restaurant → restaurant claims', () => {
    expect(cityJourneyClaims(pendingRest, foodIntent, 'restaurant', '2')).toBe(true);
  });
  it('real food question + pending restaurant → restaurant does NOT claim', () => {
    expect(cityJourneyClaims(pendingRest, foodIntent, 'restaurant', 'can i eat paneer')).toBe(false);
  });
});

describe('cityJourneyClaims — corrupt pending falls back to fresh', () => {
  it('corrupt pending_action is ignored; fresh intent decides', () => {
    const corrupt = { pending_action: '{not json' };
    expect(cityJourneyClaims(corrupt, sunsetIntent, 'sunset')).toBe(true);
    expect(cityJourneyClaims(corrupt, sunsetIntent, 'restaurant')).toBe(false);
  });
});
