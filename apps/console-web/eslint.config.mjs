import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import base from "../../eslint.config.mjs";

// Configuración de la Consola web: la del monorepo más reglas de React (hooks y compilador)
// y globales de navegador. El plugin se resuelve desde este paquete.
export default [
  ...base,
  {
    ignores: ["public/mockServiceWorker.js", "src/api/schema.d.ts"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: reactHooks.configs.flat.recommended.plugins,
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      "react-hooks/exhaustive-deps": "error",
    },
  },
];
