// IN PLAIN ENGLISH: takes a city name, asks the geocoder where it is.
// Returns one of four: found it / found several / found nothing / lookup failed.
// The only file that talks to the geocoding service.
// ============================================
// resolveLocation — THE single location resolver (v3.1)
// ============================================
// Every location need across every journey goes through this one function.
// It takes the raw city string that classify() already extracted (or null).
// It does NOT extract a city from a sentence — extraction lives in classify.js.
//
//   resolveLocation(cityRaw) -> one of:
//     { status: 'resolved',  place }        unique match, proceed
//     { status: 'ambiguous', candidates }   2-4 matches, ask user to pick
//     { status: 'missing' }                 no usable city, ask for one
//     { status: 'error' }                   geocoder failed, ask to retry
//
//   place = { name, latitude, longitude, timezone, admin1, country }
//
// Note on the fourth status: the v3.1 spec lists three (resolved/ambiguous/
// missing). 'error' is added deliberately. 'missing' means "you gave me no
// usable city, tell me one" and the resume re-asks for a city. A geocoder
// timeout is different: the city may be perfectly valid, so re-asking for it
// sends the user in a loop (retype same city -> same failure). The existing
// code already split these ("try again in a moment" vs "type the city name").
// Folding them together would be a regression, so resolveLocation keeps four.
// ============================================

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const NON_CITIES = ['me', 'here', 'my area', 'nearby', 'near me'];

export async function resolveLocation(cityRaw) {
  // --- missing: nothing usable to geocode -----------------------------------
  // Covers null/undefined, empty/whitespace, too-short or too-long junk, and
  // the "near me" non-cities that must never reach the geocoder.
  if (cityRaw == null) return { status: 'missing' };
  const raw = String(cityRaw).trim();
  if (raw.length < 2 || raw.length > 50) return { status: 'missing' };
  if (NON_CITIES.includes(raw.toLowerCase())) return { status: 'missing' };

  try {
    const cleanCity = raw
      .replace(/,\s*[A-Z]{2}$/i, '')   // strip ", NY" style 2-letter state codes
      .replace(/,/g, ' ')
      .trim();

    const url = `${GEOCODE_URL}?name=${encodeURIComponent(cleanCity)}&count=5&language=en&format=json`;
    const res = await fetch(url);
    const data = await res.json();
    const results = data.results || [];

    if (results.length === 0) return { status: 'missing' };

    // Prefer exact name matches so "San Jose" does not surface
    // "San Jose del Cabo" alongside the real San Joses.
    const exact = results.filter(
      r => r.name.toLowerCase() === cleanCity.toLowerCase()
    );
    const candidates = exact.length > 0 ? exact : results;

    if (candidates.length === 1) {
      return { status: 'resolved', place: toPlace(candidates[0]) };
    }
    return { status: 'ambiguous', candidates: candidates.slice(0, 4).map(toPlace) };

  } catch (err) {
    console.log(`[resolver] error city="${raw}" err=${err.message}`);
    return { status: 'error' };
  }
}

// Normalize an Open-Meteo geocoding result into the spec's place shape.
// Open-Meteo returns the IANA timezone in the geocoding response, so the
// resolver supplies it directly — no separate timezone lookup needed.
function toPlace(r) {
  return {
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone,
    admin1: r.admin1 || null,
    country: r.country || null,
  };
}

// Format the ambiguous-case candidate list into the WhatsApp picker text.
// Includes the "add state/country if yours isn't listed" nudge so users
// whose city falls outside the top 4 know how to narrow it down.
export function formatCandidatePicker(cityRaw, candidates) {
  const lines = candidates.map((c, i) =>
    `${i + 1} — ${c.name}${c.admin1 ? ', ' + c.admin1 : ''}${c.country ? ', ' + c.country : ''}`
  ).join('\n');
  return `I found a few places called "${cityRaw}". Which one?\n\n${lines}\n\n` +
    `Reply with the number — or if yours isn't listed, type the city with its state or country.`;
}
