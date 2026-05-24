// Samta v2.5
// ============================================
// worker.js — Main Cloudflare Worker handler
// location.js now used only by rebuild-restaurant.js
// ============================================
import { classify } from './src/classify.js';
import { readPending } from './src/pending.js';
import { rulesFor, rulesForNumber, FAST_MENU } from './src/fasting-rules.js';
import { serializePending } from './src/pending.js';
import { handleRebuildSunset, rebuildSunsetClaims } from './src/rebuild-sunset.js';
import { handleRebuildRestaurant, rebuildRestaurantClaims } from './src/rebuild-restaurant.js';
import { getUser, createUser, updateUser, deleteUser, setFlagKV } from './src/database.js';
import { routeFallback } from './src/route-fallback.js';
import { sendMessage, sendReaction, sendImage, getImageAsBase64 } from './src/whatsapp.js';
import { callClaude } from './src/claude.js';
import { parseProfileUpdate, stripTags, buildSystemPrompt, classifyQuery } from './src/utils.js';
import {
  DEFAULT_DIET,
  getWelcomeMessage,
  getStrictnessQuestion,
  applyStrictnessReply,
} from './src/onboarding.js';
import { getCalendarCached, getTodayAndUpcomingEvents, formatEventsForClaude } from './src/calendar.js';
import {
  geocodeCity,
  getSunForPlace,
  getSunriseSunset,
  placeFromUser,
  formatSunDataForClaude,
  detectSunsetQuery,
  extractCityFromSunQuery
} from './src/sunset.js';

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const VIN_FAMILY_URL = 'https://raw.githubusercontent.com/shah434/whatsapp-religious-friend/ad4ff7ebb697e22a7ba7abac1e0c94e4c7af3987/vin%20family.png';
const VIN_GOODBYE_URL = 'https://raw.githubusercontent.com/shah434/whatsapp-religious-friend/ad4ff7ebb697e22a7ba7abac1e0c94e4c7af3987/vin%20goodbye.png';
const VIN_STAY_URL = 'https://raw.githubusercontent.com/shah434/whatsapp-religious-friend/403944f9447d7975e07322f8cdaca25030dc50b0/vin%20stay.png';

const KV_PENDING_DELETE_PREFIX = 'pending_delete:';
const PENDING_DELETE_TTL = 600; // 10 minutes

const SILENT_DROP_TYPES = new Set([
  'reaction', 'system', 'interactive', 'button', 'unsupported', 'unknown'
]);

const STRICTNESS_SENSITIVE = new Set([
  'general', 'label_scan', 'restaurant', 'substitution', 'medicine'
]);

// Tithi CLAIM patterns — only fire the guard on assertive statements
// about today, not on the mere mention of the word "tithi".
const TITHI_CLAIM_PATTERNS = [
  /\btoday\s+is\s+(a\s+)?(?:beej|bij|chaturdashi|chaumasi|paryushan(?:a)?|ekadashi|atthai|attham|chhath|punam|ashtami|nom|amavasya|purnima|fast day|tithi)\b/i,
  /\b(?:it\s+is|it'?s)\s+(?:beej|bij|chaturdashi|chaumasi|paryushan(?:a)?|ekadashi|atthai|attham|chhath|punam|ashtami|nom|amavasya|purnima)\b/i,
  /\bno food (?:should be eaten )?until tomorrow\b/i,
  /\btoday\s+is\s+a\s+fast(?:ing)?\s+day\b/i,
  /\(\s*(?:beej|bij|chaturdashi|chaumasi|paryushan(?:a)?|a fasting day)\s*\)/i,
];

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function isTithiQuery(text) {
  const lower = (text || '').toLowerCase();
  return /\btithi\b/.test(lower)
    || /\bfast day\b/.test(lower)
    || /\b(is today|today.*(special|tithi)|what.*tithi)\b/.test(lower);
}

function isLikelyGreeting(text) {
  return /^(hi|hello|hey|jai jinendra|namaste|hola)\b/i.test((text || '').trim());
}

function isBareGreeting(text) {
  return /^(hi|hello|hey|hola|namaste|jai jinendra)\b\s*[!.?]?$/i.test((text || '').trim());
}

function defaultTimezoneFromPhone(phone) {
  if (phone.startsWith('91')) return 'Asia/Kolkata';
  if (phone.startsWith('44')) return 'Europe/London';
  if (phone.startsWith('971')) return 'Asia/Dubai';
  if (phone.startsWith('65')) return 'Asia/Singapore';
  if (phone.startsWith('61')) return 'Australia/Sydney';
  if (phone.startsWith('254')) return 'Africa/Nairobi';
  if (phone.startsWith('27')) return 'Africa/Johannesburg';
  return 'America/New_York';
}

// Persist a fully-resolved place to both the DB and the in-memory user object.
async function saveResolvedCity(phone, user, place, sunInfo, env, extraFields = {}) {
  const fields = {
    city: sunInfo.city,
    timezone: sunInfo.timezoneId,
    latitude: place.latitude,
    longitude: place.longitude,
    ...extraFields
  };
  await updateUser(phone, fields, env);
  user.city = sunInfo.city;
  user.timezone = sunInfo.timezoneId;
  user.latitude = place.latitude;
  user.longitude = place.longitude;
}

// ────────────────────────────────────────────────────────────────────────────
// Worker
// ────────────────────────────────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    try {
      const events = await getTodayAndUpcomingEvents();
      await env.KV.put('jain_calendar_events', JSON.stringify(events), { expirationTtl: 86400 });
      console.log('Calendar cache pre-warmed:', events.length, 'events');
    } catch (err) {
      console.log('Scheduled calendar refresh error:', err.message);
    }
  },

  async fetch(req, env, ctx) {

    if (req.method === 'GET') {
      const url = new URL(req.url);
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }

    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const body = await req.json();

      const statuses = body?.entry?.[0]?.changes?.[0]?.value?.statuses;
      if (statuses) return new Response('OK', { status: 200 });

      const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!message) return new Response('OK', { status: 200 });

      const phone = message.from;
      const messageId = message.id;
      const messageType = message.type;

      if (SILENT_DROP_TYPES.has(messageType)) {
        return new Response('OK', { status: 200 });
      }

      if (!['text', 'image'].includes(messageType)) {
        await sendMessage(
          phone,
          'I can only read text messages and food label photos. Please send a text question or a photo of a label.',
          env
        );
        return new Response('OK', { status: 200 });
      }

      // -- Scale brake: manual throttle switch -------------------------------
      // Flip with: KV put mode:throttled = "1". Existing users keep working;
      // new users get a hold message. Clears instantly on KV delete, no deploy.
      const throttled = await env.KV.get('mode:throttled');
      if (throttled) {
        const existing = await getUser(phone, env);
        if (!existing) {
          await sendMessage(phone, `We're experiencing high demand right now 🙏 Please try again tomorrow.`, env);
          return new Response('OK', { status: 200 });
        }
      }

      // -- Scale brake: per-user daily rate limit (50/day) -------------------
      const today = new Date().toISOString().slice(0, 10);
      const rlKey = `ratelimit:${phone}:${today}`;
      const count = parseInt(await env.KV.get(rlKey) || '0', 10);
      if (count >= 50) {
        await sendMessage(phone, `You've hit today's limit 🙏 Back tomorrow.`, env);
        return new Response('OK', { status: 200 });
      }
      await env.KV.put(rlKey, String(count + 1), { expirationTtl: 86400 });

      // -- Scale brake: global daily spend ceiling ($10, soft) ---------------
      const spendDay = new Date().toISOString().slice(0, 10);
      const spend = parseFloat(await env.KV.get(`spend:${spendDay}`) || '0');
      if (spend >= 10) {
        if (messageType === 'image') {
          await sendMessage(phone, `We're at capacity for image scans today 🙏 Text questions still work.`, env);
          return new Response('OK', { status: 200 });
        }
        if (spend >= 12) {
          await sendMessage(phone, `We're at capacity today 🙏 Please try again tomorrow.`, env);
          return new Response('OK', { status: 200 });
        }
      }
      
      let text = message.text?.body || message.image?.caption || '';
      const t0 = Date.now();

      if (messageType === 'image') {
        sendMessage(phone, 'Reviewing your request... 🔍', env);
      }

      // -- Phase 1: Parallel I/O ---------------------------------------------
      const imagePromise = messageType === 'image'
        ? getImageAsBase64(message.image.id, message.image.mime_type, env)
        : null;

      let user, calendarEvents;
      [, user, calendarEvents] = await Promise.all([
        sendReaction(phone, messageId, env),
        getUser(phone, env),
        getCalendarCached(env),
      ]);
      console.log(`[perf] phase1_parallel=${Date.now() - t0}ms type=${messageType}`);

      // -- New user creation + welcome ---------------------------------------
      if (!user) {
        user = await createUser(phone, {
          community: DEFAULT_DIET,
          timezone: defaultTimezoneFromPhone(phone)
        }, env);
        await sendMessage(phone, getWelcomeMessage(), env);

        const isJustGreeting = messageType === 'text' && (
          isBareGreeting(text) || text.trim().toLowerCase() === 'help'
        );
        if (isJustGreeting) {
          return new Response('OK', { status: 200 });
        }
        // Fall through — answer the question too
      }

      // -- Pending delete confirmation ---------------------------------------
      const pendingDeleteKey = `${KV_PENDING_DELETE_PREFIX}${phone}`;
      const pendingDelete = await env.KV.get(pendingDeleteKey);
      if (pendingDelete && messageType === 'text') {
        await env.KV.delete(pendingDeleteKey);
        if (text.trim().toUpperCase() === 'YES') {
          await deleteUser(phone, env);
          await sendImage(phone, VIN_GOODBYE_URL, "You've been removed from the family. Take care. 🙏", env);
        } else {
          await sendImage(phone, VIN_STAY_URL, "Deletion cancelled — you're still family. 🙏", env);
        }
        return new Response('OK', { status: 200 });
      }

      // -- "delete me" keyword -----------------------------------------------
      if (messageType === 'text' && text.trim().toLowerCase() === 'delete me') {
        await env.KV.put(pendingDeleteKey, '1', { expirationTtl: PENDING_DELETE_TTL });
        await sendImage(
          phone,
          VIN_FAMILY_URL,
          'Are you sure you want to leave the family? Reply YES to confirm, or anything else to cancel.',
          env
        );
        return new Response('OK', { status: 200 });
      }

      // -- "help" keyword ----------------------------------------------------
      if (messageType === 'text' && text.trim().toLowerCase() === 'help') {
        await sendMessage(phone, getWelcomeMessage(), env);
        return new Response('OK', { status: 200 });
      }

      // -- Bare greeting → show welcome --------------------------------------
      if (messageType === 'text' && isBareGreeting(text)) {
        await sendMessage(phone, getWelcomeMessage(), env);
        return new Response('OK', { status: 200 });
      }

 // -- REBUILD: new-foundation sunset path -------------------------------
      // Runs AFTER the keyword checks above (delete me / help / greeting /
      // pending-delete) so those commands always win over a pending sunset
      // resume. classify() decides; only sunset is wired to the new path —
      // everything else falls through to the old code below.
      if (messageType === 'text') {
        const rbIntent = classify(text, false);
        if (rebuildSunsetClaims(user, rbIntent, text)) {
          const handled = await handleRebuildSunset(phone, text, user, rbIntent, env);
          if (handled) return new Response('OK', { status: 200 });
        }
if (rebuildRestaurantClaims(user, rbIntent, text)) {
          const handled = await handleRebuildRestaurant(phone, text, user, rbIntent, env);
          if (handled) return new Response('OK', { status: 200 });
        }

        
        // Fallback router: classify defaulted to food with no real food signal
        // → ambiguous message. Ask Haiku for the journey + city, then re-route
        // city journeys through the same handlers (pending/resume stays intact).
        const ambiguous = rbIntent.journey === 'food'
          && !rbIntent.params.food_text
          && !rbIntent.params.has_image;
        if (ambiguous) {
          const r = await routeFallback(text, env);
          if (r && (r.journey === 'restaurant' || r.journey === 'sunset')) {
            const routed = {
              journey: r.journey,
              params: r.city ? { city_raw: r.city } : {},
              prompt_blocks: r.journey === 'sunset' ? ['calendar'] : ['restaurant'],
            };
            if (r.city) {
              // city present → bypass claim's bare-reply gate, call handler directly
              const handled = r.journey === 'sunset'
                ? await handleRebuildSunset(phone, text, user, routed, env)
                : await handleRebuildRestaurant(phone, text, user, routed, env);
              if (handled) return new Response('OK', { status: 200 });
            } else {
              // no city → handler will ask, using saved city if present
              const handled = r.journey === 'sunset'
                ? await handleRebuildSunset(phone, text, user, routed, env)
                : await handleRebuildRestaurant(phone, text, user, routed, env);
              if (handled) return new Response('OK', { status: 200 });
            }
          }
        }

// -- Code-driven fasting (flat 1-7; option 8 → prompt) -------------
        {
          const fastPending = readPending(user.pending_action);
          const reply = text.trim();

          if (fastPending && fastPending.need === 'fast_pick') {
            if (/^[1-7]$/.test(reply)) {
              const rules = rulesForNumber(parseInt(reply, 10));
              if (rules) {
                await updateUser(phone, { pending_action: null }, env);
                await sendMessage(phone, rules, env);
                return new Response('OK', { status: 200 });
              }
            }
            if (rbIntent.params.fast_term && rbIntent.params.fast_term !== 'pachkhan_general') {
              const rules = rulesFor(rbIntent.params.fast_term);
              if (rules) {
                await updateUser(phone, { pending_action: null }, env);
                await sendMessage(phone, rules, env);
                return new Response('OK', { status: 200 });
              }
            }
            if (reply === '8') {
              await updateUser(phone, { pending_action: null }, env);
            }
          }

          if (rbIntent.params.fast_term) {
            const ft = rbIntent.params.fast_term;
            if (ft === 'pachkhan_general') {
              const rec = serializePending({ need: 'fast_pick', intent: rbIntent });
              await updateUser(phone, { pending_action: rec }, env);
              await sendMessage(phone, FAST_MENU, env);
              return new Response('OK', { status: 200 });
            }
            const rules = rulesFor(ft);
            if (rules) {
              await sendMessage(phone, rules, env);
              return new Response('OK', { status: 200 });
            }
          }
        }
        
        // Sunset didn't claim it → this is a fresh message. Abandon any stale
        // city pending so a later "1" or city name can't resume a dead flow.
        if (user.pending_action) {
          const p = readPending(user.pending_action);
          if (p && (p.need === 'city' || p.need === 'city_pick')) {
            await updateUser(phone, { pending_action: null }, env);
            user.pending_action = null;
          }
        }
      }
            
      // -- Pending strictness reply check ------------------------------------
      if (user.pending_strictness_ask && messageType === 'text') {
        const handled = await applyStrictnessReply(phone, text, env);
        if (handled) return new Response('OK', { status: 200 });
        user = await getUser(phone, env);
      }

      // -- Pending city reply check ------------------------------------------
      if (user.pending_tithi_city_ask && messageType === 'text') {
        const replyCity = text.trim();

        // Path 1: numeric pick from a previous disambiguation list
        const numericPick = /^[1-4]$/.test(replyCity) ? parseInt(replyCity) : null;
        if (numericPick && user.pending_city_choices) {
          let choices = null;
          try { choices = JSON.parse(user.pending_city_choices); } catch {}
          const picked = choices && choices[numericPick - 1];
          if (picked) {
            const sunInfo = await getSunForPlace(picked);
            if (sunInfo) {
              await saveResolvedCity(phone, user, picked, sunInfo, env, {
                pending_tithi_city_ask: false,
                pending_city_choices: null
              });
              user._justResolvedCity = true;
              text = user.history_1_q || '';
              // fall through with replayed text
            } else {
              await sendMessage(phone, `Sorry — I couldn't look up that city right now. Please try again in a moment.`, env);
              return new Response('OK', { status: 200 });
            }
          } else {
            await updateUser(phone, { pending_city_choices: null, pending_tithi_city_ask: false }, env);
            await sendMessage(phone, `That number didn't match the list I sent. Please type your city name again 🙏`, env);
            return new Response('OK', { status: 200 });
          }
        }
        // Path 2: user typed a city name
        else if (replyCity.length >= 2 && replyCity.length <= 50) {
          const geo = await geocodeCity(replyCity);

          if (geo.status === 'not_found') {
            await sendMessage(phone, `I couldn't find that city. Please type the full city name with state or country, or your zip code.`, env);
            return new Response('OK', { status: 200 });
          }

          if (geo.status === 'ambiguous') {
            const lines = geo.candidates.map((c, i) =>
              `${i + 1} — ${c.name}${c.admin1 ? ', ' + c.admin1 : ''}, ${c.country}`
            ).join('\n');
            await updateUser(phone, { pending_city_choices: JSON.stringify(geo.candidates) }, env);
            await sendMessage(phone, `I found a few places called "${replyCity}". Which one?\n\n${lines}\n\nReply with the number.`, env);
            return new Response('OK', { status: 200 });
          }

          // status === 'unique'
          const sunInfo = await getSunForPlace(geo.place);
          if (!sunInfo) {
            await sendMessage(phone, `Sorry — I couldn't look up that city right now. Please try again in a moment.`, env);
            return new Response('OK', { status: 200 });
          }
          await saveResolvedCity(phone, user, geo.place, sunInfo, env, {
            pending_tithi_city_ask: false,
            pending_city_choices: null
          });
          user._justResolvedCity = true;
          text = user.history_1_q || '';
          // fall through with replayed text
        }
        // Path 3: junk input — clear and continue
        else {
          await setFlagKV(phone, { pending_tithi_city_ask: false }, env);
          user.pending_tithi_city_ask = false;
        }

        if (user._justResolvedCity && (!text || !text.trim())) {
          await sendMessage(phone, `Got it — saved your city as ${user.city}. What would you like to check? 🙏`, env);
          return new Response('OK', { status: 200 });
        }
      }

      // -- Tithi-city ask ----------------------------------------------------
      if (isTithiQuery(text) && !user.city && messageType === 'text' && !user.pending_tithi_city_ask) {
        await setFlagKV(phone, { pending_tithi_city_ask: true }, env);
        await sendMessage(
          phone,
          `Which city are you in? Tithis depend on the lunar cycle and shift slightly by location, so I want to give you the right answer 🙏`,
          env
        );
        return new Response('OK', { status: 200 });
      }

     let googleResults = [];

      // -- Sunset / sunrise --------------------------------------------------
      let sunData = '';
      if (detectSunsetQuery(text)) {
        const cityFromMessage = user._justResolvedCity ? null : extractCityFromSunQuery(text);

        // Case A: new city in message
        if (cityFromMessage && cityFromMessage.length > 2 && !cityFromMessage.toLowerCase().includes('time')) {
          const geo = await geocodeCity(cityFromMessage);

          if (geo.status === 'not_found') {
            await sendMessage(
              phone,
              `I couldn't find "${cityFromMessage}". Please type the city name with state or country, or your zip code.`,
              env
            );
            return new Response('OK', { status: 200 });
          }

          if (geo.status === 'ambiguous') {
            const lines = geo.candidates.map((c, i) =>
              `${i + 1} — ${c.name}${c.admin1 ? ', ' + c.admin1 : ''}, ${c.country}`
            ).join('\n');
            await updateUser(phone, {
              pending_city_choices: JSON.stringify(geo.candidates),
              pending_tithi_city_ask: true,
              history_1_q: text
            }, env);
            await sendMessage(
              phone,
              `I found a few places called "${cityFromMessage}". Which one?\n\n${lines}\n\nReply with the number.`,
              env
            );
            return new Response('OK', { status: 200 });
          }

          // status === 'unique' — save resolved place, then continue
          const sunInfo = await getSunForPlace(geo.place);
          if (sunInfo) {
            await saveResolvedCity(phone, user, geo.place, sunInfo, env);
            sunData = formatSunDataForClaude(sunInfo);
          } else {
            sunData = 'SUNSET QUERY: lookup failed. Apologize briefly and ask the user to try again.';
          }
        }
        // Case B: no city in message → use saved coordinates if we have them
        else if (user.city) {
          const place = placeFromUser(user);
          let sunInfo = null;
          if (place) {
            sunInfo = await getSunForPlace(place);
          } else {
            const geo = await geocodeCity(user.city);
            if (geo.status === 'unique') {
              sunInfo = await getSunForPlace(geo.place);
              if (sunInfo) {
                await saveResolvedCity(phone, user, geo.place, sunInfo, env);
              }
            }
          }

          if (sunInfo) {
            sunData = formatSunDataForClaude(sunInfo);
            if (sunInfo.timezoneId && sunInfo.timezoneId !== user.timezone) {
              await updateUser(phone, { timezone: sunInfo.timezoneId }, env);
              user.timezone = sunInfo.timezoneId;
            }
          } else {
            sunData = 'SUNSET QUERY: lookup failed for stored city. Apologize briefly and ask the user to retry.';
          }
        }
        // Case C: no city anywhere
        else {
          sunData = 'SUNSET QUERY: User asked about sunset but no city in message and none stored. Ask which city.';
        }
      }

      // -- Classify query ----------------------------------------------------
      const queryTypes = classifyQuery(text, messageType === 'image');

      if (queryTypes.length === 1 && queryTypes[0] === 'general' && text && text.length < 30) {
console.log(`[unmatched-short] phone=${phone} len=${text.length}`);      }

      const lastBotReply = (user.history_1_a || '').toLowerCase();
      const isShortReply = text.trim().length < 20;
      const isReplyToFastMenu = isShortReply && /fast|upvas|ekasan|ayambil|chauvihar|tivihar|atthai|porsi|biyasan|navkarsi/i.test(lastBotReply);
      if (isReplyToFastMenu && !queryTypes.includes('fasting')) {
        queryTypes.push('fasting');
      }

      // -- Calendar — Jain only, gated on onboarding completion --------------
      let calendarData = '';
      if (user.community === 'jain') {
        const needsFullCalendar = queryTypes.includes('fasting')
          || queryTypes.includes('calendar')
          || /paryushana|coming|upcoming|next/i.test(text);
        const calendarLimit = needsFullCalendar ? 10 : 3;
        calendarData = formatEventsForClaude(calendarEvents, user.timezone, calendarLimit);
      }

      let tithiFact = '';
      const m = calendarData.match(/TODAY_IS_TITHI:\s*true[\s\S]*?TODAY_TITHI_NAME:\s*(.+)/i);
      if (m) tithiFact = `Today is ${m[1].trim()} 🙏\n\n`;
      // -- Build Claude messages ---------------------------------------------
      let claudeMessages = [];

      if (messageType === 'image') {
        try {
          const { base64, mimeType } = await imagePromise;
          console.log(`[perf] image_ready=${Date.now() - t0}ms`);
          claudeMessages = [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mimeType, data: base64 }
              },
              {
                type: 'text',
                text: text || 'Please scan this food label or product and check if it is safe for my diet.'
              }
            ]
          }];
        } catch (err) {
          console.log('Image processing error:', err.message);
          await sendMessage(
            phone,
            'I could not process that image. Please try a clearer photo or type out the ingredients list.',
            env
          );
          return new Response('OK', { status: 200 });
        }
      } else {
        claudeMessages = [{ role: 'user', content: text }];
      }

      // -- System prompt + Claude call ---------------------------------------
      const system = buildSystemPrompt(user, googleResults, calendarData, sunData, queryTypes);
      console.log(`[perf] claude_start=${Date.now() - t0}ms`);
      const response = await callClaude(claudeMessages, system, env);
      console.log(`[perf] claude_done=${Date.now() - t0}ms`);

      const updates = parseProfileUpdate(response);
      let cleanResponse = stripTags(response);
      cleanResponse = cleanResponse
        .replace(/TODAY_IS_TITHI:\s*(true|false)/gi, '')
        .replace(/TODAY_TITHI_NAME:.*$/gim, '')
        .trim();

      // -- Tithi-claim guard -------------------------------------------------
      const calendarHadToday = /TODAY_IS_TITHI:\s*true/i.test(calendarData);
      const claimsTithiToday = TITHI_CLAIM_PATTERNS.some(p => p.test(cleanResponse));
      if (!calendarHadToday && claimsTithiToday) {
        console.log(`[guard] stripped_tithi_claim phone=${phone} response="${cleanResponse.slice(0, 200)}"`);
        const sentences = cleanResponse.split(/(?<=[.!?])\s+/);
        cleanResponse = sentences
          .filter(s => !TITHI_CLAIM_PATTERNS.some(p => p.test(s)))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!cleanResponse) {
          cleanResponse = "Let me know what you'd like to check 🙏";
        }
      }

      // -- Profile updates from Claude ---------------------------------------
      if (updates.strictness || updates.community) {
        await updateUser(phone, {
          ...(updates.strictness && { strictness: updates.strictness }),
          ...(updates.community && { community: updates.community })
        }, env);
      }

      if (updates.city) {
        const geo = await geocodeCity(updates.city);

        if (geo.status === 'unique') {
          const sunInfo = await getSunForPlace(geo.place);
          if (sunInfo) {
            await saveResolvedCity(phone, user, geo.place, sunInfo, env);
          }
        } else if (geo.status === 'ambiguous') {
          const lines = geo.candidates.map((c, i) =>
            `${i + 1} — ${c.name}${c.admin1 ? ', ' + c.admin1 : ''}, ${c.country}`
          ).join('\n');
          await updateUser(phone, {
            pending_city_choices: JSON.stringify(geo.candidates),
            pending_tithi_city_ask: true,
            history_1_q: text
          }, env);
          await sendMessage(
            phone,
            `Before I save that — I found a few places called "${updates.city}". Which one?\n\n${lines}\n\nReply with the number.`,
            env
          );
          return new Response('OK', { status: 200 });
        }
        // status === 'not_found' — silently skip the save
      }

      // -- Strictness ask append ---------------------------------------------
      cleanResponse = cleanResponse.replace(/\[ASK_STRICTNESS\]/gi, '').trim();

      const isFasting = queryTypes.includes('fasting');
      const isStrictnessSensitive = queryTypes.some(t => STRICTNESS_SENSITIVE.has(t));
      const levelsShown = [/\bif strict\b/i, /\bif moderate\b/i, /\bif flexible\b/i]
        .filter(re => re.test(cleanResponse)).length;
      const hasDualVerdict = levelsShown > 1;
      const needsStrictnessAsk = !user.strictness
        && !updates.strictness
        && isStrictnessSensitive
        && !isFasting
        && !isLikelyGreeting(text)
        && hasDualVerdict;

      if (needsStrictnessAsk) {
        cleanResponse += '\n\n' + getStrictnessQuestion();
        cleanResponse += '\n\n💡 Type *help* anytime to see what else I can do.';
        await setFlagKV(phone, { pending_strictness_ask: true }, env);
      }

      // -- Send response -----------------------------------------------------
      if (!cleanResponse || !cleanResponse.trim()) {
        console.log(`[empty_response] phone=${phone} queryTypes=${queryTypes.join(',')}`);
        cleanResponse = "Let me know what you'd like to check 🙏";
      }
      await sendMessage(phone, tithiFact + cleanResponse, env);
      console.log(`[perf] sent=${Date.now() - t0}ms TOTAL`);

      // -- Deferred Supabase write -------------------------------------------
      ctx.waitUntil((async () => {
        await updateUser(phone, {
          history_1_q: text,
          history_1_a: cleanResponse,
          history_2_q: user.history_1_q || '',
          history_2_a: user.history_1_a || '',
          history_3_q: user.history_2_q || '',
          history_3_a: user.history_2_a || '',
          message_count: (user.message_count || 0) + 1,
          ...(needsStrictnessAsk && { pending_strictness_ask: true }),
        }, env);
      })());

      return new Response('OK', { status: 200 });

    } catch (err) {
      console.log('Main handler error:', err.message, err.stack);
      try {
        const debugBody = await req.clone().json();
        const debugPhone = debugBody?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
        if (debugPhone) {
          const msg = env.DEBUG === 'true'
            ? `⚠️ Error: ${err.message}\n${(err.stack || '').slice(0, 500)}`
            : 'Something went wrong on my end — please try again in a moment 🙏';
          await sendMessage(debugPhone, msg, env);
        }
      } catch {}
      return new Response('OK', { status: 200 });
    }
  }
};
