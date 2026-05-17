// Samta v2.0
// ============================================
// worker.js — Main Cloudflare Worker handler
// ============================================
// v2.0 perf changes:
//   - Phase 1: sendReaction + getUser + getCalendarCached + getImageAsBase64
//     all run in parallel via Promise.all (saves ~500ms off the preamble)
//   - KV write-through cache on getUser — warm reads ~5ms vs ~700ms Supabase
//   - History + message count collapsed into one combined Supabase PATCH
//     deferred via ctx.waitUntil — user doesn't wait, no race condition
// ============================================

import { getUser, createUser, updateUser, deleteUser } from './src/database.js';
import { sendMessage, sendReaction, sendImage, getImageAsBase64 } from './src/whatsapp.js';

const VIN_FAMILY_URL = 'https://raw.githubusercontent.com/shah434/whatsapp-religious-friend/ad4ff7ebb697e22a7ba7abac1e0c94e4c7af3987/vin%20family.png';
const VIN_GOODBYE_URL = 'https://raw.githubusercontent.com/shah434/whatsapp-religious-friend/ad4ff7ebb697e22a7ba7abac1e0c94e4c7af3987/vin%20goodbye.png';
const VIN_STAY_URL = 'https://raw.githubusercontent.com/shah434/whatsapp-religious-friend/403944f9447d7975e07322f8cdaca25030dc50b0/vin%20stay.png';
const KV_PENDING_DELETE_PREFIX = 'pending_delete:';
const PENDING_DELETE_TTL = 600; // 10 minutes
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

export default {
  // Cron trigger: runs daily to pre-warm the calendar cache
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

    // Handle Meta webhook verification
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

    // Handle incoming messages
    if (req.method === 'POST') {
      try {
        const body = await req.json();

        // Stop status updates immediately (delivery, read receipts)
        const statuses = body?.entry?.[0]?.changes?.[0]?.value?.statuses;
        if (statuses) return new Response('OK', { status: 200 });

        const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!message) return new Response('OK', { status: 200 });

        const phone = message.from;
        const messageId = message.id;
        const messageType = message.type;

        // Silently drop non-content webhook events
        const silentDropTypes = ['reaction', 'system', 'interactive', 'button', 'unsupported', 'unknown'];
        if (silentDropTypes.includes(messageType)) {
          return new Response('OK', { status: 200 });
        }

        // Reject genuinely unsupported media with a helpful message
        if (!['text', 'image'].includes(messageType)) {
          await sendMessage(phone, 'I can only read text messages and food label photos. Please send a text question or a photo of a label.', env);
          return new Response('OK', { status: 200 });
        }

        const text = message.text?.body || message.image?.caption || '';
        const t0 = Date.now();

        // For image messages, fire an immediate acknowledgment so the user sees
        // something within ~200ms instead of waiting the full 4+ seconds.
        // Not awaited — runs in the background while Phase 1 executes.
        if (messageType === 'image') {
          sendMessage(phone, 'Scanning your label... 🔍', env);
        }

        // -- Phase 1: Parallel I/O ------------------------------------------------
        // Kick off everything we can before we know anything about the user.
        // getImageAsBase64 makes two sequential Meta API calls (~500ms) so starting
        // it here means it overlaps with the user lookup instead of following it.
        const imagePromise = messageType === 'image'
          ? getImageAsBase64(message.image.id, message.image.mime_type, env)
          : null;

        // sendReaction, getUser, and calendar are all independent — run together.
        let user, calendarEvents;
        [, user, calendarEvents] = await Promise.all([
          sendReaction(phone, messageId, env),
          getUser(phone, env),
          getCalendarCached(env),   // KV read (~5ms hit); safe to prefetch for all users
        ]);
        console.log(`[perf] phase1_parallel=${Date.now() - t0}ms type=${messageType}`);

        // -- User lookup / auto-creation ------------------------------------------
        const isNewUser = !user;
        if (isNewUser) {
          user = await createUser(phone, { community: DEFAULT_DIET }, env);
          // Welcome is sent AFTER the food response — see below.
        }

        // -- Pending delete confirmation check ------------------------------------
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

        // -- "delete me" keyword --------------------------------------------------
        if (messageType === 'text' && text.trim().toLowerCase() === 'delete me') {
          await env.KV.put(pendingDeleteKey, '1', { expirationTtl: PENDING_DELETE_TTL });
          await sendImage(phone, VIN_FAMILY_URL, 'Are you sure you want to leave the family? Reply YES to confirm, or anything else to cancel.', env);
          return new Response('OK', { status: 200 });
        }

        // -- Help keyword ---------------------------------------------------------
        if (messageType === 'text' && text.trim().toLowerCase() === 'help') {
          await sendMessage(phone, getWelcomeMessage(), env);
          return new Response('OK', { status: 200 });
        }

        // -- Pending strictness reply check ---------------------------------------
        if (user.pending_strictness_ask && messageType === 'text') {
          const handled = await applyStrictnessReply(phone, text, env);
          if (handled) return new Response('OK', { status: 200 });
          // refresh user state since the flag was just cleared
          user = await getUser(phone, env);
        }

        // -- Enrichment: location / calendar / sunset -----------------------------
        let googleResults = [];
        const location = detectLocation(text);

        if (location && location !== 'unknown') {
          const communityQuery = user.community === 'baps'
            ? 'BAPS Swaminarayan friendly'
            : 'Jain friendly';
          googleResults = await searchRestaurants(communityQuery, location, env);
          await updateUser(phone, { city: location }, env);
        }

        // Calendar already fetched in Phase 1 — just format if user is Jain
        let calendarData = '';
        if (user.community === 'jain') {
          calendarData = formatEventsForClaude(calendarEvents);
        }

        // Fetch sunrise/sunset if query is about sun times
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
            }
            const sunInfo = await getSunriseSunset(city);
            sunData = formatSunDataForClaude(sunInfo);
          } else {
            sunData = 'SUNSET QUERY: User asked about sunset but no city in message and none stored. Ask which city.';
          }
        }

        // -- Build Claude messages ------------------------------------------------
        // imagePromise was started in Phase 1 — it's almost certainly resolved by
        // the time we reach here (~500ms of user lookup + calendar has elapsed).
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
            await sendMessage(phone, 'I could not process that image. Please try a clearer photo or type out the ingredients list.', env);
            return new Response('OK', { status: 200 });
          }
        } else {
          claudeMessages = [{ role: 'user', content: text }];
        }

        // -- Build system prompt and call Claude ----------------------------------
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

        // -- Strictness ask detection ---------------------------------------------
        // Keep this updateUser synchronous: if the user replies before our deferred
        // writes land, the next webhook needs to see pending_strictness_ask = true.
        if (response.includes('[ASK_STRICTNESS]') && !user.strictness && !updates.strictness) {
          cleanResponse = cleanResponse.replace(/\[ASK_STRICTNESS\]/gi, '').trim();
          cleanResponse += '\n\n' + getStrictnessQuestion();
          await updateUser(phone, { pending_strictness_ask: true }, env);
        } else {
          cleanResponse = cleanResponse.replace(/\[ASK_STRICTNESS\]/gi, '').trim();
        }

        // -- Send response --------------------------------------------------------
        // For users who haven't set strictness yet, append a one-time hint
        // so they know help is available.
        if (!user.strictness) {
          cleanResponse += '\n\n💡 Type *help* anytime to see what else I can do.';
        }
        await sendMessage(phone, cleanResponse, env);
        console.log(`[perf] sent=${Date.now() - t0}ms TOTAL`);

        // Single combined write: history + message count in one Supabase PATCH,
        // then KV cache updated with merged result. Runs after 200 is returned —
        // user doesn't wait, and no race condition since it's one sequential write.
        ctx.waitUntil((async () => {
          await updateUser(phone, {
            history_1_q: text,
            history_1_a: cleanResponse,
            history_2_q: user.history_1_q || '',
            history_2_a: user.history_1_a || '',
            history_3_q: user.history_2_q || '',
            history_3_a: user.history_2_a || '',
            message_count: (user.message_count || 0) + 1,
          }, env);
        })());

        return new Response('OK', { status: 200 });

      } catch (err) {
        console.log('Main handler error:', err.message, err.stack);
        // Surface errors to the user who triggered them — remove after debugging
        try {
          const debugBody = await req.clone().json();
          const debugPhone = debugBody?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
          if (debugPhone) {
            await sendMessage(debugPhone, `⚠️ Error: ${err.message}\n${(err.stack || '').slice(0, 500)}`, env);
          }
        } catch {}
        return new Response('OK', { status: 200 });
      }
    }

    return new Response('Method not allowed', { status: 405 });
  }
};