// Minimal PostgREST client using the service-role key (server-side only).
// No supabase-js dependency needed for the small set of queries this app makes.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const REST_URL = `${SUPABASE_URL}/rest/v1`;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

export async function pgSelect<T = any>(
  table: string,
  query: string,
): Promise<T[]> {
  const res = await fetch(`${REST_URL}/${table}?${query}`, {
    headers: headers(),
  });
  if (!res.ok) {
    throw new Error(`pgSelect ${table} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function pgInsert<T = any>(
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
  opts: { onConflict?: string; returning?: boolean } = {},
): Promise<T[]> {
  const params = new URLSearchParams();
  if (opts.onConflict) params.set("on_conflict", opts.onConflict);
  const url = `${REST_URL}/${table}${params.toString() ? "?" + params.toString() : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers({
      Prefer: opts.onConflict
        ? "resolution=merge-duplicates,return=representation"
        : "return=representation",
    }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    throw new Error(`pgInsert ${table} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function pgUpdate<T = any>(
  table: string,
  query: string,
  patch: Record<string, unknown>,
): Promise<T[]> {
  const res = await fetch(`${REST_URL}/${table}?${query}`, {
    method: "PATCH",
    headers: headers({ Prefer: "return=representation" }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(`pgUpdate ${table} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function pgDelete<T = any>(table: string, query: string): Promise<T[]> {
  const res = await fetch(`${REST_URL}/${table}?${query}`, {
    method: "DELETE",
    headers: headers({ Prefer: "return=representation" }),
  });
  if (!res.ok) {
    throw new Error(`pgDelete ${table} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Bot secrets can come either from an env var (handy for local dev via
// `supabase secrets set` / `--env-file`) or from the `settings` table
// (used in production, see README). Env var wins if both are set.
const SETTING_ENV_FALLBACK: Record<string, string> = {
  telegram_bot_token: "TELEGRAM_BOT_TOKEN",
  telegram_webhook_secret: "TELEGRAM_WEBHOOK_SECRET",
};

export async function getSetting(key: string): Promise<string | null> {
  const envKey = SETTING_ENV_FALLBACK[key];
  if (envKey) {
    const fromEnv = Deno.env.get(envKey);
    if (fromEnv) return fromEnv;
  }
  const rows = await pgSelect<{ value: string }>(
    "settings",
    `key=eq.${encodeURIComponent(key)}&select=value`,
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await pgInsert(
    "settings",
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
}
