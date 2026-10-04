// Respaldo lógico, consistente y cifrado de los servidores PostgreSQL configurados (BT-058, BT-053).
//
// Por cada base: transacción REPEATABLE READ → pg_export_snapshot() → conteo de filas (y huella)
// de cada tabla dentro del snapshot → pg_dump -Fc --snapshot=<id> → COMMIT. Así el manifiesto
// describe exactamente lo que contiene el archivo. La salida de pg_dump se cifra al vuelo: el
// volcado sin cifrar nunca se escribe en disco.
import { existsSync, createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type pg from "pg";
import { aplicarRetencion, cargarClave, limpiarParciales, tomarBloqueo, type Registro } from "./almacen.js";
import { crearCifrador, huellaClave, Medidor } from "./cifrado.js";
import { versionHerramienta, type Config, type ConfigServidor } from "./config.js";
import {
  comandoPg,
  eliminarContenedor,
  ipContenedor,
  lanzar,
  versionPgDump,
  type ComandoPg,
} from "./ejecucion.js";
import {
  ARCHIVO_MANIFIESTO,
  construirManifiesto,
  idDeFecha,
  nombreArchivo,
  type Artefacto,
  type BaseRespaldada,
  type Manifiesto,
  type ServidorRespaldado,
} from "./manifiesto.js";
import {
  conectar,
  contarTablas,
  exportarSnapshot,
  listarBases,
  sondaAuditoria,
  versionServidor,
} from "./postgres.js";
import type { DecisionRetencion } from "./retencion.js";

export interface ResultadoRespaldo {
  manifiesto: Manifiesto;
  carpeta: string;
  retencion: DecisionRetencion;
}

const ms = (desde: number) => Math.round(performance.now() - desde);

/** Ejecuta el volcado y escribe su salida cifrada; devuelve tamaños y SHA-256 del archivo cifrado. */
async function volcarCifrado(
  cmd: ComandoPg,
  carpeta: string,
  archivo: string,
  clave: Buffer,
  config: Config,
  log: Registro,
): Promise<Artefacto> {
  const ruta = join(carpeta, archivo);
  await mkdir(dirname(ruta), { recursive: true, mode: 0o700 });
  const { proceso, terminado } = lanzar(cmd.comando, cmd.args, cmd.env);
  const claro = new Medidor();
  const cifrado = new Medidor();
  try {
    await pipeline(
      proceso.stdout,
      claro,
      crearCifrador(clave, { tamanoBloque: config.tamanoBloque }),
      cifrado,
      createWriteStream(ruta, { flags: "wx", mode: 0o600 }),
    );
  } catch (e) {
    proceso.kill("SIGTERM");
    if (cmd.contenedor) await eliminarContenedor(cmd.contenedor);
    const fin = await terminado;
    throw new Error(
      `no se pudo escribir ${archivo}: ${(e as Error).message}${fin.error ? ` (${fin.error.trim()})` : ""}`,
      { cause: e },
    );
  }
  const fin = await terminado;
  if (fin.codigo !== 0) {
    if (cmd.contenedor) await eliminarContenedor(cmd.contenedor);
    throw new Error(`el volcado de ${archivo} falló (código ${fin.codigo}): ${fin.error.trim()}`);
  }
  if (fin.error.trim()) log(`  aviso de ${archivo}: ${fin.error.trim()}`);
  if (claro.bytes === 0) throw new Error(`el volcado de ${archivo} salió vacío`);
  return { archivo, bytes: cifrado.bytes, bytesSinCifrar: claro.bytes, sha256: cifrado.sha256() };
}

/** Host y puerto con que esta herramienta llega al servidor. */
async function destinoCliente(s: ConfigServidor, config: Config): Promise<{ host: string; puerto: number }> {
  if (s.cliente) return s.cliente;
  if (config.modo === "docker" && s.contenedor)
    return { host: await ipContenedor(s.contenedor, config.docker.red), puerto: s.puerto };
  return { host: s.host, puerto: s.puerto };
}

async function conectarAdministracion(
  base: Omit<Parameters<typeof conectar>[0], "base">,
): Promise<pg.Client> {
  try {
    return await conectar({ ...base, base: "postgres" });
  } catch (e) {
    if ((e as { code?: string }).code !== "3D000") throw e;
    return conectar({ ...base, base: "template1" });
  }
}

async function respaldarServidor(
  s: ConfigServidor,
  config: Config,
  clave: Buffer,
  carpeta: string,
  log: Registro,
): Promise<ServidorRespaldado> {
  const claveBd = process.env[s.claveEnv];
  if (!claveBd)
    throw new Error(
      `falta la variable de entorno ${s.claveEnv} con la contraseña del servidor "${s.nombre}"`,
    );
  const destino = await destinoCliente(s, config);
  const conexion = {
    host: destino.host,
    puerto: destino.puerto,
    usuario: s.usuario,
    clave: claveBd,
    tls: s.tls,
    ...(s.ca ? { ca: s.ca } : {}),
  };

  const admin = await conectarAdministracion(conexion);
  let version: { version: string; num: number };
  let nombres: string[];
  const baseAdmin = admin.database ?? "postgres";
  try {
    version = await versionServidor(admin);
    const existentes = await listarBases(admin);
    if (s.bases === "todas") nombres = existentes;
    else {
      const faltan = s.bases.filter((b) => !existentes.includes(b));
      if (faltan.length)
        throw new Error(`el servidor "${s.nombre}" no tiene las bases: ${faltan.join(", ")}`);
      nombres = s.bases;
    }
    nombres = nombres.filter((b) => !s.excluir.includes(b));
  } finally {
    await admin.end();
  }
  log(`Servidor ${s.nombre} (PostgreSQL ${version.version}): ${nombres.join(", ")}`);

  let globales: ServidorRespaldado["globales"] = null;
  if (s.globales) {
    const t = performance.now();
    const instante = new Date().toISOString();
    const cmd = comandoPg("pg_dumpall", ["--globals-only", "--database", baseAdmin], s, config, claveBd);
    globales = {
      ...(await volcarCifrado(cmd, carpeta, `${s.nombre}/globales.sql.enc`, clave, config, log)),
      instante,
    };
    log(`  globales (roles): ${globales.bytes} bytes cifrados en ${ms(t)} ms`);
  }

  const bases: BaseRespaldada[] = [];
  for (const nombre of nombres) {
    const t = performance.now();
    const cliente = await conectar({ ...conexion, base: nombre });
    try {
      const snapshot = await exportarSnapshot(cliente);
      const tablas = await contarTablas(cliente, config.huellaContenido);
      const auditoria = await sondaAuditoria(cliente);
      const cmd = comandoPg(
        "pg_dump",
        ["--dbname", nombre, "--format=custom", `--snapshot=${snapshot.id}`, "--lock-wait-timeout=60s"],
        s,
        config,
        claveBd,
      );
      const artefacto = await volcarCifrado(
        cmd,
        carpeta,
        `${s.nombre}/${nombreArchivo(nombre)}.pgdump.enc`,
        clave,
        config,
        log,
      );
      await cliente.query("COMMIT");
      const totalFilas = tablas.reduce((n, x) => n + x.filas, 0);
      bases.push({
        nombre,
        ...artefacto,
        snapshot: snapshot.id,
        instanteSnapshot: snapshot.instante,
        lsn: snapshot.lsn,
        duracionMs: ms(t),
        tablas,
        totalFilas,
        sondas: auditoria ? { auditoria } : {},
      });
      const extra = auditoria
        ? `, auditoría: ${auditoria.eventos} eventos (último seq ${auditoria.ultimoSeq})`
        : "";
      log(
        `  ${nombre}: ${tablas.length} tablas, ${totalFilas} filas, ${artefacto.bytes} bytes cifrados en ${ms(t)} ms${extra}`,
      );
    } finally {
      await cliente.end().catch(() => undefined);
    }
  }
  return { nombre: s.nombre, versionPg: version.version, versionPgNum: version.num, globales, bases };
}

export async function respaldar(config: Config, log: Registro = console.log): Promise<ResultadoRespaldo> {
  const t0 = performance.now();
  const clave = await cargarClave(config, log, true);
  await mkdir(config.destino, { recursive: true, mode: 0o700 });
  const liberar = await tomarBloqueo(config.destino, log);
  try {
    await limpiarParciales(config.destino, log);
    const inicio = new Date();
    const id = idDeFecha(inicio);
    const carpeta = join(config.destino, id);
    if (existsSync(carpeta))
      throw new Error(`ya existe un respaldo ${id}; espere un segundo y vuelva a intentarlo`);
    const parcial = join(config.destino, `.${id}.parcial`);
    await mkdir(parcial, { mode: 0o700 });
    log(`Respaldo ${id} · modo ${config.modo} · destino ${config.destino}`);
    try {
      const versionDump = await versionPgDump(config);
      const servidores: ServidorRespaldado[] = [];
      for (const s of config.servidores)
        servidores.push(await respaldarServidor(s, config, clave, parcial, log));
      const manifiesto = construirManifiesto(
        {
          id,
          herramienta: versionHerramienta(),
          modo: config.modo,
          inicio: inicio.toISOString(),
          fin: new Date().toISOString(),
          duracionMs: ms(t0),
          versionPgDump: versionDump,
          huellaContenido: config.huellaContenido,
          cifrado: { tamanoBloque: config.tamanoBloque, huellaClave: huellaClave(clave) },
          servidores,
        },
        clave,
      );
      await writeFile(join(parcial, ARCHIVO_MANIFIESTO), `${JSON.stringify(manifiesto, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(parcial, carpeta);
      const retencion = await aplicarRetencion(config, new Date(), log);
      return { manifiesto, carpeta, retencion };
    } catch (e) {
      await rm(parcial, { recursive: true, force: true });
      throw e;
    }
  } finally {
    await liberar();
  }
}
