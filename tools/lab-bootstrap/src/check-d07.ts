/** Verificación de D-07: generación de SDK desde el contrato OpenAPI publicado, en al menos tres lenguajes. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { Wso2Client } from "@nexo/wso2-client";

const wso2 = new Wso2Client({
  baseUrl: "https://apim:9443",
  auth: { type: "basic", username: "admin", password: process.env.APIM_ADMIN_PASSWORD ?? "admin" },
  tls: { rejectUnauthorized: false },
});

async function main() {
  const langs = await wso2.devportal.sdkLanguages();
  console.log(`[D-07] lenguajes disponibles en el portal: ${langs.join(", ")}`);
  const api = (await wso2.devportal.listApis()).list.find((a) => a.name === "Concesiones");
  if (!api) throw new Error("falta la API Concesiones");
  const out = join(process.cwd(), "../../out/sdk");
  mkdirSync(out, { recursive: true });
  let ok = 0;
  for (const lang of ["java", "javascript", "python", "csharp"]) {
    try {
      const zip = await wso2.devportal.generateSdk(api.id, lang);
      const files = Object.keys(unzipSync(new Uint8Array(zip)));
      writeFileSync(join(out, `concesiones-sdk-${lang}.zip`), zip);
      console.log(`[D-07] SDK ${lang}: ${(zip.length / 1024).toFixed(0)} KB, ${files.length} archivos (ej.: ${files.find((f) => /api|Api/.test(f)) ?? files[0]})`);
      ok++;
    } catch (e) {
      console.log(`[D-07] SDK ${lang}: ERROR ${e instanceof Error ? e.message.slice(0, 200) : e}`);
    }
  }
  console.log(ok >= 3 ? `[D-07] verificado: ${ok} lenguajes generados` : `[D-07] NO cumple: solo ${ok} lenguajes`);
  if (ok < 3) process.exit(1);
}
main().catch((e) => {
  console.error("[D-07] ERROR", e instanceof Error ? e.message : e);
  process.exit(1);
});
