#!/usr/bin/env node
// nexo-respaldo: respaldo cifrado de PostgreSQL y prueba de restauración verificada.
//
//   nexo-respaldo respaldar  [--config <archivo>]
//   nexo-respaldo restaurar  [--config <archivo>] [--respaldo <id>]
//   nexo-respaldo listar     [--config <archivo>]
//   nexo-respaldo generar-clave --salida <archivo>
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { listarRespaldos } from "./almacen.js";
import { generarClaveHex } from "./cifrado.js";
import { cargarConfig } from "./config.js";
import { tamano, segundos, type InformeRestauracion } from "./informe.js";
import { ARCHIVO_MANIFIESTO, type Manifiesto } from "./manifiesto.js";
import { respaldar } from "./respaldar.js";
import { restaurar } from "./restaurar.js";

const AYUDA = `Uso: nexo-respaldo <comando> [opciones]

Comandos:
  respaldar       Respalda los servidores configurados (cifrado, con manifiesto y retención)
  restaurar       Prueba de restauración: restaura un respaldo en un PostgreSQL temporal y lo compara
  listar          Lista los respaldos del destino y el resultado de su última prueba
  generar-clave   Genera un archivo de clave maestra nuevo (32 bytes en hexadecimal)

Opciones:
  -c, --config <archivo>   configuración (por omisión respaldo.config.json o respaldo.config.example.json)
  -r, --respaldo <id>      respaldo a probar (por omisión, el más reciente)
  -s, --salida <archivo>   archivo de clave a crear (generar-clave)
  -h, --help               esta ayuda

Variables de entorno: NEXO_RESPALDO_CONFIG, NEXO_RESPALDO_MODO, NEXO_RESPALDO_DESTINO,
NEXO_RESPALDO_CLAVE, NEXO_RESPALDO_CONSERVAR, NEXO_RESPALDO_MAXIMO_DIAS, NEXO_RESPALDO_RED,
NEXO_RESPALDO_IMAGEN, NEXO_RESPALDO_BINARIOS y la variable de contraseña de cada servidor.`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      respaldo: { type: "string", short: "r" },
      salida: { type: "string", short: "s" },
      help: { type: "boolean", short: "h" },
    },
  });
  const comando = positionals[0];
  if (values.help || !comando) {
    console.log(AYUDA);
    return comando || values.help ? 0 : 2;
  }

  switch (comando) {
    case "respaldar": {
      const config = cargarConfig(values.config);
      const { manifiesto, carpeta, retencion } = await respaldar(config);
      const t = manifiesto.totales;
      console.log("");
      console.log(`RESPALDO COMPLETO ${manifiesto.id}`);
      console.log(`  ${t.servidores} servidores, ${t.bases} bases, ${t.tablas} tablas, ${t.filas} filas`);
      console.log(
        `  ${tamano(t.bytes)} cifrados (AES-256-GCM, clave ${manifiesto.cifrado.huellaClave}) en ${segundos(manifiesto.duracionMs)}`,
      );
      console.log(`  ${carpeta}`);
      console.log(
        `  retención: se conservan ${retencion.conservar.length}, se eliminaron ${retencion.borrar.length}`,
      );
      return 0;
    }
    case "restaurar": {
      const config = cargarConfig(values.config);
      const { informe, carpeta } = await restaurar(
        config,
        values.respaldo ? { respaldo: values.respaldo } : {},
      );
      const t = informe.totales;
      console.log("");
      console.log(
        `PRUEBA DE RESTAURACIÓN ${informe.resultado === "exitosa" ? "EXITOSA" : "FALLIDA"} · respaldo ${informe.respaldo}`,
      );
      console.log(
        `  ${t.bases} bases restauradas y comparadas: ${t.tablasComparadas} tablas, ${t.filasComparadas} filas, ${t.diferencias} diferencias`,
      );
      console.log(
        `  RTO medido: ${segundos(informe.rtoMedidoMs)} (duración total con la comparación: ${segundos(informe.duracionTotalMs)})`,
      );
      for (const e of informe.errores) console.log(`  ERROR: ${e}`);
      for (const a of informe.avisos) console.log(`  AVISO: ${a}`);
      console.log(`  informe: ${join(carpeta, "informe-restauracion.md")}`);
      return informe.interrumpida ? 130 : informe.resultado === "exitosa" ? 0 : 1;
    }
    case "listar": {
      const config = cargarConfig(values.config);
      const lista = await listarRespaldos(config.destino);
      if (!lista.length) {
        console.log(`No hay respaldos en ${config.destino}`);
        return 0;
      }
      console.log(
        `Respaldos en ${config.destino} (retención: ${config.retencion.conservar} más recientes${config.retencion.maximoDias ? `, máximo ${config.retencion.maximoDias} días` : ""})`,
      );
      for (const r of lista) {
        const m = JSON.parse(await readFile(join(r.carpeta, ARCHIVO_MANIFIESTO), "utf8")) as Manifiesto;
        const rutaInforme = join(r.carpeta, "informe-restauracion.json");
        let prueba = "sin prueba de restauración";
        if (existsSync(rutaInforme)) {
          const i = JSON.parse(await readFile(rutaInforme, "utf8")) as InformeRestauracion;
          prueba = `prueba ${i.resultado} el ${i.inicio.slice(0, 16).replace("T", " ")} (RTO ${segundos(i.rtoMedidoMs)})`;
        }
        console.log(
          `  ${r.id}  ${m.totales.bases} bases  ${m.totales.filas} filas  ${tamano(m.totales.bytes)}  ${prueba}`,
        );
      }
      return 0;
    }
    case "generar-clave": {
      if (!values.salida) throw new Error("indique --salida <archivo>");
      const ruta = resolve(values.salida);
      await writeFile(ruta, `${generarClaveHex()}\n`, { mode: 0o600, flag: "wx" });
      console.log(
        `Clave creada en ${ruta} (permisos 600). Guárdela en el gestor de secretos y en custodia separada de los respaldos.`,
      );
      return 0;
    }
    default:
      console.error(`Comando desconocido: ${comando}\n\n${AYUDA}`);
      return 2;
  }
}

main().then(
  (codigo) => {
    process.exitCode = codigo;
  },
  (e: unknown) => {
    console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
