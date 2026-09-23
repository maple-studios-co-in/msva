import type express from "express";

// ---------------------------------------------------------------------------
// Browser origins
//
// BROWSER_ORIGINS lists, comma-separated, the origins the console and demo pages
// are served from (for example https://msva.example.com). Each entry is read as
// its canonical origin (lowercase host, punycode, no default port), and requests
// must carry exactly one of those: there is no wildcard, reflection or prefix
// match. Browser POSTs that sign in or spend provider credits must come from one
// of them, and credentialed CORS answers only them. With the list empty, every
// such request is refused. The telephony service reads the same list the same way
// (apps/telephony/src/consoleSession.ts).
// ---------------------------------------------------------------------------

/** The canonical origins listed, and the entries that are not bare http(s) origins. */
export function parseBrowserOrigins(value: string | undefined): { origins: Set<string>; ignored: string[] } {
  const origins = new Set<string>();
  const ignored: string[] = [];
  for (const entry of (value ?? "").split(",")) {
    const text = entry.trim();
    if (!text) continue;
    const origin = canonicalOrigin(text);
    if (origin) origins.add(origin);
    else ignored.push(text);
  }
  return { origins, ignored };
}

/** Exported so the voice signaling origin is read the same way as this list. */
export function canonicalOrigin(text: string): string | null {
  if (text.includes("*")) return null;
  try {
    const url = new URL(text);
    const bare = (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      && url.pathname === "/" && !url.search && !url.hash;
    return bare ? url.origin : null;
  } catch {
    return null;
  }
}

export function browserOrigins(): ReadonlySet<string> {
  return parseBrowserOrigins(process.env.BROWSER_ORIGINS).origins;
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
