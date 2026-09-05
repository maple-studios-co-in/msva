import { resolve } from "node:path";
import { defineConfig } from "vite";

// Two entry points from one build: the demo app (index.html) and the admin
// console (console.html). Caddy serves both from apps/web/dist; the console is
// reachable at /console.html.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        console: resolve(__dirname, "console.html")
      }
    }
  }
});
