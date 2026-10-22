import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, host: true },
  preview: { port: 5173, strictPort: true, host: true },
  build: {
    sourcemap: true,
    // The lazily-loaded player chunk carries the full hls.js build (~630 kB). The
    // "light" build would halve it but drops WebVTT subtitles, which captions need.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: { react: ["react", "react-dom", "react-router-dom"], query: ["@tanstack/react-query"] },
      },
    },
  },
});
