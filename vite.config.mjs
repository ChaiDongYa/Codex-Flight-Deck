import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { api } from "./server/api.mjs";

export default defineConfig({
  build: {
    outDir: "dist/client",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("/react/") || id.includes("/react-dom/")) return "react-vendor";
          if (id.includes("/antd/")) return "antd-ui";
          if (id.includes("/rc-")) return "antd-runtime";
        },
      },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    port: 48173,
    strictPort: true,
    // The Codex app owns the blank host frame while Vite serves its module
    // assets. Allow that isolated app origin during local development.
    cors: true,
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), { name: "flight-deck-api", configureServer(server) { server.middlewares.use((request, response, next) => api(request, response).then((handled) => { if (!handled) next(); }).catch(next)); } }],
});
