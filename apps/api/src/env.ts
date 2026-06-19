import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load this service's own .env BEFORE any other module is evaluated.
//
// Why a dedicated module imported first: ES modules evaluate all `import`
// statements before the importing file's body runs. Several modules read
// process.env at evaluation time (OLLAMA_MODEL, AGENT_LLM, SARVAM_API_KEY …),
// so calling dotenv.config() in server.ts's body is too late — those values are
// already baked in as undefined. Importing this module first guarantees the env
// is populated first. Resolving the path from the compiled file location
// (apps/api/dist → apps/api/.env) also makes it independent of the working
// directory pm2 launches from.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../.env") });
