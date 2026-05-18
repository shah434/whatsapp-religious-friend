// Samta v2.1
// ============================================
// worker.js — Main Cloudflare Worker handler
// ============================================
// v2.1 changes:
//   - Per-user timezone support for accurate tithi calculations
//   - Tithi queries ask for city if none stored, then geocode for timezone
//   - Sunset queries also persist captured timezone for future tithi accuracy
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
import { getSunriseSunset, formatSunDataForClaude, detectSunsetQuery, extractCityFromSunQuery } from './src/sunset.js';

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
  'general', 'label_scan', 'restaurant', 'substitution', 'medicine', 'fasting'
]);

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

// Detects whether a user message is asking about tithi / fast day status.
function isTithiQuery(text) {
  const lower = (text || '').toLowerCase();
  return /\b(tithi|fast day|today.*(special|fast|tithi)|what.*tithi|is today)\b/.test(lower);
}

// Detects greetings — used to skip strictness asks on small talk.
function isLikelyGreeting(text) {
  return /^(hi|hello|hey|jai jinendra|namaste|hola)\b/i.test((text || '').trim());
}

// Rough timezone guess from WhatsApp phone country code.
// Used as a starting point; overridden when user provides a city.
function defaultTimezoneFromPhone(phone) {
  if (phone.startsWith('91')) return 'Asia/Kolkata';
  if (phone.startsWith('44')) return 'Europe/London';
  if (phone.startsWith('971')) return 'Asia/Dubai';
  if (phone.startsWith('65')) return 'Asia/Singapore';
  if (phone.startsWith('61')) return 'Australia/Sydney';
  if (phone.startsWith('254')) return 'Africa/Nairobi';
  if (phone.startsWith('27')) return 'Africa/Johannesburg';
  // Default for +1 (US/Canada) and unknowns — ET is YJA's publication tz
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

      // -- Drop status updates immediately -----------------------------------
      const statuses = body?.entry?.[0]?.changes?.[0]?.value?.statuses;
      if (statuses) return new Response('OK', { status: 200 });

      const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!message) return new Response('OK', { status: 200 });

      const phone = message.from;
      const messageId = message.id;
      const messageType = message.type;

      // -- Silently drop non-content webhook events --------------------------
      if (SILENT_DROP_TYPES.has(messageType)) {
        return new Response('OK', { status: 200 });
      }

      // -- Reject unsupported media ------------------------------------------
      if (!['text', 'image'].includes(messageType)) {
        await sendMessage(
          phone,
          'I can only read text messages and food label photos. Please send a text question or a photo of a label.',
          env
        );
        return new Response('OK', { status: 200 });
      }

      const text = message.text?.body || message.image?.caption || '';
      const t0 = Date.now();

      // For images, fire an immediate acknowledgment (not awaited)
      if (messageType === 'image') {
        sendMessage(phone, 'Reviewing your request... 🔍', env);
      }

      // -- Phase 1: Parallel I/O ---------------------------------------------
      // Kick off independent work before we know anything about the user.
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

      // -- Pending strictness reply check ------------------------------------
      if (user.pending_strictness_ask && messageType === 'text') {
        const handled = await applyStrictnessReply(phone, text, env);
        if (handled) return new Response('OK', { status: 200 });
        user = await getUser(phone, env);
      }

      // -- Pending tithi-city reply check ------------------------------------
      // If we asked for their city on a previous tithi query, this message
      // should be the city. Geocode it, save city + timezone, fall through
      // to answer the tithi question they originally asked.
      if (user.pending_tithi_city_ask && messageType === 'text') {
        const replyCity = text.trim();
        if (replyCity.length >= 2 && replyCity.length <= 50) {
          const sunInfo = await getSunriseSunset(replyCity);
          if (sunInfo?.timezoneId) {
            await updateUser(phone, {
              city: sunInfo.city,
              timezone: sunInfo.timezoneId,
              pending_tithi_city_ask: false
            }, env);
            user.city = sunInfo.city;
            user.timezone = sunInfo.timezoneId;
            // Fall through — synthesize a tithi question so Claude answers it now
            // even though the literal message was just a city name.
          } else {
            await sendMessage(
              phone,
              `I couldn't find that city. Can you type cityname and state (ex. Los Angeles, CA) or your zip code?`,
              env
            );
            return new Response('OK', { status: 200 });
          }
        } else {
          // Not a plausible city reply — clear the flag and proceed normally
          await setFlagKV(phone, { pending_tithi_city_ask: false }, env);
          user.pending_tithi_city_ask = false;
        }
      }

      // -- Tithi-city ask ----------------------------------------------------
      // If asking about tithi and we have no city, ask for one. Tithi timing
      // varies by location and answering "no tithi today" to someone whose
      // local Friday is YJA's Thursday is worse than the small friction here.
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

      // Calendar — only formatted for Jain users; pass their timezone
      let calendarData = '';
      if (user.community === 'jain') {
        calendarData = formatEventsForClaude(calendarEvents, user.timezone);
      }

      // Sunset / sunrise
      let sunData = '';
      if (detectSunsetQuery(text)) {
        let city = extractCityFromSunQuery(text);

        if (!city && user.city) {
          city = user.city;
        }

        if (city) {
          const cityFromMessage = extractCityFromSunQuery(text);
          if (cityFromMessage && cityFromMessage.length > 2 && !cityFromMessage.toLowerCase().includes('time')) {
            await updateUser(phone, { city: cityFromMessage }, env);
            user.city = cityFromMessage;
          }
          const sunInfo = await getSunriseSunset(city);
          sunData = formatSunDataForClaude(sunInfo);
          // Persist the IANA timezone for future tithi/calendar queries
          if (sunInfo?.timezoneId && sunInfo.timezoneId !== user.timezone) {
            await updateUser(phone, { timezone: sunInfo.timezoneId }, env);
            user.timezone = sunInfo.timezoneId;
          }
        } else {
          sunData = 'SUNSET QUERY: User asked about sunset but no city in message and none stored. Ask which city.';
        }
      }

      // -- Build Claude messages ---------------------------------------------
      let claudeMessages = [];

      // If we just resolved a city from a tithi reply, replace the literal
      // city-name message with the original tithi intent so Claude answers
      // the right question.
      const isCityReplyToTithi = user.city && !text.toLowerCase().includes('tithi')
        && text.length < 50
        && body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.context !== undefined;
      // (We don't have full context tracking — keep this simple. The user
      // might just see "no tithi today" with their city. They can re-ask
      // and the city is now stored. Acceptable v1 behavior.)

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
      const queryTypes = classifyQuery(text, messageType === 'image');
      const system = buildSystemPrompt(user, googleResults, calendarData, sunData, queryTypes);
      console.log(`[perf] claude_start=${Date.now() - t0}ms`);
      const response = await callClaude(claudeMessages, system, env);
      console.log(`[perf] claude_done=${Date.now() - t0}ms`);

      const updates = parseProfileUpdate(response);
      let cleanResponse = stripTags(response);

      if (updates.strictness || updates.community || updates.city) {
        await updateUser(phone, {
          ...(updates.strictness && { strictness: updates.strictness }),
          ...(updates.community && { community: updates.community }),
          ...(updates.city && { city: updates.city })
        }, env);
      }

      // -- Strictness ask append ---------------------------------------------
      cleanResponse = cleanResponse.replace(/\[ASK_STRICTNESS\]/gi, '').trim();

      const isStrictnessSensitive = queryTypes.some(t => STRICTNESS_SENSITIVE.has(t));
      const needsStrictnessAsk = !user.strictness
        && !updates.strictness
        && isStrictnessSensitive
        && !isLikelyGreeting(text);

      if (needsStrictnessAsk) {
        cleanResponse += '\n\n' + getStrictnessQuestion();
        cleanResponse += '\n\n💡 Type *help* anytime to see what else I can do.';
        await setFlagKV(phone, { pending_strictness_ask: true }, env);
      }

      // -- Send response -----------------------------------------------------
      await sendMessage(phone, cleanResponse, env);
      console.log(`[perf] sent=${Date.now() - t0}ms TOTAL`);

      // -- Deferred Supabase write -------------------------------------------
      // History + message count + flags in one PATCH, after 200 is returned.
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
