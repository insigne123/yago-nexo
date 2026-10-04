// Informe de la prueba de restauración (JSON para máquinas, Markdown para personas).
import type { ResultadoComparacion, ResultadoSondaAuditoria } from "./comparacion.js";

export const FORMATO_INFORME = "nexo-respaldo-informe/1";

export interface InformeBase {
  nombre: string;
  bytes: number;
  restauracionMs: number;
  comparacion: ResultadoComparacion | null;
  auditoria: ResultadoSondaAuditoria | null;
  ok: boolean;
  error?: string;
}

export interface InformeServidor {
  nombre: string;
  versionOrigen: string;
  versionPrueba: string | null;
  contenedor: string;
  arranqueMs: number;
  globales: { ok: boolean; ms: number } | null;
  bases: InformeBase[];
  ok: boolean;
  error?: string;
}

export interface InformeRestauracion {
  formato: typeof FORMATO_INFORME;
  respaldo: string;
  instanteRespaldo: string | null;
  herramienta: { nombre: string; version: string };
  imagen: string;
  inicio: string;
  fin: string;
  resultado: "exitosa" | "fallida";
  interrumpida: boolean;
  /** Verificación de archivos + arranque del servidor + restauración (sin la comparación posterior). */
  rtoMedidoMs: number;
  duracionTotalMs: number;
  objetivos: { rtoMinutos: number | null; rpoHoras: number | null };
  antiguedadRespaldoHoras: number | null;
  archivos: { verificados: number; bytes: number; ms: number; ok: boolean };
  servidores: InformeServidor[];
  totales: { bases: number; tablasComparadas: number; filasComparadas: number; diferencias: number };
  errores: string[];
  avisos: string[];
}

export function calcularTotalesInforme(
  servidores: readonly InformeServidor[],
): InformeRestauracion["totales"] {
  let bases = 0;
  let tablasComparadas = 0;
  let filasComparadas = 0;
  let diferencias = 0;
  for (const s of servidores) {
    for (const b of s.bases) {
      if (!b.comparacion) continue;
      bases++;
      tablasComparadas += b.comparacion?.tablasComparadas ?? 0;
      filasComparadas += b.comparacion?.filasObtenidas ?? 0;
      diferencias += b.comparacion?.diferencias.length ?? 0;
    }
  }
  return { bases, tablasComparadas, filasComparadas, diferencias };
}

export function segundos(msTotal: number): string {
  return `${(msTotal / 1000).toFixed(1).replace(".", ",")} s`;
}

export function tamano(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2).replace(".", ",")} MiB`;
}

const celda = (t: string) => t.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function informeMarkdown(i: InformeRestauracion): string {
  const l: string[] = [];
  l.push(`# Prueba de restauración del respaldo ${i.respaldo}`, "");
  l.push(`- **Resultado:** ${i.resultado === "exitosa" ? "EXITOSA" : "FALLIDA"}`);
  l.push(`- **Fecha de la prueba:** ${i.inicio}`);
  if (i.instanteRespaldo)
    l.push(
      `- **Respaldo tomado:** ${i.instanteRespaldo}${i.antiguedadRespaldoHoras !== null ? ` (${i.antiguedadRespaldoHoras.toFixed(1).replace(".", ",")} h antes de la prueba)` : ""}`,
    );
  const objetivoRto =
    i.objetivos.rtoMinutos !== null
      ? ` · objetivo ${i.objetivos.rtoMinutos} min (${i.rtoMedidoMs <= i.objetivos.rtoMinutos * 60_000 ? "cumple" : "NO cumple"})`
      : "";
  l.push(`- **RTO medido:** ${segundos(i.rtoMedidoMs)}${objetivoRto}`);
  l.push(`- **Duración total (con la comparación):** ${segundos(i.duracionTotalMs)}`);
  l.push(
    `- **Archivos verificados (SHA-256 y firma del manifiesto):** ${i.archivos.verificados}, ${tamano(i.archivos.bytes)}`,
  );
  l.push(
    `- **Comparación:** ${i.totales.bases} bases restauradas y comparadas, ${i.totales.tablasComparadas} tablas, ${i.totales.filasComparadas} filas, ${i.totales.diferencias} diferencias`,
  );
  l.push(`- **Servidor temporal:** imagen \`${i.imagen}\`, eliminado al terminar`);
  l.push(`- **Herramienta:** ${i.herramienta.nombre} ${i.herramienta.version}`, "");

  for (const s of i.servidores) {
    l.push(`## Servidor ${s.nombre}`, "");
    l.push(
      `PostgreSQL ${s.versionOrigen} en el origen, ${s.versionPrueba ?? "?"} en la prueba. Arranque del servidor temporal: ${segundos(s.arranqueMs)}.`,
    );
    if (s.globales)
      l.push(
        `Roles y objetos globales: ${s.globales.ok ? "restaurados" : "con error"} en ${segundos(s.globales.ms)}.`,
      );
    if (s.error) l.push("", `**Error:** ${s.error}`);
    l.push(
      "",
      "| Base | Tamaño cifrado | Restauración | Tablas | Filas | Diferencias | Resultado |",
      "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    );
    for (const b of s.bases) {
      const c = b.comparacion;
      l.push(
        `| ${celda(b.nombre)} | ${tamano(b.bytes)} | ${segundos(b.restauracionMs)} | ${c?.tablasComparadas ?? "—"} | ${c?.filasObtenidas ?? "—"} | ${c?.diferencias.length ?? "—"} | ${b.ok ? "ok" : "FALLA"} |`,
      );
    }
    for (const b of s.bases) {
      if (b.auditoria) {
        const a = b.auditoria;
        l.push(
          "",
          `Cadena de auditoría en \`${b.nombre}\`: ${a.obtenido.eventos} eventos, último seq ${a.obtenido.ultimoSeq ?? "—"}, ` +
            `último hash \`${a.obtenido.ultimoHash?.slice(0, 16) ?? "—"}…\`; verificación completa: ${a.cadena?.ok ? "íntegra" : "con problemas"}. ${a.ok ? "Coincide con el respaldo." : "NO coincide con el respaldo."}`,
        );
        for (const p of a.problemas) l.push(`- ${p}`);
      }
      if (b.error) l.push("", `**${b.nombre}:** ${b.error}`);
      const dif = b.comparacion?.diferencias ?? [];
      if (dif.length) {
        l.push("", `Diferencias en \`${b.nombre}\`:`, "");
        for (const d of dif.slice(0, 50)) l.push(`- \`${d.tabla}\` (${d.tipo}): ${d.detalle}`);
        if (dif.length > 50) l.push(`- … y ${dif.length - 50} más (ver el JSON)`);
      }
    }
    l.push("");
  }
  if (i.errores.length) l.push("## Errores", "", ...i.errores.map((e) => `- ${e}`), "");
  if (i.avisos.length) l.push("## Avisos", "", ...i.avisos.map((a) => `- ${a}`), "");
  return `${l.join("\n").trimEnd()}\n`;
}
