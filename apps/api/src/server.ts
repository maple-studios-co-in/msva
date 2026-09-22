import "./env.js"; // must be first — loads .env before any env-reading module
import { createApp } from "./app.js";
import { startAssessmentWorker } from "./assessmentWorker.js";
import { parseBrowserOrigins } from "./browserOrigin.js";
import { startVoiceSweeper } from "./voiceSweeper.js";

// The API's entry point starts the service whenever it is loaded. pm2's fork mode loads
// it from its own container script, so it must not check how it was started; tests
// build the app from ./app.js instead.
const port = Number(process.env.PORT ?? 4100);

const { origins, ignored } = parseBrowserOrigins(process.env.BROWSER_ORIGINS);
for (const entry of ignored) console.warn(`[api] BROWSER_ORIGINS entry ${JSON.stringify(entry)} is not an origin (scheme://host[:port]) and is ignored`);
if (origins.size === 0) {
  console.warn("[api] BROWSER_ORIGINS is empty: browser sign-in and the demo's paid routes will refuse every request");
}
export const server = createApp().listen(port, () => {
  console.log(`MSVA API running on http://localhost:${port}`);
});
const assessmentWorker = startAssessmentWorker();
const voiceSweeper = startVoiceSweeper();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void Promise.all([assessmentWorker.stop(), voiceSweeper.stop()]).finally(() => server.close());
  });
}
