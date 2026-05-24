// ============================================
// fasting-match.js — fuzzy detection of Jain
// fast / pachkhan / observance terms
//
// Handles transliteration variants (pachkhan / pacchakhan / paccakkhana /
// pachakhaan) and common misspellings of specific fast names
// (ayambhil, navakarsi, porsee, etc.) that the literal-token regex in
// classifyQuery would miss.
// ============================================

// Canonical forms (lowercase, no diacritics) → category label
// Add new variants here when logs show users typing something we don't catch.
const FAST_TERMS = {
  // Umbrella term — should always route to the fasting flow
  pachkhan: 'pachkhan_general',
  pachakhan: 'pachkhan_general',
  pachchakhan: 'pachkhan_general',
  pacchakhan: 'pachkhan_general',
  paccakkhana: 'pachkhan_general',
  pachakkhana: 'pachkhan_general',
  pachakhaan: 'pachkhan_general',
  pachkaan: 'pachkhan_general',
  'પચ્ચક્ખાણ': 'pachkhan_general',
  'પચખાણ': 'pachkhan_general',

  // Specific fast types
  upvas: 'upvas',
  upavas: 'upvas',
  ekasan: 'ekasan',
  ekasana: 'ekasan',
  ekashan: 'ekasan',
  biyasan: 'biyasan',
  biyasana: 'biyasan',
  beyasan: 'biyasan',
  ayambil: 'ayambil',
  ayambhil: 'ayambil',
  aayambil: 'ayambil',
  ayambeel: 'ayambil',
  chauvihar: 'chauvihar',
  chauvihaar: 'chauvihar',
  chovihar: 'chauvihar',
  tivihar: 'tivihar',
  tivihaar: 'tivihar',
  duvihar: 'duvihar',
  navkarsi: 'navkarsi',
  navakarsi: 'navkarsi',
  navkarshi: 'navkarsi',
  porsi: 'porsi',
  porasi: 'porsi',
  porisi: 'porsi',
  porsee: 'porsi',
  purimuddh: 'purimuddh',
  avadhdh: 'avadhdh',
  atthai: 'atthai',
  athai: 'atthai',
  attham: 'attham',
  chhath: 'chhath',
  masakshaman: 'masakshaman',
  paryushana: 'paryushana',
  paryushan: 'paryushana',
};

// Normalize: lowercase, strip diacritics, collapse repeated letters
// ("pachchakhan" → "pachakhan") so transliteration noise is reduced
// before fuzzy comparison.
function normalize(token) {
  return token
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/(.)\1+/g, '$1');
}

// Levenshtein distance, capped early for performance
function lev(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Pre-normalize the wordlist once at module load
const NORMALIZED_TERMS = Object.entries(FAST_TERMS).map(
  ([term, category]) => [normalize(term), category, term]
);

/**
 * Scan a message for any fast-term variant.
 * Returns: { matched, category, term, matchedToken }
 *   - matched: true if any token resembled a known fast term
 *   - category: canonical category (e.g. 'ayambil', 'pachkhan_general')
 *   - term: canonical spelling from the wordlist
 *   - matchedToken: the raw token from the user's message
 */
export function detectFastTerm(text) {
  if (!text) return { matched: false, category: null, term: null, matchedToken: null };

  const tokens = text.split(/[\s,.\?!;:()\[\]"']+/).filter(Boolean);
  let general = null; // remember a pachkhan_general hit, but keep looking for specific

  for (const raw of tokens) {
    const norm = normalize(raw);
    if (norm.length < 4) continue;

    // Exact normalized match
    const exact = NORMALIZED_TERMS.find(([n]) => n === norm);
    if (exact) {
      const hit = { matched: true, category: exact[1], term: exact[2], matchedToken: raw };
      if (exact[1] === 'pachkhan_general') { general = general || hit; continue; }
      return hit; // specific fast wins immediately
    }

    // Fuzzy match
    const threshold = norm.length >= 7 ? 2 : 1;
    for (const [n, category, term] of NORMALIZED_TERMS) {
      if (Math.abs(n.length - norm.length) > threshold) continue;
      if (lev(norm, n) <= threshold) {
        const hit = { matched: true, category, term, matchedToken: raw };
        if (category === 'pachkhan_general') { general = general || hit; break; }
        return hit; // specific fast wins
      }
    }
  }

  // No specific fast found — return the general match if there was one
  return general || { matched: false, category: null, term: null, matchedToken: null };
}
