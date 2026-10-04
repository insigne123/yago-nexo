import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { Wso2Client } from "@nexo/wso2-client";

/**
 * Configuración de nexo-ctl: un bloque por etapa (dev, qa, prod). En producción cada etapa
 * apunta a su propia instalación; en el laboratorio comparten API Manager y se separan por
 * ambiente de gateway (host virtual).
 */
export interface StageConfig {
  apim: string;
  user: string;
  /** Nombre de la variable de entorno con la contraseña (nunca la contraseña en el archivo). */
  passwordEnv: string;
  insecureTls?: boolean;
  gateways: Array<{ name: string; vhost: string }>;
  publish?: boolean;
}

export interface CtlConfig {
  stages: Record<string, StageConfig>;
  baseDir: string;
}

const DEFAULT_CONFIG = "nexo-ctl.config.yaml";

export function loadConfig(path?: string): CtlConfig {
  const file = resolve(path ?? process.env.NEXO_CTL_CONFIG ?? DEFAULT_CONFIG);
  if (!existsSync(file)) throw new Error(`No existe el archivo de configuración ${file}`);
  const raw = parse(readFileSync(file, "utf8")) as { stages?: Record<string, StageConfig> };
  if (!raw?.stages || Object.keys(raw.stages).length === 0) throw new Error(`${file}: falta 'stages'`);
  return { stages: raw.stages, baseDir: dirname(file) };
}

export function stage(cfg: CtlConfig, name: string): StageConfig {
  const s = cfg.stages[name];
  if (!s) throw new Error(`Etapa desconocida '${name}'. Disponibles: ${Object.keys(cfg.stages).join(", ")}`);
  return s;
}

export function clientFor(s: StageConfig): Wso2Client {
  const password = process.env[s.passwordEnv];
  if (!password) throw new Error(`Falta la variable de entorno ${s.passwordEnv}`);
  return new Wso2Client({
    baseUrl: s.apim,
    auth: { type: "basic", username: s.user, password },
    tls: { rejectUnauthorized: !s.insecureTls },
  });
}
