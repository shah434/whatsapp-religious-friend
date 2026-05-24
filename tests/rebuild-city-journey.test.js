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

describe('cityJourneyClaims — resume (pending owns the turn)', () => {
  it('pending sunset → sunset gate claims any reply', () => {
    expect(cityJourneyClaims(pendingSunset, foodIntent, 'sunset')).toBe(true);
  });
  it('pending restaurant → restaurant gate claims any reply', () => {
    expect(cityJourneyClaims(pendingRest, foodIntent, 'restaurant')).toBe(true);
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

describe('cityJourneyClaims — bare reply still resumes pending (no hijack)', () => {
  // A bare reply classifies as 'food' (classify's default). It must be claimed
  // ONLY by the pending journey, never by the other city gate.
  it('bare reply (food intent) + pending sunset → sunset claims', () => {
    expect(cityJourneyClaims(pendingSunset, foodIntent, 'sunset')).toBe(true);
  });
  it('bare reply (food intent) + pending sunset → restaurant does NOT claim', () => {
    expect(cityJourneyClaims(pendingSunset, foodIntent, 'restaurant')).toBe(false);
  });
  it('bare reply (food intent) + pending restaurant → restaurant claims', () => {
    expect(cityJourneyClaims(pendingRest, foodIntent, 'restaurant')).toBe(true);
  });
  it('bare reply (food intent) + pending restaurant → sunset does NOT claim', () => {
    expect(cityJourneyClaims(pendingRest, foodIntent, 'sunset')).toBe(false);
  });
});

describe('cityJourneyClaims — corrupt pending falls back to fresh', () => {
  it('corrupt pending_action is ignored; fresh intent decides', () => {
    const corrupt = { pending_action: '{not json' };
    expect(cityJourneyClaims(corrupt, sunsetIntent, 'sunset')).toBe(true);
    expect(cityJourneyClaims(corrupt, sunsetIntent, 'restaurant')).toBe(false);
  });
});
