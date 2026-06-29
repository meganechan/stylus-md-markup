import { defineConfig } from "vite";
import { resolve } from "node:path";

// Two surfaces, one repo (ADR-0002): the markup tool (index.html) and the review
// desk (review.html), both consuming the shared ink engine.
// Dev: proxy API + static mount to the Bun backend on :8080.
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
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        review: resolve(__dirname, "review.html"),
      },
    },
  },
});
