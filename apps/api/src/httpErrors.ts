import type express from "express";

/**
 * Last-resort API error handler. Malformed or oversized JSON is the client's
 * mistake, and the parser error carries the raw body (which can hold transcript
 * text or credentials), so it is answered without being logged.
 */
export function apiErrorHandler(error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction): void {
  const parserError = error as { type?: unknown };
  if (parserError?.type === "entity.parse.failed") {
    response.status(400).json({ error: "INVALID_JSON" });
    return;
  }
  if (parserError?.type === "entity.too.large") {
    response.status(413).json({ error: "PAYLOAD_TOO_LARGE" });
    return;
  }
  console.error(error);
  response.status(500).json({ error: "Internal server error" });
}
