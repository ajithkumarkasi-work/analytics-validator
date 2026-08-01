import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  base: "/new-relic-validator/",
  build: {
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: false,
  },
});
