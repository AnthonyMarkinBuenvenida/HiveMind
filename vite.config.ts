import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API is served by server.ts (Express), which runs Vite as middleware in development.
export default defineConfig({
  plugins: [react()],
  server: {
    // Google AI Studio sets DISABLE_HMR=true so its agent's edits don't make the preview flicker.
    hmr: process.env.DISABLE_HMR !== "true",
    watch: process.env.DISABLE_HMR === "true" ? null : {},
  },
});
