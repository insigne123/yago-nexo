// Prueba de restauración verificada (BT-058): toma un respaldo, verifica la firma del manifiesto y
// el SHA-256 de cada archivo, lo descifra al vuelo hacia un PostgreSQL temporal en Docker, restaura
// roles y bases, y compara cada tabla con lo contado dentro del snapshot del respaldo. Mide el RTO
// y deja un informe. El contenedor temporal se elimina siempre, también si algo falla.
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as esperar } from "node:timers/promises";
import { AuditStore, createPool } from "@nexo/console-db";
import { cargarClave, listarRespaldos, MARCA_EN_PRUEBA, type Registro } from "./almacen.js";
import { crearDescifrador, huellaClave, sha256Archivo } from "./cifrado.js";
import { compararAuditoria, compararTablas, type VerificacionCadena } from "./comparacion.js";
import { versionHerramienta, type Config } from "./config.js";
import { ejecutar, ejecutarOk, eliminarContenedor, ipContenedor, sufijo } from "./ejecucion.js";
import {
  calcularTotalesInforme,
  FORMATO_INFORME,
  informeMarkdown,
  tamano,
  segundos,
  type InformeRestauracion,
  type InformeServidor,
} from "./informe.js";
import {
  ARCHIVO_MANIFIESTO,
  artefactos,
  fechaDeId,
  verificarManifiesto,
  type Manifiesto,
  type ServidorRespaldado,
} from "./manifiesto.js";
import { conectar, contarTablas, sondaAuditoria } from "./postgres.js";

/** Superusuario del servidor temporal: distinto de cualquier rol del origen, para que los roles restaurados no choquen. */
const USUARIO_PRUEBA = "nexo_respaldo_prueba";
const RUTA_VOLCADO = "/var/lib/postgresql/restaurar.pgdump";

const ms = (desde: number) => Math.round(performance.now() - desde);

function descifrado(ruta: string, clave: Buffer): Readable {
  const lector = createReadStream(ruta);
  const descifrador = crearDescifrador(clave);
  lector.on("error", (e) => descifrador.destroy(e));
  return lector.pipe(descifrador);
}

async function esperarListo(
  contenedor: string,
  segundosMax: number,
  cancelado: { valor: boolean },
): Promise<void> {
  const limite = Date.now() + segundosMax * 1000;
  // Por TCP: durante la inicialización la imagen levanta un servidor provisorio solo en el socket local.
  while (Date.now() < limite) {
    if (cancelado.valor) throw new Error("prueba interrumpida");
    const r = await ejecutar("docker", [
      "exec",
      contenedor,
      "pg_isready",
      "-q",
      "-h",
      "127.0.0.1",
      "-U",
      USUARIO_PRUEBA,
      "-d",
      "postgres",
    ]);
    if (r.codigo === 0) return;
    if (/No such container|is not running/i.test(r.error)) {
      const logs = await ejecutar("docker", ["logs", "--tail", "20", contenedor]);
      throw new Error(
        `el PostgreSQL temporal se detuvo al iniciar: ${(logs.error || logs.salida || r.error).trim()}`,
      );
    }
    await esperar(300);
  }
  throw new Error(`el PostgreSQL temporal no quedó listo en ${segundosMax} s`);
}

async function verificarCadena(url: string): Promise<VerificacionCadena> {
  // La misma verificación que usa la Consola: secuencia continua y cada hash recalculado.
  const pool = createPool(url);
  try {
    return (await new AuditStore(pool).verify()) as VerificacionCadena;
  } finally {
    await pool.end();
  }
}

interface Contexto {
  config: Config;
  clave: Buffer;
  carpeta: string;
  manifiesto: Manifiesto;
  contenedores: Set<string>;
  /** Se marca al recibir SIGINT/SIGTERM: no se lanza nada nuevo y se limpia antes de salir. */
  cancelado: { valor: boolean };
  log: Registro;
  avisos: string[];
}

/** Restaura un servidor del manifiesto en su propio contenedor temporal. Devuelve el informe y el tiempo que cuenta para el RTO. */
async function probarServidor(
  s: ServidorRespaldado,
  ctx: Contexto,
): Promise<{ informe: InformeServidor; rtoMs: number }> {
  const { config, clave, carpeta, log } = ctx;
  const contenedor = `nexo-respaldo-prueba-${s.nombre}-${sufijo()}`;
  const informe: InformeServidor = {
    nombre: s.nombre,
    versionOrigen: s.versionPg,
    versionPrueba: null,
    contenedor,
    arranqueMs: 0,
    globales: null,
    bases: s.bases.map((b) => ({
      nombre: b.nombre,
      bytes: b.bytes,
      restauracionMs: 0,
      comparacion: null,
      auditoria: null,
      ok: false,
    })),
    ok: false,
  };
  let rtoMs = 0;
  const clavePrueba = randomBytes(24).toString("hex");
  try {
    // ---------------------------------------------------------------- servidor temporal (sin puertos publicados)
    const seguir = () => {
      if (ctx.cancelado.valor) throw new Error("prueba interrumpida");
    };
    let t = performance.now();
    seguir();
    ctx.contenedores.add(contenedor);
    await ejecutarOk(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        contenedor,
        "--label",
        "nexo-respaldo=prueba",
        "--shm-size",
        "256m",
        "-e",
        `POSTGRES_USER=${USUARIO_PRUEBA}`,
        "-e",
        "POSTGRES_PASSWORD",
        "-e",
        "POSTGRES_DB=postgres",
        config.restauracion.imagen,
      ],
      { env: { ...process.env, POSTGRES_PASSWORD: clavePrueba }, que: "docker run (servidor temporal)" },
    );
    await esperarListo(contenedor, config.restauracion.esperaListoSeg, ctx.cancelado);
    informe.arranqueMs = ms(t);
    rtoMs += informe.arranqueMs;
    const psql = ["exec", contenedor, "psql", "-X", "-At", "-U", USUARIO_PRUEBA, "-d", "postgres", "-c"];
    const num = Number((await ejecutarOk("docker", [...psql, "SHOW server_version_num"])).trim());
    informe.versionPrueba = (await ejecutarOk("docker", [...psql, "SHOW server_version"])).trim();
    if (Math.floor(num / 10000) < Math.floor(s.versionPgNum / 10000)) {
      throw new Error(
        `la imagen ${config.restauracion.imagen} trae PostgreSQL ${informe.versionPrueba}, anterior al origen (${s.versionPg})`,
      );
    }
    if (Math.floor(num / 10000) !== Math.floor(s.versionPgNum / 10000)) {
      ctx.avisos.push(
        `${s.nombre}: se prueba con PostgreSQL ${informe.versionPrueba} y el origen es ${s.versionPg} (versión mayor distinta)`,
      );
    }
    log(
      `Servidor ${s.nombre}: PostgreSQL temporal ${informe.versionPrueba} listo en ${segundos(informe.arranqueMs)} (${contenedor})`,
    );

    // ---------------------------------------------------------------- roles y objetos globales
    if (s.globales) {
      seguir();
      t = performance.now();
      await ejecutarOk(
        "docker",
        [
          "exec",
          "-i",
          contenedor,
          "psql",
          "-X",
          "-q",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          USUARIO_PRUEBA,
          "-d",
          "postgres",
          "-f",
          "-",
        ],
        {
          entrada: descifrado(join(carpeta, s.globales.archivo), clave),
          que: `restauración de los globales de ${s.nombre}`,
        },
      );
      informe.globales = { ok: true, ms: ms(t) };
      rtoMs += informe.globales.ms;
      log(`  globales restaurados en ${segundos(informe.globales.ms)}`);
    }

    // ---------------------------------------------------------------- bases
    for (const [i, b] of s.bases.entries()) {
      const ib = informe.bases[i]!;
      seguir();
      t = performance.now();
      // El volcado descifrado se copia dentro del contenedor (desaparece con él): pg_restore necesita
      // un archivo con acceso aleatorio para restaurar en paralelo.
      await ejecutarOk("docker", ["exec", "-i", contenedor, "sh", "-c", 'cat > "$1"', "sh", RUTA_VOLCADO], {
        entrada: descifrado(join(carpeta, b.archivo), clave),
        que: `copia de ${b.nombre} al servidor temporal`,
      });
      // La base "postgres" ya existe en el servidor temporal: se restaura dentro de ella.
      const crear = b.nombre === "postgres" ? [] : ["--create"];
      await ejecutarOk(
        "docker",
        [
          "exec",
          contenedor,
          "pg_restore",
          "-U",
          USUARIO_PRUEBA,
          "--exit-on-error",
          "--jobs",
          String(config.restauracion.trabajos),
          ...crear,
          "--dbname",
          "postgres",
          RUTA_VOLCADO,
        ],
        { que: `pg_restore de ${b.nombre}` },
      );
      await ejecutarOk("docker", ["exec", contenedor, "rm", "-f", RUTA_VOLCADO]);
      ib.restauracionMs = ms(t);
      rtoMs += ib.restauracionMs;
      log(`  ${b.nombre}: restaurada en ${segundos(ib.restauracionMs)} (${tamano(b.bytes)} cifrados)`);
    }

    // ---------------------------------------------------------------- comparación (fuera del RTO)
    seguir();
    const ip = await ipContenedor(contenedor);
    for (const [i, b] of s.bases.entries()) {
      const ib = informe.bases[i]!;
      try {
        const cliente = await conectar({
          host: ip,
          puerto: 5432,
          usuario: USUARIO_PRUEBA,
          clave: clavePrueba,
          base: b.nombre,
        });
        try {
          await cliente.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          const tablas = await contarTablas(cliente, ctx.manifiesto.huellaContenido);
          const auditoria = b.sondas.auditoria ? await sondaAuditoria(cliente) : undefined;
          await cliente.query("COMMIT");
          ib.comparacion = compararTablas(b.tablas, tablas);
          if (b.sondas.auditoria) {
            const url = `postgresql://${USUARIO_PRUEBA}:${clavePrueba}@${ip}:5432/${encodeURIComponent(b.nombre)}`;
            const cadena = await verificarCadena(url);
            ib.auditoria = compararAuditoria(
              b.sondas.auditoria,
              auditoria ?? { eventos: 0, ultimoSeq: null, ultimoHash: null },
              cadena,
            );
          }
        } finally {
          await cliente.end().catch(() => undefined);
        }
        ib.ok = ib.comparacion.ok && (ib.auditoria?.ok ?? true);
        const c = ib.comparacion;
        log(
          `  ${b.nombre}: ${c.tablasComparadas}/${b.tablas.length} tablas, ${c.filasObtenidas}/${c.filasEsperadas} filas` +
            `${ib.auditoria ? `, auditoría ${ib.auditoria.ok ? "íntegra y coincidente" : "CON PROBLEMAS"}` : ""} → ${ib.ok ? "ok" : `FALLA (${c.diferencias.length} diferencias)`}`,
        );
      } catch (e) {
        ib.error = (e as Error).message;
        log(`  ${b.nombre}: ERROR al comparar: ${ib.error}`);
      }
    }
    informe.ok = informe.bases.every((b) => b.ok);
  } catch (e) {
    informe.error = (e as Error).message;
    log(`  ERROR: ${informe.error}`);
  } finally {
    await eliminarContenedor(contenedor);
    ctx.contenedores.delete(contenedor);
  }
  return { informe, rtoMs };
}

export interface OpcionesRestauracion {
  /** Id del respaldo; por omisión, el más reciente. */
  respaldo?: string;
}

export async function restaurar(
  config: Config,
  opciones: OpcionesRestauracion = {},
  log: Registro = console.log,
): Promise<{ informe: InformeRestauracion; carpeta: string }> {
  const t0 = performance.now();
  const inicio = new Date();
  const clave = await cargarClave(config, log, false);
  const id = opciones.respaldo ?? (await listarRespaldos(config.destino))[0]?.id;
  if (!id) throw new Error(`no hay respaldos completos en ${config.destino}`);
  if (!fechaDeId(id)) throw new Error(`"${id}" no es un id de respaldo (formato AAAAMMDDTHHMMSSZ)`);
  const carpeta = join(config.destino, id);
  if (!existsSync(join(carpeta, ARCHIVO_MANIFIESTO)))
    throw new Error(`no existe el respaldo ${id} en ${config.destino}`);

  const informe: InformeRestauracion = {
    formato: FORMATO_INFORME,
    respaldo: id,
    instanteRespaldo: fechaDeId(id)?.toISOString() ?? null,
    herramienta: versionHerramienta(),
    imagen: config.restauracion.imagen,
    inicio: inicio.toISOString(),
    fin: "",
    resultado: "fallida",
    interrumpida: false,
    rtoMedidoMs: 0,
    duracionTotalMs: 0,
    objetivos: config.objetivos,
    antiguedadRespaldoHoras: null,
    archivos: { verificados: 0, bytes: 0, ms: 0, ok: false },
    servidores: [],
    totales: { bases: 0, tablasComparadas: 0, filasComparadas: 0, diferencias: 0 },
    errores: [],
    avisos: [],
  };
  const ctxContenedores = new Set<string>();
  const cancelado = { valor: false };
  // Se cancela de forma cooperativa: se eliminan los contenedores en curso (eso corta la restauración),
  // el flujo principal deja de lanzar trabajo nuevo, sus bloques finally limpian y se escribe el informe.
  // Si algo quedara colgado, se sale igual a los 30 s. Un segundo Ctrl-C termina sin esperar.
  const alInterrumpir = (senal: NodeJS.Signals) => {
    if (cancelado.valor) {
      log("Segunda interrupción: se sale sin esperar.");
      void Promise.all([...ctxContenedores].map(eliminarContenedor)).finally(() => process.exit(130));
      return;
    }
    cancelado.valor = true;
    informe.interrumpida = true;
    informe.errores.push(`prueba interrumpida (${senal})`);
    log(`Interrumpido (${senal}): eliminando contenedores temporales…`);
    void Promise.all([...ctxContenedores].map(eliminarContenedor));
    setTimeout(() => process.exit(130), 30_000).unref();
  };
  process.on("SIGINT", alInterrumpir);
  process.on("SIGTERM", alInterrumpir);
  const marca = join(carpeta, MARCA_EN_PRUEBA);
  await writeFile(marca, String(process.pid), { mode: 0o600 });
  log(`Prueba de restauración del respaldo ${id}`);
  try {
    // ---------------------------------------------------------------- manifiesto y archivos
    const t = performance.now();
    const manifiesto = verificarManifiesto(
      JSON.parse(await readFile(join(carpeta, ARCHIVO_MANIFIESTO), "utf8")),
      clave,
      huellaClave(clave),
    );
    informe.instanteRespaldo = manifiesto.inicio;
    informe.antiguedadRespaldoHoras = (inicio.getTime() - new Date(manifiesto.inicio).getTime()) / 3_600_000;
    for (const a of artefactos(manifiesto)) {
      const ruta = join(carpeta, a.archivo);
      if (!existsSync(ruta)) {
        informe.errores.push(`falta el archivo ${a.archivo}`);
        continue;
      }
      const real = await sha256Archivo(ruta);
      informe.archivos.verificados++;
      informe.archivos.bytes += real.bytes;
      if (real.sha256 !== a.sha256 || real.bytes !== a.bytes)
        informe.errores.push(`${a.archivo}: el SHA-256 o el tamaño no coinciden con el manifiesto`);
    }
    informe.archivos.ms = ms(t);
    informe.archivos.ok = informe.errores.length === 0;
    informe.rtoMedidoMs += informe.archivos.ms;
    log(
      `Manifiesto firmado y ${informe.archivos.verificados} archivos verificados (${tamano(informe.archivos.bytes)}) en ${segundos(informe.archivos.ms)}`,
    );

    // ---------------------------------------------------------------- restauración por servidor
    if (informe.archivos.ok) {
      const ctx: Contexto = {
        config,
        clave,
        carpeta,
        manifiesto,
        contenedores: ctxContenedores,
        cancelado,
        log,
        avisos: informe.avisos,
      };
      for (const s of manifiesto.servidores) {
        if (cancelado.valor) break;
        const r = await probarServidor(s, ctx);
        informe.servidores.push(r.informe);
        informe.rtoMedidoMs += r.rtoMs;
        if (r.informe.error) informe.errores.push(`servidor ${s.nombre}: ${r.informe.error}`);
        for (const b of r.informe.bases)
          if (b.error) informe.errores.push(`${s.nombre}/${b.nombre}: ${b.error}`);
      }
    }
  } catch (e) {
    informe.errores.push((e as Error).message);
  } finally {
    await Promise.all([...ctxContenedores].map(eliminarContenedor));
    process.removeListener("SIGINT", alInterrumpir);
    process.removeListener("SIGTERM", alInterrumpir);
    await unlink(marca).catch(() => undefined);
  }

  informe.totales = calcularTotalesInforme(informe.servidores);
  const { rtoMinutos, rpoHoras } = config.objetivos;
  if (rtoMinutos !== null && informe.rtoMedidoMs > rtoMinutos * 60_000) {
    informe.errores.push(
      `el RTO medido (${segundos(informe.rtoMedidoMs)}) supera el objetivo de ${rtoMinutos} min`,
    );
  }
  if (
    rpoHoras !== null &&
    informe.antiguedadRespaldoHoras !== null &&
    informe.antiguedadRespaldoHoras > rpoHoras
  ) {
    informe.avisos.push(
      `el respaldo probado tiene ${informe.antiguedadRespaldoHoras.toFixed(1)} h; con respaldos más espaciados que ${rpoHoras} h no se cumple el RPO objetivo`,
    );
  }
  const exitosa =
    informe.errores.length === 0 &&
    informe.archivos.ok &&
    informe.servidores.length > 0 &&
    informe.servidores.every((s) => s.ok);
  informe.resultado = exitosa ? "exitosa" : "fallida";
  informe.fin = new Date().toISOString();
  informe.duracionTotalMs = ms(t0);
  await writeFile(join(carpeta, "informe-restauracion.json"), `${JSON.stringify(informe, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeFile(join(carpeta, "informe-restauracion.md"), informeMarkdown(informe), { mode: 0o600 });
  return { informe, carpeta };
}
