// ============================================
// database.js — Supabase + KV write-through cache
// ============================================
// KV is a speed layer only — Supabase is always the source of truth.
// Write order: Supabase first, KV second. KV failures are logged
// but non-fatal; the next getUser falls back to Supabase automatically.
// ============================================

const KV_USER_PREFIX = 'user:';
const KV_USER_TTL = 86400; // 24h safety net — not the freshness mechanism

// ── Private KV helpers ──────────────────────────────────────────────────────

async function getUserFromKV(phone, env) {
  try {
    const cached = await env.KV.get(`${KV_USER_PREFIX}${phone}`);
    if (cached) return JSON.parse(cached);
  } catch (err) {
    console.log(`[cache] kv_read_error phone=${phone} err=${err.message}`);
  }
  return null;
}

async function writeUserToKV(phone, user, env) {
  try {
    await env.KV.put(
      `${KV_USER_PREFIX}${phone}`,
      JSON.stringify(user),
      { expirationTtl: KV_USER_TTL }
    );
  } catch (err) {
    console.log(`[cache] kv_write_error phone=${phone} err=${err.message}`);
    // Non-fatal — next getUser will fall back to Supabase
  }
}

// Merge fields into KV only — no Supabase write.
// Use for temporary flags (e.g. pending_strictness_ask) where speed matters
// and the Supabase write can be deferred to ctx.waitUntil.
async function mergeUserKVOnly(phone, fields, env) {
  try {
    const cached = await env.KV.get(`${KV_USER_PREFIX}${phone}`);
    if (cached) {
      const user = JSON.parse(cached);
      await env.KV.put(
        `${KV_USER_PREFIX}${phone}`,
        JSON.stringify({ ...user, ...fields }),
        { expirationTtl: KV_USER_TTL }
      );
    }
  } catch (err) {
    console.log(`[cache] kv_merge_error phone=${phone} err=${err.message}`);
  }
}

// ── Public functions ────────────────────────────────────────────────────────

export async function getUser(phone, env) {
  // KV first (~5ms on hit)
  const cached = await getUserFromKV(phone, env);
  if (cached) {
    console.log(`[cache] hit phone=${phone}`);
    return cached;
  }

  // Cache miss — fetch from Supabase, then cache the result
  console.log(`[cache] miss phone=${phone}`);
  const t = Date.now();
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
  console.log(`[cache] supabase_getUser=${Date.now() - t}ms`);

  const user = data[0] || null;
  if (user) await writeUserToKV(phone, user, env);
  return user;
}

export async function createUser(phone, fields, env) {
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
      body: JSON.stringify({ phone_number: phone, ...fields })
    }
  );
  const data = await res.json();
  const user = data[0];
  // Cache the new user immediately so their second message is a KV hit
  if (user) await writeUserToKV(phone, user, env);
  return user;
}

export async function deleteUser(phone, env) {
  // 1. Supabase first — hard delete the row
  await fetch(
    `${env.SUPABASE_URL}/rest/v1/users?phone_number=eq.${phone}`,
    {
      method: 'DELETE',
      headers: {
        apikey: env.SUPABASE_KEY,
        Authorization: `Bearer ${env.SUPABASE_KEY}`
      }
    }
  );

  // 2. Clear KV cache entry
  try {
    await env.KV.delete(`${KV_USER_PREFIX}${phone}`);
  } catch (err) {
    console.log(`[cache] kv_delete_error phone=${phone} err=${err.message}`);
  }

  console.log(`[db] user_deleted phone=${phone}`);
}

export async function setFlagKV(phone, fields, env) {
  return mergeUserKVOnly(phone, fields, env);
}

export async function updateUser(phone, fields, env) {
  // 1. Supabase first — source of truth
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

  // 2. Merge fields into KV cache (best effort — non-fatal on failure)
  // Only updates an existing entry; does not create one if absent.
  try {
    const cached = await env.KV.get(`${KV_USER_PREFIX}${phone}`);
    if (cached) {
      const user = JSON.parse(cached);
      await env.KV.put(
        `${KV_USER_PREFIX}${phone}`,
        JSON.stringify({ ...user, ...fields }),
        { expirationTtl: KV_USER_TTL }
      );
    }
  } catch (err) {
    console.log(`[cache] kv_update_error phone=${phone} err=${err.message}`);
  }
}