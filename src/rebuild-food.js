// Handles food questions (text) and label/product image scans.
// This is the default journey — everything that isn't claimed by another handler.

import { formatEventsForClaude } from './calendar.js';
import { callClaude } from './claude.js';
import { sendMessage } from './whatsapp.js';
import { updateUser } from './database.js';
import { buildSystemPrompt, stripTags } from './utils.js';
import { identifyProduct, searchProductIngredients } from './search.js';
import { serializePending, readPending } from './pending.js';
import { getStrictnessQuestion } from './onboarding.js';

const TITHI_CLAIM_PATTERNS = [
  /\btoday\s+is\s+(a\s+)?(?:beej|bij|chaturdashi|chaumasi|paryushan(?:a)?|ekadashi|atthai|attham|chhath|punam|ashtami|nom|amavasya|purnima|fast day|tithi)\b/i,
  /\b(?:it\s+is|it'?s)\s+(?:beej|bij|chaturdashi|chaumasi|paryushan(?:a)?|ekadashi|atthai|attham|chhath|punam|ashtami|nom|amavasya|purnima)\b/i,
  /\bno food (?:should be eaten )?until tomorrow\b/i,
  /\btoday\s+is\s+a\s+fast(?:ing)?\s+day\b/i,
];

const STRICTNESS_SENSITIVE = new Set([
  'general', 'label_scan', 'restaurant', 'substitution', 'medicine'
]);

function isLikelyGreeting(text) {
  return /^(hi|hello|hey|jai jinendra|namaste|hola)\b/i.test((text || '').trim());
}

// context = { messageType, imagePromise, calendarEvents, t0, ctx }
export async function handleRebuildFood(phone, text, user, intent, env, context) {
  const { messageType, imagePromise, calendarEvents, t0, ctx } = context;

  // -- Calendar data (3 events; food queries rarely need the full 30-day view) -
  const calendarData = user.community === 'jain'
    ? formatEventsForClaude(calendarEvents, user.timezone, 3)
    : '';

  const m = calendarData.match(/TODAY_IS_TITHI:\s*true[\s\S]*?TODAY_TITHI_NAME:\s*(.+)/i);
  const tithiFact = m ? `Today is ${m[1].trim()} 🙏\n\n` : '';

  // -- Build Claude messages --------------------------------------------------
  let claudeMessages = [];
  let searchSnippets = null;
  let isLabel = true;
  let productName = null;
  let scanBranch = null;

  if (messageType === 'image') {
    try {
      const { base64, mimeType } = await imagePromise;
      console.log(`[perf] image_ready=${Date.now() - t0}ms`);

      ({ isLabel, productName } = await identifyProduct(base64, mimeType, env));
      console.log(`[image] isLabel=${isLabel} product="${productName}" latency=${Date.now() - t0}ms`);

      if (isLabel) {
        // Branch A: ingredient list visible — send image directly to Claude
        scanBranch = 'A';
        claudeMessages = [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: text || 'Please scan this food label and check if it is safe for my diet.' }
          ]
        }];
      } else {
        // Branch B: product front — search for ingredients
        scanBranch = 'B';
        const snippets = productName ? await searchProductIngredients(productName, env) : null;
        console.log(`[image] branch=B snippets=${snippets ? 'found' : 'null'} product="${productName}"`);

        if (!snippets) {
          await sendMessage(phone,
            `I couldn't find ingredient info for ${productName || 'this product'} online. Can you send a photo of the back label or ingredients panel? 🙏`,
            env);
          return true;
        }

        searchSnippets =
          `PRODUCT SEARCH RESULTS — ${productName}\n` +
          `User sent a photo of the product front (no ingredient list visible).\n` +
          `Web snippets retrieved to identify ingredients:\n\n${snippets}\n\n` +
          `Use these to identify likely ingredients. If no clear ingredient list, ask for the back label. Do not invent ingredients.`;

        claudeMessages = [{
          role: 'user',
          content: text || `Please check if ${productName} is safe for my diet based on the search results provided.`
        }];
      }
    } catch (err) {
      console.log('Image processing error:', err.message);
      await sendMessage(phone, 'I could not process that image. Please try a clearer photo or type out the ingredients list.', env);
      return true;
    }
  } else {
    claudeMessages = [{ role: 'user', content: text }];
  }

  // -- System prompt + Claude call -------------------------------------------
  const system = buildSystemPrompt(user, calendarData, '', searchSnippets);
  const maxTokens = messageType === 'image' && isLabel ? 400 : 250;
  console.log(`[perf] claude_start=${Date.now() - t0}ms`);
  const response = await callClaude(claudeMessages, system, env, maxTokens);
  console.log(`[perf] claude_done=${Date.now() - t0}ms`);

  let cleanResponse = stripTags(response)
    .replace(/TODAY_IS_TITHI:\s*(true|false)/gi, '')
    .replace(/TODAY_TITHI_NAME:.*$/gim, '')
    .trim();

  // -- Scan log (image only) --------------------------------------------------
  if (messageType === 'image' && scanBranch) {
    try {
      await env.KV.put(
        `log:image:${new Date().toISOString()}`,
        JSON.stringify({ productName, branch: scanBranch, snippetsFound: !!searchSnippets, response: cleanResponse, latencyMs: Date.now() - t0 }),
        { expirationTtl: 2592000 }
      );
    } catch {}
  }

  // -- Tithi-claim guard: prevent hallucinated tithi claims -------------------
  const calendarHadToday = /TODAY_IS_TITHI:\s*true/i.test(calendarData);
  if (!calendarHadToday && TITHI_CLAIM_PATTERNS.some(p => p.test(cleanResponse))) {
    const sentences = cleanResponse.split(/(?<=[.!?])\s+/);
    cleanResponse = sentences.filter(s => !TITHI_CLAIM_PATTERNS.some(p => p.test(s))).join(' ').trim()
      || "Let me know what you'd like to check 🙏";
  }

  // -- Strictness ask (once per session) -------------------------------------
  const isStrictnessSensitive = intent.prompt_blocks.some(b => STRICTNESS_SENSITIVE.has(b));
  const levelsShown = [/\bif strict\b/i, /\bif moderate\b/i, /\bif flexible\b/i]
    .filter(re => re.test(cleanResponse)).length;
  const alreadyAskedStrictness = readPending(user.pending_action)?.need === 'strictness';
  const needsStrictnessAsk = !user.strictness
    && !alreadyAskedStrictness
    && isStrictnessSensitive
    && !intent.prompt_blocks.includes('fasting')
    && !isLikelyGreeting(text)
    && levelsShown > 1;

  if (needsStrictnessAsk) {
    cleanResponse += '\n\n' + getStrictnessQuestion();
    cleanResponse += '\n\n💡 Type *help* anytime to see what else I can do.';
    const rec = serializePending({ need: 'strictness', intent });
    if (rec) await updateUser(phone, { pending_action: rec }, env);
  }

  // -- Send ------------------------------------------------------------------
  if (!cleanResponse) cleanResponse = "Let me know what you'd like to check 🙏";
  await sendMessage(phone, tithiFact + cleanResponse, env);
  console.log(`[perf] sent=${Date.now() - t0}ms TOTAL`);

  // -- History (deferred) ----------------------------------------------------
  ctx.waitUntil(updateUser(phone, {
    history_1_q: text,
    history_1_a: cleanResponse,
    history_2_q: user.history_1_q || '',
    history_2_a: user.history_1_a || '',
    history_3_q: user.history_2_q || '',
    history_3_a: user.history_2_a || '',
    message_count: (user.message_count || 0) + 1,
  }, env));

  return true;
}
