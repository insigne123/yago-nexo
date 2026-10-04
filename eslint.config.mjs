import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/.docusaurus/**",
      "**/node_modules/**",
      "**/target/**",
      "deploy/**",
      "wso2/**",
      "supabase/functions/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "off",
    },
  },
  {
    // NestJS resuelve dependencias con los metadatos de tipo de los constructores (emitDecoratorMetadata):
    // las clases inyectadas deben importarse como valor, no con `import type`.
    files: ["apps/console-api/src/**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },
);
