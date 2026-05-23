// ============================================
// resolveLocation.test.js — tests for the single location resolver
// Run: npm test
// ============================================
// Network calls are mocked so these run offline and deterministically in CI.
// ============================================

import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveLocation, formatCandidatePicker } from '../src/resolveLocation.js';

// Helper: stub global fetch to return a given geocoder payload.
function mockGeocoder(results) {
  global.fetch = vi.fn().mockResolvedValue({
    json: async () => ({ results }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// A minimal Open-Meteo-shaped result.
function geoResult(name, admin1, country, extra = {}) {
  return {
    name,
    admin1,
    country,
    latitude: extra.latitude ?? 51.5,
    longitude: extra.longitude ?? -0.12,
    timezone: extra.timezone ?? 'Europe/London',
  };
}

// ── MISSING: no network call should happen for these ────────────────────────
describe('resolveLocation — missing (no usable city)', () => {

  it('null → missing', async () => {
    expect((await resolveLocation(null)).status).toBe('missing');
  });

  it('undefined → missing', async () => {
    expect((await resolveLocation(undefined)).status).toBe('missing');
  });

  it('empty string → missing', async () => {
    expect((await resolveLocation('')).status).toBe('missing');
  });

  it('whitespace only → missing', async () => {
    expect((await resolveLocation('   ')).status).toBe('missing');
  });

  it('single character → missing', async () => {
    expect((await resolveLocation('x')).status).toBe('missing');
  });

  it('"near me" → missing (never hits geocoder)', async () => {
    expect((await resolveLocation('near me')).status).toBe('missing');
  });

  it('"here" → missing', async () => {
    expect((await resolveLocation('here')).status).toBe('missing');
  });

  it('over-long junk → missing', async () => {
    const junk = 'a'.repeat(80);
    expect((await resolveLocation(junk)).status).toBe('missing');
  });

  it('geocoder returns zero results → missing', async () => {
    mockGeocoder([]);
    expect((await resolveLocation('Zzzxqv')).status).toBe('missing');
  });
});

// ── RESOLVED: exactly one match ─────────────────────────────────────────────
describe('resolveLocation — resolved (one match)', () => {

  it('single result → resolved with place shape', async () => {
    mockGeocoder([geoResult('Paris', 'Île-de-France', 'France',
      { latitude: 48.85, longitude: 2.35, timezone: 'Europe/Paris' })]);
    const r = await resolveLocation('Paris');
    expect(r.status).toBe('resolved');
    expect(r.place.name).toBe('Paris');
    expect(r.place.timezone).toBe('Europe/Paris');
    expect(r.place.latitude).toBe(48.85);
    expect(r.place.country).toBe('France');
  });

  it('exact-name match collapses extras to one (San Jose, not del Cabo)', async () => {
    mockGeocoder([
      geoResult('San Jose', 'California', 'United States'),
      geoResult('San Jose del Cabo', 'Baja California Sur', 'Mexico'),
    ]);
    const r = await resolveLocation('San Jose');
    expect(r.status).toBe('resolved');
    expect(r.place.name).toBe('San Jose');
  });

  it('place always carries the timezone from the geocoder', async () => {
    mockGeocoder([geoResult('Mumbai', 'Maharashtra', 'India',
      { timezone: 'Asia/Kolkata' })]);
    const r = await resolveLocation('Mumbai');
    expect(r.place.timezone).toBe('Asia/Kolkata');
  });
});

// ── AMBIGUOUS: two or more genuine matches ──────────────────────────────────
describe('resolveLocation — ambiguous (multiple matches)', () => {

  it('multiple exact matches → ambiguous', async () => {
    mockGeocoder([
      geoResult('London', 'England', 'United Kingdom'),
      geoResult('London', 'Ontario', 'Canada'),
      geoResult('London', 'Kentucky', 'United States'),
    ]);
    const r = await resolveLocation('London');
    expect(r.status).toBe('ambiguous');
    expect(r.candidates.length).toBe(3);
  });

  it('caps candidates at 4', async () => {
    mockGeocoder([
      geoResult('Springfield', 'Illinois', 'United States'),
      geoResult('Springfield', 'Missouri', 'United States'),
      geoResult('Springfield', 'Massachusetts', 'United States'),
      geoResult('Springfield', 'Ohio', 'United States'),
      geoResult('Springfield', 'Oregon', 'United States'),
    ]);
    const r = await resolveLocation('Springfield');
    expect(r.status).toBe('ambiguous');
    expect(r.candidates.length).toBe(4);
  });

  it('no exact match → falls back to all results as candidates', async () => {
    mockGeocoder([
      geoResult('Cambridge', 'England', 'United Kingdom'),
      geoResult('Cambridge', 'Massachusetts', 'United States'),
    ]);
    const r = await resolveLocation('Cambrige'); // user typo, no exact match
    expect(r.status).toBe('ambiguous');
    expect(r.candidates.length).toBe(2);
  });
});

// ── ERROR: geocoder threw / network failure ─────────────────────────────────
describe('resolveLocation — error (geocoder failure)', () => {

  it('fetch rejects → error (NOT missing)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down'));
    const r = await resolveLocation('Paris');
    expect(r.status).toBe('error');
  });

  it('malformed JSON → error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => { throw new Error('bad json'); },
    });
    const r = await resolveLocation('Paris');
    expect(r.status).toBe('error');
  });
});

// ── PICKER FORMATTING: no network, pure string ──────────────────────────────
describe('formatCandidatePicker', () => {

  const candidates = [
    { name: 'London', admin1: 'England', country: 'United Kingdom' },
    { name: 'London', admin1: 'Ontario', country: 'Canada' },
  ];

  it('numbers each candidate', () => {
    const out = formatCandidatePicker('London', candidates);
    expect(out).toContain('1 — London, England, United Kingdom');
    expect(out).toContain('2 — London, Ontario, Canada');
  });

  it('includes the add-state/country nudge', () => {
    const out = formatCandidatePicker('London', candidates);
    expect(out.toLowerCase()).toContain("if yours isn't listed");
  });

  it('handles a candidate missing admin1', () => {
    const out = formatCandidatePicker('Foo', [
      { name: 'Foo', admin1: null, country: 'Narnia' },
    ]);
    expect(out).toContain('1 — Foo, Narnia');
  });
});
