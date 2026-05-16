// ============================================
// database.js — Supabase database functions
// ============================================

export async function getUser(phone, env) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/users?phone_number=eq.${phone}&limit=1`,
    {
      headers: {
        apikey: env.SUPABASE_KEY,
        Authorization: `Bearer ${env.SUPABASE_KEY}`
      }
    }
  );
  const data = await res.json();
  return data[0] || null;
}

// initialFields lets callers pre-populate columns at creation time
// (e.g. { community: 'jain' } so we never have a user row with a null community).
export async function createUser(phone, initialFields = {}, env) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/users`,
    {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_KEY,
        Authorization: `Bearer ${env.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify({ phone_number: phone, ...initialFields })
    }
  );
  const data = await res.json();
  return data[0];
}

export async function updateUser(phone, fields, env) {
  await fetch(
    `${env.SUPABASE_URL}/rest/v1/users?phone_number=eq.${phone}`,
    {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_KEY,
        Authorization: `Bearer ${env.SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(fields)
    }
  );
}

export async function saveHistory(phone, user, question, answer, env) {
  await updateUser(phone, {
    history_1_q: question,
    history_1_a: answer,
    history_2_q: user.history_1_q || '',
    history_2_a: user.history_1_a || '',
    history_3_q: user.history_2_q || '',
    history_3_a: user.history_2_a || ''
  }, env);
}

export async function incrementMessageCount(phone, env) {
  const user = await getUser(phone, env);
  const count = (user?.message_count || 0) + 1;
  await updateUser(phone, { message_count: count }, env);
  return count;
}
