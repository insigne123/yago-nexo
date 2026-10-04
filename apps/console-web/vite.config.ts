import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// La Consola usa solo la entrada de navegador de @nexo/shared. Se resuelve contra el código
// fuente para que dev, pruebas y build funcionen sin compilar antes el paquete compartido.
const sharedBrowser = fileURLToPath(new URL("../../packages/shared/src/browser.ts", import.meta.url));

export default defineConfig({
  // Ruta base de publicación (por defecto la raíz). Ej.: NEXO_BASE_PATH=/consola/ pnpm build
  base: process.env.NEXO_BASE_PATH ?? "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@nexo/shared/browser": sharedBrowser },
  },
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "1.0.0"),
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // API de la Consola en desarrollo (modo oidc o supabase sin datos simulados).
      "/api": { target: process.env.NEXO_API_URL ?? "http://localhost:3000", changeOrigin: true },
    },
  },
  preview: { port: 4173 },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    restoreMocks: true,
  },
});
