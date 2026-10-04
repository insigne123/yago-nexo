// ESLint del sitio: reglas del monorepo + navegador y React Hooks para src/.
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

import raiz from "../../eslint.config.mjs";

export default tseslint.config(...raiz, {
  files: ["src/**/*.{ts,tsx}"],
  languageOptions: {
    globals: { ...globals.browser },
  },
  ...reactHooks.configs.flat.recommended,
});
