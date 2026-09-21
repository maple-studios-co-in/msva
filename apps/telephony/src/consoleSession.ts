// ---------------------------------------------------------------------------
// Console sign-in for browser calls
//
// A browser call runs speech recognition, speech synthesis and the agent at the
// providers' cost, so it needs a console sign-in. Behind the proxy the call page,
// the API and this service share one origin, so the browser sends the console's
// session cookie with the WebSocket upgrade (SameSite=Lax keeps other sites' pages
// from sending it), and the API says whether that session is valid.
// ---------------------------------------------------------------------------

const API_BASE_URL = process.env.AGENT_BASE_URL ?? "http://127.0.0.1:4100";

/** Open the call, refuse it as unauthorized, or refuse it because the check failed. */
export type BrowserCallDecision = "open" | 401 | 503;

export async function browserCallDecision(cookie: string | undefined): Promise<BrowserCallDecision> {
  if (!cookie) return 401;
  try {
    const response = await fetch(`${API_BASE_URL}/api/admin/me`, { headers: { cookie }, signal: AbortSignal.timeout(5_000) });
    if (response.status === 401) return 401;
    return response.ok ? "open" : 503;
  } catch {
    return 503;
  }
}
