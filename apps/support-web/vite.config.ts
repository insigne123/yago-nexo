import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// @nexo/shared/browser se resuelve al código fuente para no depender del orden de build
// (la clasificación de severidad es la misma que usa la base de datos).
const sharedBrowser = fileURLToPath(new URL("../../packages/shared/src/browser.ts", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@nexo/shared/browser": sharedBrowser },
  },
  server: { port: 5174 },
  preview: { port: 4174 },
  build: {
    target: "es2022",
    // Sin mapas de fuente públicos: el sitio es público en Firebase Hosting.
    sourcemap: false,
    rolldownOptions: {
      output: {
        // Bibliotecas en paquetes propios: cambian poco y quedan en caché entre versiones.
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/ },
            { name: "supabase", test: /node_modules[\\/]@supabase[\\/]/ },
            { name: "vendor", test: /node_modules[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
