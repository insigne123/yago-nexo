/**
 * BT-049 · Exportación de APIs, contratos, políticas, configuraciones, metadatos y datos de gestión en formatos
 * documentados. La administradora genera el paquete desde la Consola; se verifica el SHA-256 de cada artefacto
 * contra el manifiesto y se leen todos con herramientas estándar (Python: zipfile, YAML, XML, JSON), sin
 * software del proveedor.
 *
 * Veracidad (V12, 0-11 e): la configuración de la plataforma (platform.yaml) se busca DENTRO del paquete
 * exportado; si el paquete no la trae, la verificación falla (ya no se lee desde el repositorio). Los datos de
 * gestión (auditoría y consumo) no van en el paquete: se exportan aparte por la API de la Consola y así se dice.
 *
 * Duración estimada: portada 4 s + 5 pasos (≈ 16 + 12 + 20 + 14 + 12 s) + cierre 3 s ≈ 90 s (tope 240 s).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import type { DefinicionPaso, Demo } from "../lib/grabador.js";
import { escaparHtml } from "../lib/grabador.js";
import { CONSOLA_API, tokenPersona } from "../lib/lab.js";
import { prepararEnsayo } from "./bt0x-ensayo.js";

export const DURACION_ESTIMADA_S = 90;

type Manifiesto = { version: string; generadoEn: string; origen: string; items: Array<{ tipo: string; nombre: string; archivo: string; sha256: string }> };

/** Busca la configuración de la plataforma dentro del paquete (cualquier ruta que termine en platform.yaml). */
export function configuracionEnPaquete(archivos: string[]): string | undefined {
  return archivos.find((f) => /(^|\/)platform\.ya?ml$/.test(f));
}

/** Lector independiente (Python estándar + PyYAML) para mostrar que los artefactos no dependen de Nexo ni de WSO2. */
export const LECTOR = `import json, sys, zipfile, xml.etree.ElementTree as ET, yaml
base = sys.argv[1]
man = json.load(open(base + "/manifiesto.json"))
for it in man["items"]:
    ruta = base + "/" + it["archivo"]
    if ruta.endswith(".zip"):
        z = zipfile.ZipFile(ruta)
        for n in z.namelist():
            corto = n.split('/', 1)[-1]
            if n.endswith((".graphql", ".gql")):
                texto = z.read(n).decode()
                print(f"zip  {it['archivo']}: {corto} → esquema GraphQL · {texto.count('type ')} tipos")
                continue
            if not n.endswith((".yaml", ".yml", ".json")):
                print(f"zip  {it['archivo']}: {corto} · {len(z.read(n))} bytes")
                continue
            d = yaml.safe_load(z.read(n)) or {}
            if n.split("/")[-1] == "api.yaml":
                x = d.get("data", d)
                print(f"zip  {it['archivo']}: {corto} → {x.get('name')} {x.get('version')} · contexto {x.get('context')} · planes {','.join(x.get('policies') or [])}")
            elif isinstance(d, dict):
                clave = "openapi" if "openapi" in d else ("asyncapi" if "asyncapi" in d else "swagger")
                print(f"zip  {it['archivo']}: {corto} → {clave} {d.get(clave, '')} · {len(d.get('paths') or d.get('channels') or {})} rutas")
    elif ruta.endswith(".xml"):
        r = ET.parse(ruta).getroot()
        print(f"xml  {it['archivo']}: <{r.tag.split('}')[-1]} name={r.get('name')}> · {sum(1 for _ in r.iter())} elementos")
    elif ruta.endswith((".yaml", ".yml")):
        d = yaml.safe_load(open(ruta)) or {}
        partes = []
        for k, v in d.items():
            partes.append(f"{k}: {len(v) if isinstance(v, (list, dict)) else v}")
        print(f"yaml {it['archivo']}: " + " · ".join(partes))
    elif ruta.endswith(".json"):
        d = json.load(open(ruta))
        print(f"json {it['archivo']}: {len(d) if isinstance(d, list) else ', '.join(f'{k}: {len(v)}' for k, v in d.items() if isinstance(v, (list, dict)))} registros")
`;

/** Resumen de platform.yaml (ambientes, planes, flujos de aprobación y gobierno), tolerante a campos ausentes. */
const RESUMEN_PLATAFORMA = [
  "import yaml,sys",
  "d=yaml.safe_load(open(sys.argv[1])) or {}",
  "nom=lambda xs: ', '.join(str(x.get('name')) for x in (xs or []) if isinstance(x, dict))",
  "print('ambientes del gateway:', nom(d.get('gatewayEnvironments')))",
  "print('planes de suscripción:', nom((d.get('throttling') or {}).get('subscription')))",
  "print('flujos de aprobación:', (d.get('workflows') or {}).get('file', '—'))",
  "print('reglas de gobierno:', nom((d.get('governance') or {}).get('policies')))",
].join("\n");

export const NARRACION_BT049: DefinicionPaso[] = [
  {
    titulo: "La administradora genera el paquete de exportación",
    quePasa: "La administradora pide y descarga un paquete de exportación en la Consola. Trae APIs, flujos, metadatos, configuración y un manifiesto.",
    porQueImporta: "La institución puede llevarse sus APIs y su configuración cuando quiera, sin depender del proveedor.",
    comprueba: ["paquete con manifiesto"],
  },
  {
    titulo: "El manifiesto: una suma SHA-256 por artefacto",
    quePasa: "Para cada artefacto se recalcula su suma SHA-256 y se compara con la que declara el manifiesto.",
    porQueImporta: "Así se demuestra que el paquete está completo y no se alteró después de generarse.",
    comprueba: ["sumas SHA-256 del manifiesto", "incluye APIs (contrato y políticas), flujos y metadatos"],
  },
  {
    titulo: "Se leen con herramientas estándar",
    quePasa: "Un programa de Python con bibliotecas estándar abre cada artefacto (ZIP, YAML, XML, JSON). Al lado, el contrato OpenAPI del paquete.",
    porQueImporta: "Los formatos son abiertos y documentados: se pueden leer y migrar sin software de Yago Nexo ni de WSO2.",
    comprueba: ["todos los artefactos se leen con herramientas estándar"],
  },
  {
    titulo: "Configuración de la plataforma dentro del paquete",
    quePasa: "Se busca en el paquete la configuración de la plataforma como código (platform.yaml) y se lee: ambientes, planes, aprobaciones y gobierno.",
    porQueImporta: "No solo se exportan las APIs: también la configuración que las hace funcionar, para reconstruir el entorno.",
    comprueba: ["el paquete incluye platform.yaml", "configuración de la plataforma legible (YAML)"],
  },
  {
    titulo: "Datos de gestión: auditoría y consumo, aparte",
    quePasa: "Los datos de gestión salen aparte, por la API de la Consola: la auditoría en JSON con su cadena de hashes verificada y el consumo en CSV.",
    porQueImporta: "La historia de quién hizo qué y cuánto se usó también es de la institución y sale en formatos abiertos.",
    comprueba: ["auditoría exportable y verificable", "consumo exportable en CSV"],
  },
];

export const bt049: Demo = {
  id: "BT-049",
  archivo: "BT-049_exportacion",
  nombre: "Exportación de APIs, contratos, políticas, configuración y metadatos",
  afirmacion:
    "La Consola genera un paquete de exportación con las APIs (contrato y políticas), los flujos de integración, el catálogo, el grafo de dependencias y la configuración de la plataforma, con un manifiesto de sumas SHA-256; los datos de gestión (auditoría y consumo) se exportan aparte por su API; todo se lee con herramientas estándar.",
  pasos: NARRACION_BT049.length,
  agenda: NARRACION_BT049.map((p) => p.titulo),
  usuarioInicial: "admin.nexo",

  async preparar(c) {
    await prepararEnsayo(c);
  },

  async ejecutar(c) {
    const e = c.estudio;
    const adm = await tokenPersona("admin.nexo");
    const auditor = await tokenPersona("pedro.auditoria");

    // 1 ── Generación del paquete ────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT049[0]!);
    await c.vista("dividido");
    await c.ir("/exportacion");
    await e.clic(c.app.getByTestId("btn-create-export"));
    await c.app.getByTestId("btn-download-export").waitFor({ timeout: 60_000 });
    const zipRuta = await c.descargar(c.app.getByTestId("btn-download-export"), "nexo-export.zip");
    const zip = unzipSync(new Uint8Array(readFileSync(zipRuta)));
    const dir = join(c.archivos, "export");
    for (const [f, data] of Object.entries(zip)) {
      if (f.endsWith("/")) continue;
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), data);
    }
    c.log(`contenido de nexo-export.zip (${(readFileSync(zipRuta).length / 1024).toFixed(0)} KB, leído con la biblioteca zip del guion):`, "cmd");
    for (const f of Object.keys(zip).sort()) c.log(`  ${String(zip[f]!.length).padStart(7)}  ${f}`);
    const man = (zip["manifiesto.json"] ? JSON.parse(strFromU8(zip["manifiesto.json"])) : { items: [] }) as Manifiesto;
    e.indicadores({ artefactos: man.items.length, "tamaño": `${(readFileSync(zipRuta).length / 1024).toFixed(0)} KB` });
    e.exige("paquete con manifiesto", man.items.length > 0, `${man.items.length} artefactos · versión ${man.version ?? "?"}`);

    // 2 ── Manifiesto ────────────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT049[1]!);
    let iguales = 0;
    for (const it of man.items) {
      const h = createHash("sha256").update(zip[it.archivo] ?? new Uint8Array()).digest("hex");
      const ok = h === it.sha256;
      if (ok) iguales++;
      c.log(`${ok ? "✓" : "✗"} ${h.slice(0, 16)}…  ${it.tipo.padEnd(13)} ${it.archivo}`, ok ? "ok" : "mal");
    }
    e.indicadores({ artefactos: man.items.length, "SHA-256 iguales": iguales });
    e.comprueba("sumas SHA-256 del manifiesto", iguales === man.items.length, `${iguales} de ${man.items.length}`);
    const tipos = new Set(man.items.map((i) => i.tipo));
    e.comprueba("incluye APIs (contrato y políticas), flujos y metadatos", ["api", "flujo", "metadatos"].every((t) => tipos.has(t)), [...tipos].join(", "));

    // 3 ── Lectura con herramientas estándar ─────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT049[2]!);
    writeFileSync(join(c.archivos, "leer_exportacion.py"), LECTOR);
    await c.vista("terminal");
    const lectura = await c.ejecutarComando("python3", [join(c.archivos, "leer_exportacion.py"), dir], { mostrar: "python3 leer_exportacion.py export/", tablas: false });
    e.comprueba("todos los artefactos se leen con herramientas estándar", lectura.codigo === 0 && lectura.salida.length >= man.items.length, `${lectura.salida.length} lecturas · código ${lectura.codigo}`);
    const concesiones = Object.keys(zip).find((f) => f.startsWith("apis/Concesiones-"));
    const interno = concesiones ? unzipSync(zip[concesiones]!) : {};
    const swagger = Object.entries(interno).find(([n]) => /swagger\.ya?ml$|openapi\.ya?ml$/.test(n));
    if (swagger) {
      c.panel(
        `<h3>${escaparHtml(concesiones!)} → ${escaparHtml(swagger[0])}</h3><pre style="font-size:11.5px;line-height:1.35;white-space:pre-wrap;color:#cfe3ff">${escaparHtml(strFromU8(swagger[1]).split("\n").slice(0, 34).join("\n"))}</pre>`,
      );
      await c.vista("terminal-panel");
      await e.esperar(4000);
    }

    // 4 ── Configuración de la plataforma, dentro del paquete ───────────────────────────────────────
    await e.paso(NARRACION_BT049[3]!);
    await c.vista("terminal");
    const plataforma = configuracionEnPaquete(Object.keys(zip));
    c.log(`busca platform.yaml dentro de nexo-export.zip → ${plataforma ?? "no está en el paquete"}`, plataforma ? "cmd" : "mal");
    e.comprueba("el paquete incluye platform.yaml", !!plataforma, plataforma ?? "falta en el paquete");
    if (plataforma) {
      const py = await c.ejecutarComando("python3", ["-c", RESUMEN_PLATAFORMA, join(dir, plataforma)], { mostrar: `python3 -c 'yaml.safe_load(open("export/${plataforma}"))'`, tablas: false });
      const texto = strFromU8(zip[plataforma]!);
      e.comprueba("configuración de la plataforma legible (YAML)", py.codigo === 0 && /throttling/.test(texto), `export/${plataforma}`);
    }
    await e.esperar(2000);

    // 5 ── Datos de gestión, por la API ──────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT049[4]!);
    await c.vista("dividido");
    const aud = await fetch(`${CONSOLA_API}/audit-events?limit=1000`, { headers: { authorization: `Bearer ${auditor}` } });
    const eventos = (await aud.json().catch(() => [])) as Array<{ seq?: number; action: string; hash?: string }>;
    writeFileSync(join(dir, "gestion-auditoria.json"), JSON.stringify(eventos, null, 1));
    c.log(`→ GET /api/v1/audit-events?limit=1000 (pedro.auditoria) → ${aud.status} · ${Array.isArray(eventos) ? eventos.length : 0} eventos con hash encadenado`, "cmd");
    const verifica = await fetch(`${CONSOLA_API}/audit-events/verify`, { headers: { authorization: `Bearer ${auditor}` } });
    const ver = (await verifica.json().catch(() => ({ ok: false }))) as { ok: boolean; checked?: number };
    c.log(`→ GET /api/v1/audit-events/verify → cadena ${ver.ok ? "íntegra" : "ALTERADA"}${ver.checked ? ` (${ver.checked} eventos)` : ""}`, ver.ok ? "ok" : "mal");
    const hoy = new Date().toISOString().slice(0, 10);
    const uso = await fetch(`${CONSOLA_API}/usage/export?from=${hoy}&to=${hoy}`, { headers: { authorization: `Bearer ${adm}` } });
    const csv = await uso.text();
    writeFileSync(join(dir, "gestion-consumo.csv"), csv);
    const filas = csv.trim() ? csv.trim().split("\n").length - 1 : 0;
    c.log(`→ GET /api/v1/usage/export → ${uso.status} ${uso.headers.get("content-type")} · ${filas} filas`, "cmd");
    for (const l of csv.split("\n").slice(0, 4)) c.log(`  ${l}`);
    e.indicadores({ "eventos de auditoría": Array.isArray(eventos) ? eventos.length : 0, "filas de consumo": filas });
    e.comprueba("auditoría exportable y verificable", aud.status === 200 && Array.isArray(eventos) && eventos.length > 0 && ver.ok, `${Array.isArray(eventos) ? eventos.length : 0} eventos · cadena ${ver.ok ? "íntegra" : "alterada"}`);
    e.comprueba("consumo exportable en CSV", uso.status === 200 && csv.startsWith("tipo,clave,llamadas"), `${filas} filas`);
    await e.esperar(2000);

    return {
      medido: `paquete con ${man.items.length} artefactos (${[...tipos].join(", ")}), ${iguales} sumas SHA-256 coincidentes, lectura con herramientas estándar y configuración de la plataforma ${plataforma ? "incluida" : "AUSENTE"}; auditoría (${Array.isArray(eventos) ? eventos.length : 0} eventos) y consumo exportados aparte por la API`,
      datos: { artefactos: man.items.length, tipos: [...tipos], plataforma: plataforma ?? null, eventosAuditoria: Array.isArray(eventos) ? eventos.length : 0 },
    };
  },
};
