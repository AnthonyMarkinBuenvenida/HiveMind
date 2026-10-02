import { defineConfig, loadEnv, type Plugin, type ViteDevServer, type PreviewServer } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error — plain ESM module shared with the Vercel functions
import { handleApi } from "./server/api.mjs";
// @ts-expect-error — plain ESM module shared with vercel.json (kept in sync by server/api.test.mjs)
import { SECURITY_HEADERS } from "./server/securityHeaders.mjs";

// Serves /api/* from the same dev/preview server so the API key stays server-side.
// In production the same handler runs as Vercel functions (api/*.mjs).
function apiPlugin(): Plugin {
  // Block body on purpose: a value returned from configureServer is treated as a post-hook.
  const mount = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((req, res, next) => {
      handleApi(req, res).then((handled: boolean) => !handled && next(), next);
    });
  };
  return { name: "hivemind-api", configureServer: mount, configurePreviewServer: mount };
}

export default defineConfig(({ mode }) => {
  // Load .env into the Node process only (never exposed to client code). Variables already
  // set in the shell take precedence over .env values (loadEnv merges process.env last).
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));
  return {
    plugins: [react(), apiPlugin()],
    server: { port: 5173 },
    // `npm run preview` mirrors production headers (the dev server can't: React refresh needs inline scripts).
    preview: { port: 8787, headers: SECURITY_HEADERS },
  };
});
