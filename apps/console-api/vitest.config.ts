import { defineConfig } from "vitest/config";

// Las pruebas definen controladores de Nest: usan decoradores heredados con sus metadatos de tipo, como
// tsconfig.json (experimentalDecorators y emitDecoratorMetadata), que excluye las pruebas de la compilación.
export default defineConfig({
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
});
