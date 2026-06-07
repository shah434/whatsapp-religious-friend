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

import { fetchWithTimeout } from './utils.js';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const NON_CITIES = ['me', 'here', 'my area', 'nearby', 'near me'];

// US state codes → full admin1 names (used to narrow ambiguous results).
const US_STATES = {
  al:'Alabama',ak:'Alaska',az:'Arizona',ar:'Arkansas',ca:'California',
  co:'Colorado',ct:'Connecticut',de:'Delaware',fl:'Florida',ga:'Georgia',
  hi:'Hawaii',id:'Idaho',il:'Illinois',in:'Indiana',ia:'Iowa',ks:'Kansas',
  ky:'Kentucky',la:'Louisiana',me:'Maine',md:'Maryland',ma:'Massachusetts',
  mi:'Michigan',mn:'Minnesota',ms:'Mississippi',mo:'Missouri',mt:'Montana',
  ne:'Nebraska',nv:'Nevada',nh:'New Hampshire',nj:'New Jersey',
  nm:'New Mexico',ny:'New York',nc:'North Carolina',nd:'North Dakota',
  oh:'Ohio',ok:'Oklahoma',or:'Oregon',pa:'Pennsylvania',ri:'Rhode Island',
  sc:'South Carolina',sd:'South Dakota',tn:'Tennessee',tx:'Texas',ut:'Utah',
  vt:'Vermont',va:'Virginia',wa:'Washington',wv:'West Virginia',
  wi:'Wisconsin',wy:'Wyoming',dc:'District of Columbia',
};

export async function resolveLocation(cityRaw) {
  // --- missing: nothing usable to geocode -----------------------------------
  if (cityRaw == null) return { status: 'missing' };
  const raw = String(cityRaw).trim();
  if (raw.length < 2 || raw.length > 50) return { status: 'missing' };
  if (NON_CITIES.includes(raw.toLowerCase())) return { status: 'missing' };

  try {
    // --- US ZIP code: resolve via Nominatim postal search + Open-Meteo TZ ---
    if (/^\d{5}$/.test(raw)) {
      const [nomRes, _] = await Promise.all([
        fetchWithTimeout(
          `https://nominatim.openstreetmap.org/search?format=json&postalcode=${raw}&countrycodes=us&limit=1&addressdetails=1`,
          { headers: { 'User-Agent': 'SamtaAgent/1.0' } },
          4000
        ),
        Promise.resolve(),
      ]);
      const nomData = nomRes.ok ? await nomRes.json() : [];
      if (Array.isArray(nomData) && nomData.length > 0) {
        const r = nomData[0];
        const lat = parseFloat(r.lat);
        const lon = parseFloat(r.lon);
        const addr = r.address || {};
        const name = addr.city ?? addr.town ?? addr.village ?? addr.county ?? null;
        if (name) {
          const tzRes = await fetchWithTimeout(
            `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=0`,
            {},
            3000
          );
          const tzData = tzRes.ok ? await tzRes.json() : {};
          const timezone = tzData?.timezone;
          if (timezone) {
            return {
              status: 'resolved',
              place: {
                name,
                admin1: addr.state ?? null,
                country: addr.country ?? null,
                latitude: lat,
                longitude: lon,
                timezone,
              },
            };
          }
        }
      }
      // ZIP not found or timezone lookup failed — ask for city name
      return { status: 'missing' };
    }

    // Extract a trailing state qualifier BEFORE stripping it, so we can use
    // it to narrow ambiguous geocoder results after the search.
    // Handles both 2-letter codes ("savannah, ga") and full names ("savannah, georgia").
    const stateMatch = raw.match(/[,\s]+([A-Z]{2})$/i);
    const stateCode = stateMatch ? stateMatch[1].toLowerCase() : null;
    let stateName = stateCode ? (US_STATES[stateCode] || null) : null;

    // Fall back to full state name match if no 2-letter code found.
    let fullStateStrip = null;
    if (!stateName) {
      for (const sName of Object.values(US_STATES)) {
        if (new RegExp(`[,\\s]+${sName}\\s*$`, 'i').test(raw)) {
          stateName = sName;
          fullStateStrip = sName;
          break;
        }
      }
    }

    let cleanCity = raw
      .replace(/,\s*[A-Z]{2}$/i, '')   // strip ", NY" style 2-letter state codes
      .replace(/\s+[A-Z]{2}$/i, '')    // strip " NY" style (no comma) — e.g. "columbus oh"
      .replace(/,/g, ' ')
      .trim();

    // Strip full state name when it was used ("savannah georgia" → "savannah").
    if (fullStateStrip) {
      cleanCity = cleanCity.replace(new RegExp(`\\s+${fullStateStrip}\\s*$`, 'i'), '').trim();
    }

    const url = `${GEOCODE_URL}?name=${encodeURIComponent(cleanCity)}&count=5&language=en&format=json`;
    const res = await fetchWithTimeout(url, {}, 3000);
    const data = await res.json();
    const results = data.results || [];

    if (results.length === 0) return { status: 'missing' };

    // Prefer exact name matches so "San Jose" does not surface
    // "San Jose del Cabo" alongside the real San Joses.
    const exact = results.filter(
      r => r.name.toLowerCase() === cleanCity.toLowerCase()
    );
    let candidates = exact.length > 0 ? exact : results;

    // If the user supplied a state code ("columbus oh"), use it to narrow
    // the candidates by matching admin1 against the full state name.
    if (stateName && candidates.length > 1) {
      const stateFiltered = candidates.filter(
        r => r.admin1 && r.admin1.toLowerCase() === stateName.toLowerCase()
      );
      if (stateFiltered.length > 0) candidates = stateFiltered;
    }

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
    `Reply with the number — or type a more specific name, e.g. *Columbus, Ohio* or *Columbus, GA*.`;
}
