// X4 Companion UI build.
//  - "@"    -> ui/src
//  - "@web" -> ../web : the framework-free map module (map.js, mapstyle.js, camera.js, map-strings.js and
//    the helpers they import) is NOT copied; it is imported from the old shell folder so fixes made there
//    flow into this build on the next `npm run build`.
// Output: ../web-dist (served by server.py when it exists). Dev: `npm run dev` proxies the API, the icons
// and the websocket to a local server (X4C_DEV_PORT, default 8791); the server only accepts its own
// Host/Origin, so the proxy rewrites both.
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const WEB = path.resolve(import.meta.dirname, "../web");
const DEV_PORT = Number(process.env.X4C_DEV_PORT || 8791);
const TARGET = `http://127.0.0.1:${DEV_PORT}`;

// The bundled UI font (Titillium Web, SIL OFL 1.1) lands in assets/ with hashed names; the OFL requires
// its licence to travel with every copy, so the build puts it next to them.
const FONT_LICENSE = path.resolve(import.meta.dirname, "src/assets/fonts/titillium/LICENSE.txt");
function fontLicense(): Plugin {
  return {
    name: "x4c-font-license",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "assets/titillium-web-OFL-1.1-LICENSE.txt", source: fs.readFileSync(FONT_LICENSE, "utf8") });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), fontLicense()],
  resolve: {
    alias: {
      "@web": WEB,
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  base: "/",
  build: {
    outDir: path.resolve(import.meta.dirname, "../web-dist"),
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: { allow: [path.resolve(import.meta.dirname), WEB] },
    proxy: {
      "/api": { target: TARGET, changeOrigin: true },
      "/icons": { target: TARGET, changeOrigin: true },
      "/ws": {
        target: TARGET.replace("http", "ws"), ws: true, changeOrigin: true,
        configure: (proxy) => { proxy.on("proxyReqWs", (req) => req.setHeader("origin", TARGET)); },
      },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
