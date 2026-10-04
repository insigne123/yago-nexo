#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { loadConfig, stage } from "./config.js";
import { platformApply } from "./commands/platform.js";
import { deployApi, exportApis, lintAll, listApis, rollbackApi, runLint } from "./commands/api.js";

const program = new Command();
program
  .name("nexo-ctl")
  .description("CLI de Yago Nexo: plataforma como código, contratos, despliegue, reversa y exportación")
  .option("-c, --config <archivo>", "archivo de configuración", "nexo-ctl.config.yaml");

const run = (fn: () => Promise<void> | void) => async () => {
  try {
    await fn();
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
};

const platform = program.command("platform").description("Configuración de la plataforma");
platform
  .command("apply")
  .description("Aplica ambientes, políticas de tráfico, flujos de aprobación y gobierno")
  .requiredOption("-s, --stage <etapa>", "etapa (dev, qa, prod)")
  .option("-f, --file <archivo>", "especificación de plataforma", "wso2/apim/platform.yaml")
  .action((o: { stage: string; file: string }) =>
    run(async () => {
      const cfg = loadConfig(program.opts().config);
      const file = existsSync(resolve(o.file)) ? resolve(o.file) : resolve(cfg.baseDir, o.file);
      await platformApply(cfg, stage(cfg, o.stage), file);
    })(),
  );

const api = program.command("api").description("Ciclo de vida de APIs");
api
  .command("lint <contrato>")
  .description("Valida un contrato OpenAPI contra la guía de estilo (D-03); termina con error si no cumple")
  .option("-r, --ruleset <archivo>", "guía de estilo", "wso2/apim/governance/guia-estilo-institucional.yaml")
  .action((contrato: string, o: { ruleset: string }) =>
    run(() => {
      if (!runLint(resolve(contrato), { ruleset: resolve(o.ruleset) })) process.exitCode = 2;
    })(),
  );
api
  .command("lint-all")
  .description("Valida todos los contratos de wso2/apim/apis contra su guía de estilo (paso del pipeline de CI)")
  .option("-d, --dir <carpeta>", "carpeta de proyectos de API", "wso2/apim/apis")
  .option("-g, --governance <carpeta>", "carpeta de guías de estilo", "wso2/apim/governance")
  .action((o: { dir: string; governance: string }) =>
    run(() => {
      const cfg = loadConfig(program.opts().config);
      const at = (p: string) => (existsSync(resolve(p)) ? resolve(p) : resolve(cfg.baseDir, p));
      if (!lintAll(at(o.dir), at(o.governance))) process.exitCode = 2;
    })(),
  );
api
  .command("deploy <proyecto>")
  .description("Valida, versiona y despliega un proyecto de API en una etapa")
  .requiredOption("-s, --stage <etapa>", "etapa (dev, qa, prod)")
  .option("-m, --message <texto>", "descripción de la revisión", "Despliegue por pipeline")
  .option("-r, --ruleset <archivo>", "guía de estilo", "wso2/apim/governance/guia-estilo-institucional.yaml")
  .action((proyecto: string, o: { stage: string; message: string; ruleset: string }) =>
    run(async () => {
      const cfg = loadConfig(program.opts().config);
      // Las rutas por defecto se resuelven desde la raíz del repositorio (donde está la configuración).
      const ruleset = existsSync(resolve(o.ruleset)) ? resolve(o.ruleset) : resolve(cfg.baseDir, o.ruleset);
      await deployApi(cfg, o.stage, stage(cfg, o.stage), resolve(proyecto), { ruleset, message: o.message });
    })(),
  );
api
  .command("rollback <nombre> <version>")
  .description("Vuelve a la revisión anterior en los gateways donde está desplegada")
  .requiredOption("-s, --stage <etapa>", "etapa (dev, qa, prod)")
  .action((nombre: string, version: string, o: { stage: string }) =>
    run(async () => {
      const cfg = loadConfig(program.opts().config);
      await rollbackApi(stage(cfg, o.stage), nombre, version);
    })(),
  );
api
  .command("export")
  .description("Exporta todas las APIs con manifiesto de hashes (BT-049)")
  .requiredOption("-s, --stage <etapa>", "etapa")
  .option("-o, --out <dir>", "carpeta de salida", "out/export")
  .action((o: { stage: string; out: string }) =>
    run(async () => {
      const cfg = loadConfig(program.opts().config);
      await exportApis(stage(cfg, o.stage), resolve(o.out));
    })(),
  );
api
  .command("list")
  .requiredOption("-s, --stage <etapa>", "etapa")
  .action((o: { stage: string }) =>
    run(async () => {
      const cfg = loadConfig(program.opts().config);
      await listApis(stage(cfg, o.stage));
    })(),
  );

await program.parseAsync();
