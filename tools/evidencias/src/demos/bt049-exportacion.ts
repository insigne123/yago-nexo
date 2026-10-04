/**
 * Exportación de APIs, contratos, políticas, configuraciones, metadatos y datos de gestión en formatos
 * documentados. La administradora genera el paquete desde la Consola; se verifica el SHA-256 de cada artefacto
 * contra el manifiesto y se leen todos con herramientas estándar (unzip, YAML, XML, JSON, CSV), sin software
 * del proveedor. Los datos de gestión (auditoría y consumo) y la configuración de la plataforma como código
 * completan la exportación.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import type { Demo } from "../lib/grabador.js";
import { desdeRaiz } from "../lib/entorno.js";
import { CONSOLA_API, tokenPersona } from "../lib/lab.js";
import { escaparHtml } from "../lib/grabador.js";

type Manifiesto = { version: string; generadoEn: string; origen: string; items: Array<{ tipo: string; nombre: string; archivo: string; sha256: string }> };

/** Lector independiente (Python estándar + PyYAML) para mostrar que los artefactos no dependen de Nexo ni de WSO2. */
const LECTOR = `import json, sys, zipfile, io, xml.etree.ElementTree as ET, yaml
base = sys.argv[1]
man = json.load(open(base + "/manifiesto.json"))
for it in man["items"]:
    ruta = base + "/" + it["archivo"]
    if ruta.endswith(".zip"):
        z = zipfile.ZipFile(ruta)
        for n in z.namelist():
            if n.endswith((".graphql", ".gql")):
                texto = z.read(n).decode()
                print(f"zip  {it['archivo']}: {n.split('/',1)[1]} → esquema GraphQL · {texto.count('type ')} tipos")
                continue
            if not n.endswith((".yaml", ".yml", ".json")):
                print(f"zip  {it['archivo']}: {n.split('/',1)[1]} · {len(z.read(n))} bytes")
                continue
            d = yaml.safe_load(z.read(n))
            if n.split("/")[-1] == "api.yaml":
                x = d.get("data", d)
                print(f"zip  {it['archivo']}: {n.split('/',1)[1]} → {x.get('name')} {x.get('version')} · contexto {x.get('context')} · planes {','.join(x.get('policies') or [])}")
            else:
                clave = "openapi" if "openapi" in d else ("asyncapi" if "asyncapi" in d else "swagger")
                print(f"zip  {it['archivo']}: {n.split('/',1)[1]} → {clave} {d.get(clave, '')} · {len(d.get('paths') or d.get('channels') or {})} rutas")
    elif ruta.endswith(".xml"):
        r = ET.parse(ruta).getroot()
        print(f"xml  {it['archivo']}: <{r.tag.split('}')[-1]} name={r.get('name')}> · {sum(1 for _ in r.iter())} elementos")
    elif ruta.endswith(".json"):
        d = json.load(open(ruta))
        print(f"json {it['archivo']}: {len(d) if isinstance(d, list) else ', '.join(f'{k}: {len(v)}' for k, v in d.items())} registros")
`;

export const bt049: Demo = {
  id: "BT-049",
  archivo: "BT-049_exportacion",
  nombre: "Exportación de APIs, contratos, políticas, configuración y metadatos",
  afirmacion:
    "La plataforma exporta sus APIs con contratos y políticas, los flujos de integración, el catálogo y el grafo de dependencias, la configuración de la plataforma y los datos de gestión, en formatos abiertos que se leen con herramientas estándar y con un manifiesto de sumas SHA-256.",
  pasos: 5,
  usuarioInicial: "admin.nexo",

  async ejecutar(c) {
    const adm = await tokenPersona("admin.nexo");
    const auditor = await tokenPersona("pedro.auditoria");

    c.paso("La administradora genera el paquete de exportación desde la Consola");
    await c.ir("/exportacion");
    await c.clic(c.app.getByTestId("btn-create-export"));
    await c.app.getByTestId("btn-download-export").waitFor({ timeout: 60_000 });
    await c.esperar(1500);
    const zipRuta = await c.descargar(c.app.getByTestId("btn-download-export"), "nexo-export.zip");
    const zip = unzipSync(new Uint8Array(readFileSync(zipRuta)));
    const dir = join(c.archivos, "export");
    for (const [f, data] of Object.entries(zip)) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), data);
    }
    c.log(`$ unzip -l nexo-export.zip   (${(readFileSync(zipRuta).length / 1024).toFixed(0)} KB)`, "cmd");
    for (const f of Object.keys(zip).sort()) c.log(`  ${String(zip[f]!.length).padStart(7)}  ${f}`);
    const man = JSON.parse(strFromU8(zip["manifiesto.json"]!)) as Manifiesto;
    c.exigir("paquete con manifiesto", !!man.items?.length, `${man.items.length} artefactos · versión ${man.version}`);

    c.paso("Manifiesto: el SHA-256 de cada artefacto se recalcula y coincide");
    let iguales = 0;
    for (const it of man.items) {
      const h = createHash("sha256").update(zip[it.archivo] ?? new Uint8Array()).digest("hex");
      const ok = h === it.sha256;
      if (ok) iguales++;
      c.log(`${ok ? "✓" : "✗"} ${h.slice(0, 16)}…  ${it.tipo.padEnd(9)} ${it.archivo}`, ok ? "ok" : "mal");
    }
    c.verificar("sumas SHA-256 del manifiesto", iguales === man.items.length, `${iguales} de ${man.items.length}`);
    const tipos = new Set(man.items.map((i) => i.tipo));
    c.verificar("incluye APIs (contrato y políticas), flujos y metadatos", ["api", "flujo", "metadatos"].every((t) => tipos.has(t)), [...tipos].join(", "));

    c.paso("Se leen con herramientas estándar (Python: zipfile, YAML, XML, JSON), sin software del proveedor");
    writeFileSync(join(c.archivos, "leer_exportacion.py"), LECTOR);
    const lectura = await c.ejecutarComando("python3", [join(c.archivos, "leer_exportacion.py"), dir], { mostrar: "python3 leer_exportacion.py export/", tablas: false });
    c.verificar("todos los artefactos se leen con herramientas estándar", lectura.codigo === 0 && lectura.salida.length >= man.items.length, `${lectura.salida.length} lecturas`);
    const concesiones = Object.keys(zip).find((f) => f.startsWith("apis/Concesiones-"));
    const interno = concesiones ? unzipSync(zip[concesiones]!) : {};
    const swagger = Object.entries(interno).find(([n]) => n.endsWith("swagger.yaml"));
    if (swagger) {
      c.panel(`<h3>${escaparHtml(concesiones!)} → ${escaparHtml(swagger[0])}</h3><pre style="font-size:11.5px;line-height:1.35;white-space:pre-wrap;color:#cfe3ff">${escaparHtml(strFromU8(swagger[1]).split("\n").slice(0, 34).join("\n"))}</pre>`);
      await c.vista("terminal-panel");
      await c.esperar(6000);
    }

    c.paso("Datos de gestión: auditoría encadenada y consumo, en JSON y CSV");
    await c.vista("dividido");
    const aud = await fetch(`${CONSOLA_API}/audit-events?limit=1000`, { headers: { authorization: `Bearer ${auditor}` } });
    const eventos = (await aud.json()) as Array<{ seq?: number; action: string; hash?: string }>;
    writeFileSync(join(dir, "gestion-auditoria.json"), JSON.stringify(eventos, null, 1));
    c.log(`$ GET /api/v1/audit-events?limit=1000 (pedro.auditoria) → ${aud.status} · ${eventos.length} eventos con hash encadenado`, "cmd");
    const ver = (await (await fetch(`${CONSOLA_API}/audit-events/verify`, { headers: { authorization: `Bearer ${auditor}` } })).json()) as { ok: boolean; checked?: number };
    c.log(`$ GET /api/v1/audit-events/verify → cadena ${ver.ok ? "íntegra" : "ALTERADA"}${ver.checked ? ` (${ver.checked} eventos)` : ""}`, ver.ok ? "ok" : "mal");
    const hoy = new Date().toISOString().slice(0, 10);
    const uso = await fetch(`${CONSOLA_API}/usage/export?from=${hoy}&to=${hoy}`, { headers: { authorization: `Bearer ${adm}` } });
    const csv = await uso.text();
    writeFileSync(join(dir, "gestion-consumo.csv"), csv);
    c.log(`$ GET /api/v1/usage/export → ${uso.status} ${uso.headers.get("content-type")} · ${csv.trim().split("\n").length - 1} filas`, "cmd");
    for (const l of csv.split("\n").slice(0, 4)) c.log(`  ${l}`);
    c.verificar("auditoría exportable y verificable", aud.status === 200 && eventos.length > 0 && ver.ok, `${eventos.length} eventos`);
    c.verificar("consumo exportable en CSV", uso.status === 200 && csv.startsWith("tipo,clave,llamadas"), `${csv.trim().split("\n").length - 1} filas`);

    c.paso("Configuración de la plataforma como código: ambientes, planes, flujos de aprobación y gobierno");
    const plataforma = readFileSync(desdeRaiz("wso2/apim/platform.yaml"), "utf8");
    const py = await c.ejecutarComando(
      "python3",
      [
        "-c",
        "import yaml,sys; d=yaml.safe_load(open(sys.argv[1])); print('ambientes:', ', '.join(g['name'] for g in d['gatewayEnvironments'])); print('planes de suscripción:', ', '.join(p['name'] for p in d['throttling']['subscription'])); print('flujos de aprobación:', d['workflows']['file']); print('gobierno:', ', '.join(p['name'] for p in d['governance']['policies']))",
        desdeRaiz("wso2/apim/platform.yaml"),
      ],
      { mostrar: "python3 -c 'yaml.safe_load(open(\"wso2/apim/platform.yaml\"))'", tablas: false },
    );
    c.verificar("configuración de la plataforma legible (YAML)", py.codigo === 0 && plataforma.includes("throttling"), "wso2/apim/platform.yaml");
    await c.esperar(3000);

    return {
      medido: `paquete con ${man.items.length} artefactos (APIs con contrato y políticas, flujos, catálogo y grafo), ${iguales} sumas SHA-256 coincidentes y lectura con herramientas estándar; auditoría (${eventos.length} eventos) y consumo exportados`,
      datos: { artefactos: man.items.length, tipos: [...tipos], eventosAuditoria: eventos.length },
    };
  },
};
