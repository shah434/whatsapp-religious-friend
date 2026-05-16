// ============================================
// onboarding.js — User onboarding flow
// ============================================
//
// DIET EXPANSION GUIDE:
//   1. Add your new diet to SUPPORTED_DIETS below (e.g. { id: 'baps', label: 'BAPS Swaminarayan' }).
//   2. When SUPPORTED_DIETS.length > 1 the diet-picker step auto-enables (see DIET_EXPANSION
//      comments in handleOnboarding below).
//   3. Before launching, run a DB migration:
//        UPDATE users SET community = 'jain' WHERE community IS NULL;
//      so existing users are not presented with the picker on their next message.
// ============================================

import { updateUser } from './database.js';
import { sendMessage } from './whatsapp.js';

// -- Diet registry ----------------------------------------------------------------
// Add entries here to support additional diets.
// When length === 1 the single diet is auto-assigned and the picker step is skipped.
export const SUPPORTED_DIETS = [
  { id: 'jain', label: 'Jain' },
  // { id: 'baps', label: 'BAPS Swaminarayan' },  // uncomment to re-enable
];

export const DEFAULT_DIET = SUPPORTED_DIETS[0].id;       // 'jain'
const MULTI_DIET        = SUPPORTED_DIETS.length > 1;    // false for now

// -- Message helpers --------------------------------------------------------------

function buildDietPickerMessage() {
  const lines = SUPPORTED_DIETS.map((d, i) => `${i + 1} — ${d.label}`);
  return `Which dietary tradition do you follow?\n${lines.join('\n')}`;
}

function buildStrictnessQuestion() {
  // DIET_EXPANSION: pass community label here if you want community-specific wording.
  return `How strictly do you follow Jain dietary rules?
1 — Strict (all rules, no exceptions)
2 — Moderate (core rules, flexible on edge cases)
3 — Flexible (basic vegetarian rules)`;
}

// Called by worker.js to start or re-prompt onboarding.
export function getOnboardingMessage(reason, user) {
  if (reason === 'new_user') {
    // DIET_EXPANSION: when MULTI_DIET is true, show the diet picker first.
    if (MULTI_DIET) {
      return `Jai Jinendra! I'm Samta, your dietary guidance assistant.\n\n${buildDietPickerMessage()}`;
    }
    return `Jai Jinendra! I'm Samta, your Jain dietary assistant.\n\n${buildStrictnessQuestion()}`;
  }

  if (reason === 'no_diet') {
    return buildDietPickerMessage();
  }

  if (reason === 'no_strictness') {
    return buildStrictnessQuestion();
  }
}

// Appended to the food-answer message for any unonboarded user.
export function getOnboardingNudge() {
  return `\n\nReply 1 (Strict), 2 (Moderate), or 3 (Flexible) to personalise future answers.`;
}

// Sent as a separate first message for brand-new users who open with a food question.
export function getWelcomeMessage() {
  return `Jai Jinendra! I'm Samta, your Jain dietary guide. I'll answer your question right away — then you can tell me your strictness level for personalised answers.`;
}

// -- Onboarding state machine -----------------------------------------------------
// Called only when the user sends a bare 1 / 2 / 3 (an explicit onboarding response).

export async function handleOnboarding(phone, user, text, env) {
  const input = text.trim();

  // DIET_EXPANSION: when MULTI_DIET is true, handle diet selection before strictness.
  // if (MULTI_DIET && !user.community) {
  //   const idx = parseInt(input, 10) - 1;
  //   const chosen = SUPPORTED_DIETS[idx];
  //   if (chosen) {
  //     await updateUser(phone, { community: chosen.id }, env);
  //     await sendMessage(phone, buildStrictnessQuestion(), env);
  //   } else {
  //     await sendMessage(phone, buildDietPickerMessage(), env);
  //   }
  //   return;
  // }

  if (!user.strictness) {
    const strictnessMap = { '1': 'strict', '2': 'moderate', '3': 'flexible' };
    const strictness = strictnessMap[input];

    if (strictness) {
      await updateUser(phone, { strictness }, env);
      await sendMessage(phone, `You're all set!

Send me a photo of any food label, a menu, or ask if something is safe to eat.

You can also ask:
- Is today a fast day?
- Find Jain restaurants near me
- What can I eat during Paryushana?
- What can I substitute for onion?`, env);
    } else {
      // Unexpected input — re-prompt
      await sendMessage(phone, buildStrictnessQuestion(), env);
    }
    return;
  }
}
