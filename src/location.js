// ============================================
// location.js — Google Places and location detection
// ============================================

export async function searchRestaurants(communityQuery, location, env) {
  const res = await fetch(
    'https://places.googleapis.com/v1/places:searchText',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.GOOGLE_PLACES_KEY,
        'X-Goog-FieldMask': [
          'places.displayName',
          'places.formattedAddress',
          'places.rating',
          'places.userRatingCount',
          'places.regularOpeningHours',
          'places.nationalPhoneNumber',
          'places.websiteUri'
        ].join(',')
      },
      body: JSON.stringify({
        textQuery: `${communityQuery} vegetarian restaurant ${location}`,
        maxResultCount: 5
      })
    }
  );
  const data = await res.json();
  console.log('Google Places status:', res.status);
  console.log('Google Places response:', JSON.stringify(data).substring(0, 500));
  return data.places || [];
}

export function detectLocation(text) {
  const lower = text.toLowerCase();

  const locationKeywords = [
    'restaurant', 'restaurants', 'find jain', 'find baps',
    'eat near', 'food near', 'where can i eat', 'where to eat'
  ];

  const isLocationQuery = locationKeywords.some(k => lower.includes(k));
  if (!isLocationQuery) return null;

const locationPatterns = [
  /\bnear\s+(.+?)(?:\?|$)/i,
  /\bin\s+(.+?)(?:\?|$)/i,
  /\bnear\s+(\d{5})\b/i,
  /\bin\s+(\d{5})\b/i,
  /\b(\d{5})\b/i,
  /\b([A-Z]{1,2}\d{1,2}\s?\d[A-Z]{2})\b/i
];

  for (const pattern of locationPatterns) {
    const match = text.match(pattern);
    if (match) {
      const location = (match[1] || match[0]).trim();
      if (['me', 'here', 'my area', 'nearby', 'near me'].includes(location.toLowerCase())) {
        return 'unknown';
      }
      return location;
    }
  }

  return 'unknown';
}
