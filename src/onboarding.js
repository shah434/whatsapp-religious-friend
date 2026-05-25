// ============================================
// onboarding.js — Welcome + strictness reply handling
// ============================================

import { updateUser } from './database.js';
import { sendMessage } from './whatsapp.js';

// Default community for new users. Change when BAPS launches.
export const DEFAULT_DIET = 'jain';

export function getWelcomeMessage() {
  return `Hello 🙏 I'm Samta — your friend for daily dietary and fasting questions.


You can ask me things like:
- Is today a fast day?
- What time is sunrise / sunset?
- What can I eat during fast?
- Find Jain/vegetarian restaurants near me
- What can I substitute for onion?
- Are the ingredients in this food or supplement safe?

Or send a photo of any food label, menu, or product to scan 🙏`;
}

export function getStrictnessQuestion() {
  return `So I can tailor future answers — which fits you?
1 — Strict (no root veg, no fermented, no exceptions)
2 — Moderate (core rules, flexible on edge cases)
3 — Flexible (basic vegetarian rules)`;
}

// Called when a user has pending_strictness_ask=true and sends a message.
// If it's a valid 1/2/3 reply, save and confirm. Otherwise clear the flag
// silently and let the normal flow handle the message.
// Returns true if handled (and the worker should return), false otherwise.
export async function applyStrictnessReply(phone, text, env) {
  const input = (text || '').trim();
  if (!['1', '2', '3'].includes(input)) {
    // Not a strictness reply — clear flag and let normal flow handle it
    await updateUser(phone, { pending_strictness_ask: false }, env);
    return false;
  }

  const strictness = { '1': 'strict', '2': 'moderate', '3': 'flexible' }[input];
  await updateUser(phone, {
    strictness,
    pending_strictness_ask: false
  }, env);

  await sendMessage(
    phone,
    `Got it 🙏 set you to ${strictness}. Ask me anything!`,
    env
  );
  return true;
}
