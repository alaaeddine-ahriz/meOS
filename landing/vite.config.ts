import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Standalone marketing site for meOS. Deploy `dist/` to any static host.
// The GitHub Pages workflow sets BASE_PATH="/meOS/" because project pages are
// served under /<repo>/; locally and on root domains it stays "/".
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [react(), tailwindcss()],
});
