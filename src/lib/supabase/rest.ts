import { getDayPlanCsrfToken } from "../data/day-plan";

type QueryValue = string | number | boolean | null | undefined;

type ForgeRestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  requireAuth?: boolean;
};

type SupabaseRefreshResponse = {
  access_token?: string;
  refresh_token?: string;
};

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const tablePrefix = process.env.NEXT_PUBLIC_FORGE_TABLE_PREFIX ?? "";
const accessTokenStorageKey = "forge.supabase.accessToken";
const refreshTokenStorageKey = "forge.supabase.refreshToken";
const useServerRest =
  process.env.NEXT_PUBLIC_FORGE_SERVER_REST !== "disabled";

function getStoredToken(key: string): string | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStoredToken(key: string, value: string): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures; the current request can still use the token.
  }
}

export function clearStoredSupabaseTokens(): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(accessTokenStorageKey);
    window.localStorage.removeItem(refreshTokenStorageKey);
  } catch {
    // Ignore storage failures; future requests can still use anon access.
  }
}

function getAuthorizationToken(): string {
  return getStoredToken(accessTokenStorageKey) || supabaseAnonKey || "";
}

function hasStoredAccessToken(): boolean {
  return Boolean(getStoredToken(accessTokenStorageKey));
}

async function refreshAuthorizationToken(): Promise<string | null> {
  if (!supabaseUrl || !supabaseAnonKey) return null;

  const refreshToken = getStoredToken(refreshTokenStorageKey);
  if (!refreshToken) return null;

  const response = await fetch(
    `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: {
        apikey: supabaseAnonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }
  );

  if (!response.ok) {
    clearStoredSupabaseTokens();
    return null;
  }

  const payload = (await response.json()) as SupabaseRefreshResponse;
  if (!payload.access_token) {
    clearStoredSupabaseTokens();
    return null;
  }

  setStoredToken(accessTokenStorageKey, payload.access_token);
  if (payload.refresh_token) {
    setStoredToken(refreshTokenStorageKey, payload.refresh_token);
  }

  return payload.access_token;
}

function resolveTableName(table: string): string {
  return tablePrefix && !table.startsWith(tablePrefix)
    ? `${tablePrefix}${table}`
    : table;
}

function buildUrl(table: string, query: ForgeRestOptions["query"]): string {
  if (!supabaseUrl) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not configured.");
  }

  const url = new URL(`/rest/v1/${resolveTableName(table)}`, supabaseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function buildServerUrl(table: string, query: ForgeRestOptions["query"]): string {
  const url = new URL(
    `/api/forge-rest/${encodeURIComponent(table)}`,
    "http://forge.local"
  );
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}

async function request(table: string, options: ForgeRestOptions, token: string) {
  const method = options.method ?? "GET";
  return fetch(buildUrl(table, options.query), {
    method,
    headers: {
      apikey: supabaseAnonKey ?? "",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body:
      method === "GET" || options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
  });
}

async function serverRequest<T>(
  table: string,
  options: ForgeRestOptions
): Promise<T> {
  const method = options.method ?? "GET";
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  const csrfToken = method === "GET" ? undefined : await getDayPlanCsrfToken();
  const response = await fetch(buildServerUrl(table, options.query), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-Forge-CSRF": csrfToken } : {}),
    },
    signal: controller.signal,
    body:
      method === "GET" || options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
  }).finally(() => window.clearTimeout(timeout));

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Forge ${method} ${table} failed: ${message}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function forgeRest<T>(
  table: string,
  options: ForgeRestOptions = {}
): Promise<T> {
  if (useServerRest && typeof window !== "undefined") {
    return serverRequest<T>(table, options);
  }

  if (!supabaseAnonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not configured.");
  }

  const method = options.method ?? "GET";
  const initialToken = getAuthorizationToken();
  let requestToken = initialToken;

  if (options.requireAuth && !hasStoredAccessToken()) {
    throw new Error("Supabase sign-in is required to read Forge data.");
  }

  if (method !== "GET" && !hasStoredAccessToken()) {
    throw new Error("Supabase sign-in is required to modify Forge data.");
  }

  let response = await request(table, options, requestToken);

  if (response.status === 401 && requestToken !== supabaseAnonKey) {
    const refreshedToken = await refreshAuthorizationToken();
    if (refreshedToken) {
      requestToken = refreshedToken;
      response = await request(table, options, requestToken);
    } else if (options.requireAuth) {
      throw new Error("Supabase sign-in is required to read Forge data.");
    } else if (method === "GET") {
      requestToken = supabaseAnonKey;
      response = await request(table, options, requestToken);
    }
  }

  if (!response.ok && method === "GET" && requestToken !== supabaseAnonKey && !options.requireAuth) {
    requestToken = supabaseAnonKey;
    response = await request(table, options, requestToken);
  }

  if (response.status === 401 && requestToken !== supabaseAnonKey) {
    clearStoredSupabaseTokens();
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Supabase ${method} ${resolveTableName(table)} failed: ${message}`
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
