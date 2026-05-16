// Samta v1.9
// ============================================
// worker.js — Main Cloudflare Worker handler
// ============================================

import { getUser, createUser, updateUser, saveHistory, incrementMessageCount } from './src/database.js';
import { sendMessage, sendReaction, getImageAsBase64 } from './src/whatsapp.js';
import { callClaude } from './src/claude.js';
import { searchRestaurants, detectLocation } from './src/location.js';
import {
  DEFAULT_DIET,
  getWelcomeMessage,
  getStrictnessQuestion,
  applyStrictnessReply,
} from './src/onboarding.js';
import { parseProfileUpdate, stripTags, buildSystemPrompt } from './src/utils.js';
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

  async fetch(req, env) {

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

        // Send reaction immediately
        await sendReaction(phone, messageId, env);

        // -- User lookup / auto-creation -------------------------------------------
        // New users are created immediately with the default community (Jain).
        // No community-asking flow — that comes back when BAPS launches.
        let user = await getUser(phone, env);
        const isNewUser = !user;
        if (isNewUser) {
          user = await createUser(phone, { community: DEFAULT_DIET }, env);
          await sendMessage(phone, getWelcomeMessage(), env);
          return new Response('OK', { status: 200 });
        }

        // -- Pending strictness reply check ---------------------------------------
        // If we previously asked for strictness and this looks like a 1/2/3 reply,
        // handle it here and return. If it's not a valid reply, the helper clears
        // the flag and returns false so the normal flow continues.
        if (user.pending_strictness_ask && messageType === 'text') {
          const handled = await applyStrictnessReply(phone, text, env);
          if (handled) return new Response('OK', { status: 200 });
          // refresh user state since the flag was just cleared
          user = await getUser(phone, env);
        }

        // -- Enrichment: location / calendar / sunset ------------------------------
        let googleResults = [];
        const location = detectLocation(text);

        if (location && location !== 'unknown') {
          const communityQuery = user.community === 'baps'
            ? 'BAPS Swaminarayan friendly'
            : 'Jain friendly';
          googleResults = await searchRestaurants(communityQuery, location, env);
          await updateUser(phone, { city: location }, env);
        }

        // Fetch Jain calendar if user is Jain
        let calendarData = '';
        if (user.community === 'jain') {
          const events = await getCalendarCached(env);
          calendarData = formatEventsForClaude(events);
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

        // -- Build Claude messages -------------------------------------------------
        let claudeMessages = [];

        if (messageType === 'image') {
          try {
            const { base64, mimeType } = await getImageAsBase64(
              message.image.id,
              message.image.mime_type,
              env
            );
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
        const system = buildSystemPrompt(user, googleResults, calendarData, sunData);
        const response = await callClaude(claudeMessages, system, env);

        // Parse profile updates
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
        if (response.includes('[ASK_STRICTNESS]') && !user.strictness && !updates.strictness) {
          cleanResponse = cleanResponse.replace(/\[ASK_STRICTNESS\]/gi, '').trim();
          cleanResponse += '\n\n' + getStrictnessQuestion();
          await updateUser(phone, { pending_strictness_ask: true }, env);
        } else {
          cleanResponse = cleanResponse.replace(/\[ASK_STRICTNESS\]/gi, '').trim();
        }

        // -- Send response ---------------------------------------------------------
        await sendMessage(phone, cleanResponse, env);
        await saveHistory(phone, user, text, cleanResponse, env);

        // Increment message count
        await incrementMessageCount(phone, env);

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
