// Samta v2.3
// ============================================
// worker.js — Main Cloudflare Worker handler
// ============================================
// v2.3 changes from v2.2:
//   - isTithiQuery tightened — "I want to fast today" no longer triggers
//     the tithi-city ask flow
//   - Pending tithi-city reply now synthesizes the user's original question
//     so the bot doesn't lose conversational thread after the city is set
//   - Dual-verdict detection — strictness ask only fires when Claude
//     actually gave a dual-level (If strict / If flexible) response
// ============================================

import { getUser, createUser, updateUser, deleteUser, setFlagKV } from './src/database.js';
import { sendMessage, sendReaction, sendImage, getImageAsBase64 } from './src/whatsapp.js';
import { callClaude } from './src/claude.js';
import { searchRestaurants, detectLocation } from './src/location.js';
import { parseProfileUpdate, stripTags, buildSystemPrompt, classifyQuery } from './src/utils.js';
import {
  DEFAULT_DIET,
  getWelcomeMessage,
  getStrictnessQuestion,
  applyStrictnessReply,
} from './src/onboarding.js';
import { getCalendarCached, getTodayAndUpcomingEvents, formatEventsForClaude } from './src/calendar.js';
import { geocodeCity, getSunForPlace, getSunriseSunset, formatSunDataForClaude, detectSunsetQuery, extractCityFromSunQuery } from './src/sunset.js';

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

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

// Detects tithi/calendar queries. Tightened in v2.3 — no longer matches
// generic "I want to fast today" since that's a fasting setup query, not
// a tithi lookup.
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

// Rough timezone guess from WhatsApp phone country code.
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

// ────────────────────────────────────────────────────────────────────────────
// Worker
// ────────────────────────────────────────────────────────────────────────────

export default {
  // Cron trigger: pre-warms calendar cache daily at midnight UTC
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

    // -- Meta webhook verification --------------------------------------------
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
        return new Response('OK', { status: 200 });
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

      // -- Pending strictness reply check ------------------------------------
      if (user.pending_strictness_ask && messageType === 'text') {
        const handled = await applyStrictnessReply(phone, text, env);
        if (handled) return new Response('OK', { status: 200 });
        user = await getUser(phone, env);
      }

      // -- Pending tithi-city reply check ------------------------------------
      // When the previous turn asked for a city, the user's reply is the city.
      // Geocode it, save city + timezone, then SYNTHESIZE their original
      // question so the rest of the flow answers what they actually asked —
      // not "Chicago" as a fresh start.
      if (user.pending_tithi_city_ask && messageType === 'text') {
  const replyCity = text.trim();

  // Handle disambiguation reply: user picked 1/2/3/4 from a previous list
  const numericPick = /^[1-4]$/.test(replyCity) ? parseInt(replyCity) : null;
  if (numericPick && user.pending_city_choices) {
    const choices = JSON.parse(user.pending_city_choices);
    const picked = choices[numericPick - 1];
    if (picked) {
      const sunInfo = await getSunForPlace(picked);
      await updateUser(phone, {
        city: sunInfo.city,
        timezone: sunInfo.timezoneId,
        pending_tithi_city_ask: false,
        pending_city_choices: null
      }, env);
      user.city = sunInfo.city;
      user.timezone = sunInfo.timezoneId;
      // fall through with synthesized text below
      const lastQ = user.history_1_q || '';
            if (/sunset|sunrise|sun\s*(set|rise)/i.test(lastQ)) {
              text = lastQ;
            } else if (/tithi|fast|today|special/i.test(lastQ)) {
              text = lastQ;
            } else {
              // Genuinely don't know what they asked — default to a soft
              // acknowledgment rather than guessing at tithi.
              text = `Got it — saved your city as ${user.city}. What can I help you with?`;
            }
    }
  } else if (replyCity.length >= 2 && replyCity.length <= 50) {
    const geo = await geocodeCity(replyCity);

    if (geo.status === 'not_found') {
      await sendMessage(
        phone,
        `I couldn't find that city. Please type the full city name with state/country, or your zip code.`,
        env
      );
      return new Response('OK', { status: 200 });
    }

    if (geo.status === 'ambiguous') {
      const lines = geo.candidates.map((c, i) =>
        `${i + 1} — ${c.name}${c.admin1 ? ', ' + c.admin1 : ''}, ${c.country}`
      ).join('\n');
      await updateUser(phone, {
        pending_city_choices: JSON.stringify(geo.candidates)
        // keep pending_tithi_city_ask = true so next numeric reply is captured
      }, env);
      await sendMessage(
        phone,
        `I found a few places called "${replyCity}". Which one?\n${lines}\n\nReply with the number.`,
        env
      );
      return new Response('OK', { status: 200 });
    }

    // status === 'unique'
    const sunInfo = await getSunForPlace(geo.place);
    await updateUser(phone, {
      city: sunInfo.city,
      timezone: sunInfo.timezoneId,
      pending_tithi_city_ask: false
    }, env);
    user.city = sunInfo.city;
    user.timezone = sunInfo.timezoneId;
    const lastQ = user.history_1_q || '';
            if (/sunset|sunrise|sun\s*(set|rise)/i.test(lastQ)) {
              text = lastQ;
            } else if (/tithi|fast|today|special/i.test(lastQ)) {
              text = lastQ;
            } else {
              // Genuinely don't know what they asked — default to a soft
              // acknowledgment rather than guessing at tithi.
              text = `Got it — saved your city as ${user.city}. What can I help you with?`;
            }
    // fall through
  } else {
    await setFlagKV(phone, { pending_tithi_city_ask: false }, env);
    user.pending_tithi_city_ask = false;
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

      // -- Enrichment: restaurant / sunset -----------------------------------
      let googleResults = [];
      const location = detectLocation(text);

      if (location && location !== 'unknown') {
        const communityQuery = user.community === 'baps'
          ? 'BAPS Swaminarayan friendly'
          : 'Jain friendly';
        googleResults = await searchRestaurants(communityQuery, location, env);
        await updateUser(phone, { city: location }, env);
        user.city = location;
      }

      // Sunset / sunrise
      // Sunset / sunrise
      let sunData = '';
      if (detectSunsetQuery(text)) {
        const cityFromMessage = extractCityFromSunQuery(text);

        // Case A: user named a NEW city in this message → geocode + maybe disambiguate
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
              pending_tithi_city_ask: true  // reuse the same pending flag so the numeric reply lands in the existing handler
            }, env);
            await sendMessage(
              phone,
              `I found a few places called "${cityFromMessage}". Which one?\n\n${lines}\n\nReply with the number.`,
              env
            );
            return new Response('OK', { status: 200 });
          }

          // status === 'unique' — save the resolved city + tz, then continue
          const sunInfo = await getSunForPlace(geo.place);
          if (sunInfo) {
            await updateUser(phone, {
              city: sunInfo.city,
              timezone: sunInfo.timezoneId
            }, env);
            user.city = sunInfo.city;
            user.timezone = sunInfo.timezoneId;
            sunData = formatSunDataForClaude(sunInfo);
          } else {
            sunData = 'SUNSET QUERY: lookup failed. Apologize briefly and ask the user to try again.';
          }
        }
        // Case B: no city in message → use the stored one (already resolved)
        else if (user.city) {
          const sunInfo = await getSunriseSunset(user.city);
          sunData = formatSunDataForClaude(sunInfo);
          if (sunInfo?.timezoneId && sunInfo.timezoneId !== user.timezone) {
            await updateUser(phone, { timezone: sunInfo.timezoneId }, env);
            user.timezone = sunInfo.timezoneId;
          }
        }
        // Case C: no city anywhere → ask
        else {
          sunData = 'SUNSET QUERY: User asked about sunset but no city in message and none stored. Ask which city.';
        }
      }

      // -- Classify query (must come before calendar formatting) -------------
      const queryTypes = classifyQuery(text, messageType === 'image');

      // Short replies inherit fasting context from the previous bot question.
      // Without this, "1" / "ayambil" / similar short replies get classified
      // as 'general' and trigger the strictness ask incorrectly.
      const lastBotReply = (user.history_1_a || '').toLowerCase();
      const isShortReply = text.trim().length < 20;
      const isReplyToFastMenu = isShortReply && /fast|upvas|ekasan|ayambil|chauvihar|tivihar|atthai|porsi|biyasan|navkarsi/i.test(lastBotReply);
      if (isReplyToFastMenu && !queryTypes.includes('fasting')) {
        queryTypes.push('fasting');
      }

      // -- Calendar — Jain only, with size scaled to query type --------------
      // Defense in depth: only include calendar data for onboarded users
      // (strictness set = they've completed onboarding). For everyone else,
      // we have no city → tithi calc would be wrong by region anyway, and
      // we'd risk Claude inventing fasting context they can't act on.
      let calendarData = '';
      const isOnboarded = !!user.strictness;
      if (user.community === 'jain' && isOnboarded) {
        const needsFullCalendar = queryTypes.includes('fasting')
          || queryTypes.includes('calendar')
          || /paryushana|coming|upcoming|next/i.test(text);
        const calendarLimit = needsFullCalendar ? 10 : 3;
        calendarData = formatEventsForClaude(calendarEvents, user.timezone, calendarLimit);
      }

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

    // Guard against tithi hallucination. Fires only when Claude makes
      // an assertive claim about today's tithi/fast (e.g. "today is Beej",
      // "no food until tomorrow") without the calendar block having said
      // TODAY_IS_TITHI: true. The word "tithi" alone is fine — clarifying
      // questions like "want to check today's tithi?" must pass through.
      const TITHI_CLAIM_PATTERNS = [
        // "today is Beej", "today is a fast day"
        /\btoday\s+is\s+(a\s+)?(?:beej|bij|chaturdashi|chaumasi|paryushan(?:a)?|ekadashi|atthai|attham|chhath|punam|ashtami|nom|amavasya|purnima|fast day|tithi)\b/i,
        // "it is Beej today", "it's Chaturdashi"
        /\b(?:it\s+is|it'?s)\s+(?:beej|bij|chaturdashi|chaumasi|paryushan(?:a)?|ekadashi|atthai|attham|chhath|punam|ashtami|nom|amavasya|purnima)\b/i,
        // "no food until tomorrow", "no food should be eaten until tomorrow"
        /\bno food (?:should be eaten )?until tomorrow\b/i,
        // "today is a fasting day"
        /\btoday\s+is\s+a\s+fast(?:ing)?\s+day\b/i,
        // "(Beej)" or "(a fasting day)" appositive used to assert today
        /\(\s*(?:beej|bij|chaturdashi|chaumasi|paryushan(?:a)?|a fasting day)\s*\)/i,
      ];
      const calendarHadToday = /TODAY_IS_TITHI:\s*true/i.test(calendarData);
      const claimsTithiToday = TITHI_CLAIM_PATTERNS.some(p => p.test(cleanResponse));
      if (!calendarHadToday && claimsTithiToday) {
        console.log(`[guard] stripped_tithi_claim phone=${phone} response="${cleanResponse.slice(0, 200)}"`);
        // Strip whole sentences that contain a claim, not whole lines —
        // preserves surrounding food verdicts and prose.
        const sentences = cleanResponse.split(/(?<=[.!?])\s+/);
        cleanResponse = sentences
          .filter(s => !TITHI_CLAIM_PATTERNS.some(p => p.test(s)))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        // If the guard ate everything, fall back to a safe message rather
        // than sending nothing.
        if (!cleanResponse) {
          cleanResponse = "Let me know what you'd like to check 🙏";
        }
      }

      // -- Strictness ask append ---------------------------------------------
      // Only append the strictness ask if:
      //   - User has no strictness set, AND
      //   - The query is strictness-sensitive (not fasting, not greeting), AND
      //   - Claude actually gave a dual-verdict response. If both Strict and
      //     Flexible would give the same answer, the question wasn't really
      //     strictness-sensitive for this particular food — skip the ask.
      cleanResponse = cleanResponse.replace(/\[ASK_STRICTNESS\]/gi, '').trim();

      const isFasting = queryTypes.includes('fasting');
      const isStrictnessSensitive = queryTypes.some(t => STRICTNESS_SENSITIVE.has(t));
      const hasDualVerdict = /\bif strict\b/i.test(cleanResponse) && /\bif flexible\b/i.test(cleanResponse);
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
      await sendMessage(phone, cleanResponse, env);
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
          await sendMessage(
            debugPhone,
            `⚠️ Error: ${err.message}\n${(err.stack || '').slice(0, 500)}`,
            env
          );
        }
      } catch {}
      return new Response('OK', { status: 200 });
    }
  }
};
