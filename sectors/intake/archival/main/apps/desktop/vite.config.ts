import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// in a browser the ui talks to `archival serve` through this proxy, which adds the bridge token
function bridgeToken(): string {
  const vault = process.env.ARCHIVAL_VAULT || join(homedir(), "archival");
  try {
    return readFileSync(join(vault, ".archival", "bridge-token"), "utf8").trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      "@paper-design/shaders": resolve(__dirname, "../../vendor/paper-shaders@0.0.82/dist/index.js"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7311",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => req.setHeader("x-archival-token", bridgeToken()));
        },
      },
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1600,
  },
});
