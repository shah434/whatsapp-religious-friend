# Future Considerations

## Prompt Behavior Test Suite

Deferred until activity warrants the cost. Estimated ~$0.07/run with prompt caching, ~$0.22/run without. Recommend triggering only when `src/prompts.js` or `src/utils.js` change (not on every push).

### Test cases to implement

**Strictness routing**
- No strictness set + strictness-sensitive query (potato, onion, E471) → dual "If strict / If flexible" format
- No strictness set + non-sensitive query (cabbage, ghee) → single verdict
- Strict / moderate / flexible users each get correct verdict for potato, brinjal, onion
- Note: dual format collapses moderate into flexible — worth monitoring for user confusion

**Jain vs BAPS cross-contamination**
- BAPS user: potato/carrot/mushrooms must be SAFE at all levels
- Jain strict user: same ingredients must be NOT SAFE
- BAPS user: fermented foods (idli, dosa) must be SAFE
- Jain user: "Ekadashi" must never appear; BAPS user: "tithi" must not be primary term
- Jain user mentions Paryushana: stricter rules apply even at flexible, family disclaimer appended

**Calendar / tithi awareness**
- TODAY_IS_TITHI: false → food verdict only, zero mention of tithi or fasting
- TODAY_IS_TITHI: true → food verdict + observance name + fast type question
- Upcoming event in calendar → must not be treated as today
- No calendar block in prompt → Claude must not infer tithi from training data
- BAPS calendar query → directs to baps.org/Calendar, no date calculation

**Sunset / sunrise accuracy**
- Verbatim time from data block — no rounding (8:14 PM must not become 8:15 PM)
- No stored city, no city in message → ask before giving time
- Stored city present → use it and say so

**Fasting flow**
- Unknown fast type → numbered menu, no food verdict
- Named fast (ayambil, upvas) → skip menu, apply rules directly
- Upvas food question → always NOT SAFE
- Ayambil: paneer must be NOT SAFE (no dairy)
- BAPS fasting: Ekadashi menu (Nirjala/Jalahar/Farari), not Jain menu
- BAPS farari: sabudana SAFE, rice NOT SAFE

**Label scanning**
- Gelatin → NOT SAFE all levels
- E120 → NOT SAFE all levels
- E471 → uncertain for strict/moderate, no flag for flexible
- Natural flavors → uncertain for strict/moderate, permitted for flexible
- Vitamin D3 → uncertain; Vitamin D2 → SAFE
- Jain user: potato starch in ingredients → flag; BAPS user → do NOT flag
- Unclear image → exact scripted response
- Dish photo: open with "The image looks to be of..." — no meta-commentary about it not being a label

**Restaurant flow**
- Google results provided → format includes name, address, phone, rating, open status
- No Google results → exact scripted location ask, no extra tips
- New city in message → [CITY_UPDATE:] tag in raw response, stripped from user-facing text
- Jain: shared fryer and onion/garlic in sauces flagged; BAPS: root veg not flagged

**Response format**
- General dietary questions: 3 lines max, verdict first
- SAFE verdict: no follow-up offer
- NOT SAFE on packaged food: offer label scan
- Label scan not safe: offer substitution
- Bare topic words ("sunset", "label", "pachkhan"): exact scripted clarifying question, no "Jai Jinendra" opener

**Medicine**
- Any prescription drug mention → non-negotiable disclaimer about not changing medication
- Gelatin capsule, no HPMC confirmation → flag uncertain, recommend vegetarian alternative
- Omega-3 → NOT SAFE unless explicitly labelled algae-based
