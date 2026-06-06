// ============================================
// utils.js — Utility and helper functions v2.3
// ============================================
// Changes in v2.3:
//   - All USE_CASE blocks always included in static (cached) layer.
//     Two cache buckets total: one for Jain, one for BAPS.
//     Cache hits shared across all users of the same community.
//   - classifyQuery removed (dead code — classify.js + prompt_blocks replaced it)
//   - queryTypes parameter removed from buildSystemPrompt
// ============================================

import {
  CORE_IDENTITY,
  RULES_JAIN,
  RULES_BAPS,
  USE_CASE_GENERAL,
  USE_CASE_LABEL_SCAN,
  USE_CASE_RESTAURANT,
  USE_CASE_SUBSTITUTION,
  USE_CASE_MEDICINE,
  USE_CASE_FASTING,
  USE_CASE_CALENDAR,
} from './prompts.js';

// All use cases joined once — this is the constant static block per community.
const ALL_USE_CASES =
  USE_CASE_GENERAL +
  USE_CASE_LABEL_SCAN +
  USE_CASE_RESTAURANT +
  USE_CASE_SUBSTITUTION +
  USE_CASE_MEDICINE +
  USE_CASE_FASTING +
  USE_CASE_CALENDAR;

// Returns history as real conversation turns (oldest first) for the messages
// array. The caller appends the current user message at the end.
// Using real turns gives Claude proper multi-turn context vs flat text in the
// system prompt.
export function buildHistoryMessages(user) {
  const messages = [];
  const pairs = [
    [user.history_3_q, user.history_3_a],
    [user.history_2_q, user.history_2_a],
    [user.history_1_q, user.history_1_a],
  ];
  for (const [q, a] of pairs) {
    if (q && a) {
      messages.push({ role: 'user', content: q });
      messages.push({ role: 'assistant', content: a });
    }
  }
  return messages;
}

// Builds the fields object to pass to updateUser for history rotation.
// Call after every Claude response so all journeys save history.
export function buildHistoryUpdate(user, question, answer) {
  const q = (question || '').slice(0, 500);
  const a = (answer || '').slice(0, 500);
  return {
    history_1_q: q,
    history_1_a: a,
    history_2_q: user.history_1_q || '',
    history_2_a: user.history_1_a || '',
    history_3_q: user.history_2_q || '',
    history_3_a: user.history_2_a || '',
    message_count: (user.message_count || 0) + 1,
  };
}

export function stripTags(text) {
  return (text || '').trim();
}

export function buildSystemPrompt(user, calendarData, sunData, searchSnippets = null) {
  const rules = user.community === 'baps' ? RULES_BAPS : RULES_JAIN;

  // STATIC content — cached by Anthropic.
  // Always identical for the same community → reliable cache hits.
  const staticContent = CORE_IDENTITY + rules + ALL_USE_CASES;

  // DYNAMIC content — changes per message, never cached.
  const userTz = user.timezone || 'America/New_York';
  const today = new Date().toLocaleDateString('en-US', {
    timeZone: userTz,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });

  const profile = `
CURRENT USER PROFILE:
Community: ${user.community || 'jain'}
Strictness: ${user.strictness || 'not set'}
Language: ${user.language || 'en'}
Observance: ${user.observance || 'none'}
City: ${user.city || 'not set'}
Today's date: ${today}`;

  const calendar = calendarData
    ? `\nJAIN CALENDAR — NEXT 30 DAYS:\n${calendarData}
TITHI RULE: Never state the tithi name or that today is/isn't a tithi — that line is added separately. If today is a tithi, give ONLY a 2-line explanation of its dietary practice. Do not name it. Do NOT open with any greeting (no "Jai Jinendra", "🙏🏾", etc.) — a greeting is already added separately.`
    : '';

  const sun    = sunData        ? `\n${sunData}`        : '';
  const search = searchSnippets ? `\n${searchSnippets}` : '';

  const dynamicContent = profile + calendar + sun + search;

  return [
    {
      type: 'text',
      text: staticContent,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
    {
      type: 'text',
      text: dynamicContent,
    },
  ];
}
