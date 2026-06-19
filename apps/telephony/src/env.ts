import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load this service's own .env BEFORE any other module is evaluated.
//
// ES modules evaluate imports before the importing file's body, and several
// modules read process.env at evaluation time — notably asr/sarvam.ts and
// tts/sarvam.ts read SARVAM_API_KEY, and pipeline.ts reads TTS_VOICE etc. If
// dotenv ran in server.ts's body those would already be undefined (→ stub ASR /
// silent TTS). Importing this module first guarantees the env is populated
// first. The path is resolved from the compiled file (apps/telephony/dist →
// apps/telephony/.env), so it doesn't depend on pm2's working directory.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../.env") });
