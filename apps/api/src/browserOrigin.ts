import type express from "express";

// ---------------------------------------------------------------------------
// Browser origins
//
// BROWSER_ORIGINS lists, comma-separated, the exact origins the console and demo
// pages are served from (for example https://msva.example.com). There is no
// wildcard, reflection or prefix match. Browser POSTs that sign in or spend
// provider credits must come from one of them, and credentialed CORS answers
// only them. With the list empty, every such request is refused.
// ---------------------------------------------------------------------------

export function browserOrigins(): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const entry of (process.env.BROWSER_ORIGINS ?? "").split(",")) {
    const value = entry.trim().replace(/\/$/, "");
    if (!value || value.includes("*")) continue;
    try {
      // Only a bare origin counts: a scheme, host and port, and nothing after them.
      if (new URL(value).origin === value) origins.add(value);
    } catch {
      // Not a URL; ignored like any other entry that is not a bare origin.
    }
  }
  return origins;
}

/** Refuses a request whose Origin header is not exactly one of the browser origins. */
export function requireBrowserOrigin(request: express.Request, response: express.Response, next: express.NextFunction): void {
  const origin = request.get("origin");
  if (origin === undefined || !browserOrigins().has(origin)) {
    response.status(403).json({ error: "Origin not allowed" });
    return;
  }
  next();
}

/** For the cors middleware: allow exactly the browser origins, and nothing else. */
export function corsOrigin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void): void {
  callback(null, origin !== undefined && browserOrigins().has(origin));
}
