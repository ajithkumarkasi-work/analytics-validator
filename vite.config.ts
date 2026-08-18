import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/nr-graphql": {
        target: "https://api.newrelic.com",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/nr-graphql/, "/graphql"),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            const apiKey = req.headers["api-key"];
            if (apiKey) proxyReq.setHeader("Api-Key", apiKey);
          });
        },
      },
    },
  },
  base: "/analytics-validator/",
  build: {
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: false,
  },
});
