import type { IncomingHttpHeaders } from "node:http";

// ---------------------------------------------------------------------------
// Console sign-in for browser calls
//
// A browser call runs speech recognition, speech synthesis and the agent at the
// providers' cost, so it needs an agent's console sign-in, from one of the exact
// origins the console is served from. Behind the proxy the call page, the API and
// this service share one origin, so the browser sends the console's session cookie
// with the WebSocket upgrade, and the API says whether that session is valid.
// ---------------------------------------------------------------------------

const API_BASE_URL = process.env.AGENT_BASE_URL ?? "http://127.0.0.1:4100";
const CALLING_ROLES = new Set(["AGENT", "SUPERVISOR", "ADMIN"]);

/** Open the call, or the status that refuses it (503: the sign-in could not be checked). */
export type BrowserCallDecision = "open" | 401 | 403 | 503;

/**
 * BROWSER_ORIGINS, parsed as the API parses it (apps/api/src/browserOrigin.ts): exact
 * bare origins only, no wildcard or prefix match.
 */
export function browserOrigins(): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const entry of (process.env.BROWSER_ORIGINS ?? "").split(",")) {
    const value = entry.trim().replace(/\/$/, "");
    if (!value || value.includes("*")) continue;
    try {
      if (new URL(value).origin === value) origins.add(value);
    } catch {
      // Not a URL; ignored like any other entry that is not a bare origin.
    }
  }
  return origins;
}

export async function browserCallDecision(headers: IncomingHttpHeaders): Promise<BrowserCallDecision> {
  // Checked before the session, so another site's page never gets as far as the API.
  if (headers.origin === undefined || !browserOrigins().has(headers.origin)) return 403;
  if (!headers.cookie) return 401;
  try {
    const response = await fetch(`${API_BASE_URL}/api/admin/me`, { headers: { cookie: headers.cookie }, signal: AbortSignal.timeout(5_000) });
    if (response.status === 401) return 401;
    if (!response.ok) return 503;
    const body = (await response.json()) as { user?: { role?: string } };
    return CALLING_ROLES.has(body.user?.role ?? "") ? "open" : 403;
  } catch {
    return 503;
  }
}
