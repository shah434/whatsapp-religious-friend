// ============================================
// sunset.js — Sunrise and sunset lookup
// Uses Open-Meteo (free) + sunrise-sunset.org (free)
// No API keys needed
// v4 — placeFromUser() lets the worker reconstruct a place object from
//      saved user fields (lat/lng/timezone) instead of re-geocoding the
//      formatted display string, which Open-Meteo struggles to match.
// ============================================

/**
 * Geocode a city name and return one of three states:
 *   { status: 'unique',     place: <placeObj> }
 *   { status: 'ambiguous',  candidates: [<placeObj>, ...] }
 *   { status: 'not_found' }
 *
 * placeObj has: name, latitude, longitude, timezone, admin1, country
 */
// US state code → admin1 name (Open-Meteo returns full state names, not codes)
// US state code → admin1 name (Open-Meteo returns full state names, not codes)
const US_STATES = {
  al:'Alabama',ak:'Alaska',az:'Arizona',ar:'Arkansas',ca:'California',
  co:'Colorado',ct:'Connecticut',de:'Delaware',fl:'Florida',ga:'Georgia',
  hi:'Hawaii',id:'Idaho',il:'Illinois',in:'Indiana',ia:'Iowa',ks:'Kansas',
  ky:'Kentucky',la:'Louisiana',me:'Maine',md:'Maryland',ma:'Massachusetts',
  mi:'Michigan',mn:'Minnesota',ms:'Mississippi',mo:'Missouri',mt:'Montana',
  ne:'Nebraska',nv:'Nevada',nh:'New Hampshire',nj:'New Jersey',nm:'New Mexico',
  ny:'New York',nc:'North Carolina',nd:'North Dakota',oh:'Ohio',ok:'Oklahoma',
  or:'Oregon',pa:'Pennsylvania',ri:'Rhode Island',sc:'South Carolina',
  sd:'South Dakota',tn:'Tennessee',tx:'Texas',ut:'Utah',vt:'Vermont',
  va:'Virginia',wa:'Washington',wv:'West Virginia',wi:'Wisconsin',wy:'Wyoming',
  dc:'District of Columbia'
};

export async function geocodeCity(city) {
  try {
    // Capture a trailing 2-letter qualifier (state or country code).
    const qMatch = city.match(/,\s*([A-Za-z]{2})\s*$/);
    const qCode = qMatch ? qMatch[1].toLowerCase() : null;
    const stateName = qCode ? US_STATES[qCode] : null;

    const cleanCity = city
      .replace(/,\s*[A-Za-z]{2}\s*$/i, '')
      .replace(/,/g, ' ')
      .trim();

    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cleanCity)}&count=10&language=en&format=json`;
    const res = await fetch(url);
    const data = await res.json();
    let results = data.results || [];

    if (results.length === 0) return { status: 'not_found' };

    // Narrow by qualifier. Try US state first (handles the IN = Indiana/India
    // collision: a real Indiana city matches here; an Indian city won't, and
    // falls through to the country-code filter below).
    if (qCode) {
      let narrowed = [];
      if (stateName) {
        narrowed = results.filter(
          r => (r.admin1 || '').toLowerCase() === stateName.toLowerCase()
        );
      }
      // Fall back to country-code match if state gave nothing.
      if (narrowed.length === 0) {
        narrowed = results.filter(
          r => (r.country_code || '').toLowerCase() === qCode
        );
      }
      if (narrowed.length > 0) results = narrowed;
    }

    const exact = results.filter(
      r => r.name.toLowerCase() === cleanCity.toLowerCase()
    );
    const candidates = exact.length > 0 ? exact : results;

    if (candidates.length === 1) {
      return { status: 'unique', place: candidates[0] };
    }
    return { status: 'ambiguous', candidates: candidates.slice(0, 4) };

  } catch (err) {
    console.log('geocodeCity error:', err.message);
    return { status: 'not_found' };
  }
}

/**
 * Fetch sunrise/sunset for an already-resolved place object.
 * Returns { city, sunrise, sunset, timezoneId } or null on failure.
 */
export async function getSunForPlace(place, date = null) {
  try {
    let dateStr;
    if (date === 'tomorrow') {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      dateStr = d.toISOString().split('T')[0];
    } else {
      dateStr = new Date().toISOString().split('T')[0];
    }
    const sunUrl = `https://api.sunrise-sunset.org/json?lat=${place.latitude}&lng=${place.longitude}&date=${dateStr}&formatted=0`;
    console.log(`[sun] lookup name=${place.name} lat=${place.latitude} lng=${place.longitude} tz=${place.timezone} date=${dateStr}`);

    const sunRes = await fetch(sunUrl);
    if (!sunRes.ok) {
      console.log(`[sun] http_error status=${sunRes.status}`);
      return null;
    }
    const sunData = await sunRes.json();

    if (sunData.status !== 'OK') {
      console.log(`[sun] api_status_not_ok status=${sunData.status}`);
      return null;
    }

    const sunrise = formatTime(sunData.results.sunrise, place.timezone);
    const sunset = formatTime(sunData.results.sunset, place.timezone);
    if (!sunrise || !sunset) {
      console.log(`[sun] format_failed sunrise=${sunrise} sunset=${sunset} tz=${place.timezone}`);
      return null;
    }

    // If admin1/country are missing (e.g. reconstructed from placeFromUser),
    // assume the name already includes them (display string was saved).
    const displayCity = place.admin1 || place.country
      ? `${place.name}${place.admin1 ? ', ' + place.admin1 : ''}${place.country ? ', ' + place.country : ''}`
      : place.name;

    return {
      city: displayCity,
      sunrise,
      sunset,
      timezoneId: place.timezone,
      date: dateStr,          // 'YYYY-MM-DD' — tells Claude which day these times are for
      isToday: date !== 'tomorrow',
    };

  } catch (err) {
    console.log(`[sun] exception: ${err.message}`);
    return null;
  }
}

/**
 * Build a place object from saved user fields. Use when we resolved the
 * city in a previous turn and just need to look up sun times again —
 * avoids re-geocoding the formatted display string.
 *
 * Returns null if the user has no saved coordinates (e.g. old rows from
 * before lat/lng were added to the schema). Callers should fall back to
 * getSunriseSunset(user.city) in that case.
 */
export function placeFromUser(user) {
  if (!user || user.latitude == null || user.longitude == null || !user.timezone) {
    return null;
  }
  return {
    name: user.city,
    latitude: user.latitude,
    longitude: user.longitude,
    timezone: user.timezone,
    admin1: null,    // display string already includes these
    country: null
  };
}

/**
 * Convenience wrapper used by the sunset path when the city is unambiguous.
 * Returns null when the city is ambiguous or not found — callers that need
 * disambiguation should use geocodeCity + getSunForPlace directly.
 */
export async function getSunriseSunset(city) {
  const geo = await geocodeCity(city);
  if (geo.status !== 'unique') return null;
  return getSunForPlace(geo.place);
}

function formatTime(utcString, timezoneId) {
  try {
    const date = new Date(utcString);
    return date.toLocaleTimeString('en-US', {
      timeZone: timezoneId,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return null;
  }
}

export function formatSunDataForClaude(sunData) {
  if (!sunData) return '';
  const dayLabel = sunData.isToday ? 'TODAY' : 'TOMORROW';
  return `
========================================
EXACT SUNRISE/SUNSET DATA FOR THIS REPLY:
Date: ${dayLabel} (${sunData.date})
City: ${sunData.city}
Sunrise: ${sunData.sunrise}
Sunset: ${sunData.sunset}
Timezone: ${sunData.timezoneId}
========================================
You MUST use these exact times verbatim.
Do NOT round, estimate, recalculate, or change them.
If you write any time other than "${sunData.sunset}" for sunset
or "${sunData.sunrise}" for sunrise, you are wrong.`;
}

export function detectSunsetQuery(text) {
  const lower = text.toLowerCase();
  const keywords = [
    'sunset', 'sunrise', 'sun set', 'sun rise',
    'what time is sunset', 'what time is sunrise',
    'when is sunset', 'when is sunrise',
    'what time does the sun'
  ];
  return keywords.some(k => lower.includes(k));
}

export function extractCityFromSunQuery(text) {
  const cleaned = text
    .replace(/\btoday\b/gi, '')
    .replace(/\btonight\b/gi, '')
    .replace(/\bnow\b/gi, '')
    .replace(/\bcurrently\b/gi, '')
    .trim();

  const patterns = [
    /(?:sunset|sunrise)\s+(?:in|for|at)\s+([a-zA-Z\s,]+?)(?:\?|$)/i,
    /(?:sunset|sunrise)\s+(?:in|for|at)\s+(\d{5})/i,
    /\b(\d{5})\b/i,
    /\b([A-Z]{1,2}\d{1,2}\s?\d[A-Z]{2})\b/i
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match && match[1]) {
      const location = match[1].trim();
      if (['me', 'here', 'my area', 'nearby', 'near me'].includes(location.toLowerCase())) {
        return null;
      }
      return location;
    }
  }

  return null;
}
