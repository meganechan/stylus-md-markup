import { defineConfig } from "vite";

// Dev: proxy API + static mount to the Bun backend on :8080.
// Build: emit to ../web/dist (served by the backend in the container).
export default defineConfig({
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/static": "http://localhost:8080",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
