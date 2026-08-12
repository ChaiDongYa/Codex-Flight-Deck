import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { api } from "./server/api.mjs";

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    port: 48173,
    strictPort: true,
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), { name: "flight-deck-api", configureServer(server) { server.middlewares.use((request, response, next) => api(request, response).then((handled) => { if (!handled) next(); }).catch(next)); } }],
});
