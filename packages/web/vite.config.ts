import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  server: {
    port: 5173,
    // In a container the dev server must bind to all interfaces so the host can
    // reach it (and proxy `/api` through to the server); locally it stays on
    // localhost. The `/api` proxy target is loopback, which is the same network
    // namespace as the server inside the Docker dev loop.
    host: process.env.MEOS_DEV_HOST === "true" ? true : undefined,
    proxy: {
      "/api": "http://127.0.0.1:4321",
    },
  },
});
