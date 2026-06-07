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

// Fetch pending_action directly from Supabase — always fresh, never stale.
// Run this in parallel with getUser so it adds no wall-clock latency.
// The result overwrites user.pending_action from the KV cache.
// Returns:
//   { exists: true,  pending_action: string|null } — user found in Supabase
//   { exists: false }                               — no Supabase row (KV ghost)
//   undefined                                       — fetch error; caller falls back to KV
export async function fetchPendingAction(phone, env) {
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/users?phone_number=eq.${phone}&select=pending_action&limit=1`,
      {
        headers: {
          apikey: env.SUPABASE_KEY,
          Authorization: `Bearer ${env.SUPABASE_KEY}`
        }
      }
    );
    const data = await res.json();
    if (!res.ok || !Array.isArray(data)) {
      // HTTP error or unexpected shape — treat as fetch error, not as missing row
      console.log(`[db] fetchPendingAction http_error status=${res.status}`);
      return undefined;
    }
    if (data.length === 0) {
      return { exists: false };
    }
    const pending_action = data[0]?.pending_action ?? null;
    console.log(`[db] fetchPendingAction status=${res.status} rows=1 val=${JSON.stringify(pending_action)?.slice(0,60)}`);
    return { exists: true, pending_action };
  } catch (err) {
    console.log(`[cache] fetchPendingAction_error phone=${phone} err=${err.message}`);
    return undefined; // undefined = caller should fall back to KV value
  }
}

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
  console.log(`[cache] supabase_getUser=${Date.now() - t}ms status=${res.status}`);

  if (!Array.isArray(data)) {
    console.log(`[cache] supabase_getUser_error status=${res.status} body=${JSON.stringify(data)}`);
    return null;
  }

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
  console.log(`[db] createUser status=${res.status}`);
  if (!Array.isArray(data) || !data[0]) {
    console.log(`[db] createUser_error status=${res.status} body=${JSON.stringify(data)}`);
  }
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

// Invalidate the KV cache entry for a user, forcing the next getUser to
// read fresh data from Supabase. Use after writes where KV consistency
// matters (e.g. city saves) to avoid stale reads on other edge nodes.
export async function invalidateUserKV(phone, env) {
  try {
    await env.KV.delete(`${KV_USER_PREFIX}${phone}`);
  } catch (err) {
    console.log(`[cache] kv_invalidate_error phone=${phone} err=${err.message}`);
  }
}

export async function updateUser(phone, fields, env) {
  // 1. Supabase first — source of truth
  const patchRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/users?phone_number=eq.${phone}`,
    {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_KEY,
        Authorization: `Bearer ${env.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(fields)
    }
  );
  if (!patchRes.ok) {
    const errBody = await patchRes.text();
    console.log(`[db] updateUser_error status=${patchRes.status} fields=${JSON.stringify(Object.keys(fields))} body=${errBody.slice(0,200)}`);
  }

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