// Samta v1.8
// ============================================
// worker.js — Main Cloudflare Worker handler
// ============================================

import { getUser, createUser, updateUser, saveHistory, incrementMessageCount } from './src/database.js';
import { sendMessage, sendReaction, getImageAsBase64 } from './src/whatsapp.js';
import { callClaude } from './src/claude.js';
import { searchRestaurants, detectLocation } from './src/location.js';
import {
  handleOnboarding,
  DEFAULT_DIET,
  getOnboardingNudge,
  getWelcomeMessage,
} from './src/onboarding.js';
import { parseProfileUpdate, stripTags, buildSystemPrompt, buildNeutralSystemPrompt } from './src/utils.js';
import { getCalendarCached, getTodayAndUpcomingEvents, formatEventsForClaude } from './src/calendar.js';
import { getSunriseSunset, formatSunDataForClaude, detectSunsetQuery, extractCityFromSunQuery } from './src/sunset.js';

export default {
  // Cron trigger: runs at midnight UTC (5:30am IST) to pre-warm the calendar cache
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
        // New users are created immediately with the default diet (currently Jain)
        // so no user row ever has a null community field.
        let user = await getUser(phone, env);
        const isNewUser = !user;
        if (isNewUser) {
          user = await createUser(phone, { community: DEFAULT_DIET }, env);
        }

        // -- Onboarding gate -------------------------------------------------------
        // Onboarding is now a single step: strictness selection (1 / 2 / 3).
        // Community is always pre-set (Jain by default), so we only block on strictness.
        //
        // If the user sends a bare 1, 2, or 3 -> complete onboarding.
        // Any other message -> answer it immediately (with a nudge to set strictness).
        const needsOnboarding = !user.strictness;

        if (needsOnboarding) {
          const isOnboardingResponse =
            messageType === 'text' && ['1', '2', '3'].includes(text.trim());

          if (isOnboardingResponse) {
            await handleOnboarding(phone, user, text, env);
            return new Response('OK', { status: 200 });
          }

          // Food question or greeting from an unonboarded user.
          // For brand-new users send a brief welcome first, then fall through
          // to the answer flow below (which appends the personalisation nudge).
          if (isNewUser) {
            await sendMessage(phone, getWelcomeMessage(), env);
          }
          // Fall through -- needsOnboarding stays true; answer flow uses neutral prompt.
        }

        // -- Enrichment: location / calendar / sunset ------------------------------
        let googleResults = [];
        const location = detectLocation(text);
        const userCommunity = user.community || DEFAULT_DIET;

        if (location && location !== 'unknown') {
          const communityQuery = userCommunity === 'baps'
            ? 'BAPS Swaminarayan friendly'
            : 'Jain friendly';
          googleResults = await searchRestaurants(communityQuery, location, env);
          await updateUser(phone, { city: location }, env);
        }

        // Fetch Jain calendar for Jain users — served from KV cache, pre-warmed by daily cron
        let calendarData = '';
        if (userCommunity === 'jain') {
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

        // -- Build system prompt ---------------------------------------------------
        // Unonboarded users get the neutral 3-level grid prompt (no personal profile).
        // Fully onboarded users get their personalised prompt as normal.
        const system = needsOnboarding
          ? buildNeutralSystemPrompt(googleResults, calendarData, sunData)
          : buildSystemPrompt(user, googleResults, calendarData, sunData);

        const response = await callClaude(claudeMessages, system, env);

        // Parse and apply any profile updates Claude detected in the response
        const updates = parseProfileUpdate(response);
        const cleanResponse = stripTags(response);

        if (updates.strictness || updates.community || updates.city) {
          await updateUser(phone, {
            ...(updates.strictness && { strictness: updates.strictness }),
            ...(updates.community && { community: updates.community }),
            ...(updates.city && { city: updates.city })
          }, env);
        }

        // -- Send response ---------------------------------------------------------
        // Append personalisation nudge for unonboarded users.
        const finalResponse = needsOnboarding
          ? cleanResponse + getOnboardingNudge()
          : cleanResponse;

        await sendMessage(phone, finalResponse, env);
        await saveHistory(phone, user, text, cleanResponse, env);

        // Increment message count (onboarded users only)
        if (!needsOnboarding) {
          await incrementMessageCount(phone, env);
          // Donation nudge intentionally disabled -- re-enable when the time is right.
          // if (count > 0 && count % 30000 === 0) {
          //   await sendMessage(phone, `You have sent ${count} messages with Samta!...`, env);
          // }
        }

        return new Response('OK', { status: 200 });

      } catch (err) {
        console.log('Main handler error:', err.message, err.stack);
        return new Response('OK', { status: 200 });
      }
    }

    return new Response('Method not allowed', { status: 405 });
  }
};
