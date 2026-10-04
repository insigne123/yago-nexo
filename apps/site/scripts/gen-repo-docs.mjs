// Genera parciales de la documentación a partir de archivos del repositorio, para que los datos
// del sitio (servicios, puertos, comandos, versiones, licencia y avisos) sean siempre los reales.
//
// Fuentes → salidas (docs/_generated/):
//   deploy/compose/docker-compose.yml (+ Dockerfiles)  → servicios-laboratorio.md, accesos-laboratorio.md
//   deploy/compose/Makefile                             → comandos-laboratorio.md, hosts-laboratorio.md
//   tools/lab-bootstrap/src/index.ts                    → variables-bootstrap.md
//   fluent-bit, prometheus, alertmanager                → observabilidad-laboratorio.md
//   deploy/compose/keycloak/realm-nexo.json             → keycloak-laboratorio.md
//   src/data/componentes.json + docker-compose.yml      → componentes.md, componentes-solo-laboratorio.md
//   LICENSE, NOTICE                                      → licencia.md, aviso.md
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { banner, cell, code, fail, fromRepo, fromSite, readJson, table, writeGenerated } from "./lib.mjs";

const SCRIPT = "gen-repo-docs.mjs";
const COMPOSE = "deploy/compose/docker-compose.yml";
const MAKEFILE = "deploy/compose/Makefile";
const composeDir = dirname(fromRepo(COMPOSE));

// ------------------------------------------------------------------ docker-compose.yml

const composeDoc = YAML.parseDocument(readFileSync(fromRepo(COMPOSE), "utf8"));
if (composeDoc.errors.length > 0) fail(SCRIPT, `${COMPOSE}: ${composeDoc.errors[0].message}`);
const compose = composeDoc.toJS();
const servicios = compose.services ?? {};
if (Object.keys(servicios).length === 0) fail(SCRIPT, `${COMPOSE} no define servicios`);

/** Imagen base (última etapa FROM) de un Dockerfile. */
function baseDockerfile(contexto, dockerfile = "Dockerfile") {
  const ruta = resolve(composeDir, contexto, dockerfile);
  if (!existsSync(ruta)) return undefined;
  const froms = [...readFileSync(ruta, "utf8").matchAll(/^FROM\s+(\S+)/gim)].map((m) => m[1]);
  return froms.at(-1);
}

function argDockerfile(archivo, arg) {
  const ruta = fromRepo(archivo);
  if (!existsSync(ruta)) fail(SCRIPT, `no existe ${archivo}`);
  const m = new RegExp(`^ARG\\s+${arg}=(\\S+)`, "m").exec(readFileSync(ruta, "utf8"));
  if (!m) fail(SCRIPT, `${archivo} no define ARG ${arg} con valor por omisión`);
  return m[1];
}

const constructoras = new Map(); // imagen local → servicio que la construye
for (const [nombre, s] of Object.entries(servicios))
  if (s.build && s.image) constructoras.set(s.image, nombre);

/** Descripción de la imagen de un servicio: etiqueta pública o imagen construida y su base. */
function imagen(nombre) {
  const s = servicios[nombre];
  if (!s) return undefined;
  if (s.build) {
    const contexto = typeof s.build === "string" ? s.build : (s.build.context ?? ".");
    const base = baseDockerfile(contexto, typeof s.build === "object" ? s.build.dockerfile : undefined);
    return {
      texto: `construida desde ${code(contexto, { inTable: true })}${base ? ` (base ${code(base, { inTable: true })})` : ""}`,
      version: base,
    };
  }
  if (s.image && constructoras.has(s.image)) {
    return {
      texto: `${code(s.image, { inTable: true })} (la construye ${code(constructoras.get(s.image), { inTable: true })})`,
      version: s.image,
    };
  }
  return { texto: code(s.image ?? "—", { inTable: true }), version: s.image };
}

const perfiles = (s) => (s.profiles?.length ? s.profiles : ["núcleo"]);

/** Puertos publicados con el comentario que los acompaña en el compose. */
function puertos(nombre) {
  const nodo = composeDoc.getIn(["services", nombre, "ports"], true);
  if (!nodo || !YAML.isSeq(nodo)) return [];
  return nodo.items.map((item) => {
    const valor = String(YAML.isScalar(item) ? item.value : item);
    const comentario = YAML.isScalar(item) && item.comment ? item.comment.trim() : "";
    const [host, contenedor] = valor.includes(":")
      ? [valor.split(":").at(-2), valor.split(":").at(-1)]
      : [valor, valor];
    return { valor, host, contenedor, comentario };
  });
}

function notas(nombre) {
  const s = servicios[nombre];
  const env = Array.isArray(s.environment) ? {} : (s.environment ?? {});
  const extra = [];
  if (env.MODE)
    extra.push(
      `modo ${code(env.MODE, { inTable: true })}${env.VERSION ? ` ${code(env.VERSION, { inTable: true })}` : ""}`,
    );
  if (s.restart === "no") extra.push("se ejecuta una vez y termina");
  return extra;
}

const ordenPerfiles = ["núcleo", ...new Set(Object.values(servicios).flatMap((s) => s.profiles ?? []))];
const filasServicios = [];
for (const perfil of ordenPerfiles) {
  for (const [nombre, s] of Object.entries(servicios)) {
    if (!perfiles(s).includes(perfil) || perfil !== perfiles(s)[0]) continue;
    const ps = puertos(nombre);
    const textoPuertos = ps.length
      ? ps
          .map((p) => `${code(p.valor, { inTable: true })}${p.comentario ? ` ${cell(p.comentario)}` : ""}`)
          .join("<br />")
      : "—";
    filasServicios.push([
      code(nombre, { inTable: true }),
      perfiles(s)
        .map((p) => (p === "núcleo" ? "núcleo" : code(p, { inTable: true })))
        .join(", "),
      imagen(nombre).texto,
      textoPuertos,
      notas(nombre).join("; ") || " ",
    ]);
  }
}

const totalPorPerfil = ordenPerfiles
  .map(
    (p) =>
      `${p === "núcleo" ? "núcleo" : code(p)}: ${Object.values(servicios).filter((s) => perfiles(s)[0] === p).length}`,
  )
  .join(" · ");

writeGenerated(
  fromSite("docs/_generated/servicios-laboratorio.md"),
  `${banner(SCRIPT, COMPOSE)}
${table(["Servicio", "Perfil", "Imagen", "Puertos (equipo:contenedor)", "Notas"], filasServicios)}

Servicios por perfil: ${totalPorPerfil}. Proyecto Compose: ${code(compose.name ?? "—")}.
`,
);

// Accesos principales: interfaces web y API conocidas, con el puerto publicado REAL del compose.
const ACCESOS = [
  {
    servicio: "apim",
    contenedor: "9443",
    interfaz: "Publisher (WSO2 API Manager)",
    url: "https://apim:{puerto}/publisher",
  },
  { servicio: "apim", contenedor: "9443", interfaz: "Dev Portal", url: "https://apim:{puerto}/devportal" },
  { servicio: "apim", contenedor: "9443", interfaz: "Admin Portal", url: "https://apim:{puerto}/admin" },
  {
    servicio: "apim",
    contenedor: "8243",
    interfaz: "Gateway HTTPS: API de ejemplo (exige token)",
    url: "https://apim:{puerto}/concesiones/1.0.0/concesiones",
  },
  {
    servicio: "keycloak",
    contenedor: "8080",
    interfaz: "Keycloak (consola de administración)",
    url: "http://keycloak:{puerto}/admin/",
  },
  {
    servicio: "mi",
    contenedor: "9164",
    interfaz: "Management API de Micro Integrator",
    url: "https://localhost:{puerto}/management",
  },
  {
    servicio: "rabbitmq",
    contenedor: "15672",
    interfaz: "RabbitMQ (consola de administración)",
    url: "http://localhost:{puerto}/",
  },
  {
    servicio: "concesiones-v1",
    contenedor: "7001",
    interfaz: "Backend de ejemplo: contrato OpenAPI",
    url: "http://localhost:{puerto}/openapi.json",
  },
  { servicio: "grafana", contenedor: "3000", interfaz: "Grafana", url: "http://localhost:{puerto}/" },
  { servicio: "prometheus", contenedor: "9090", interfaz: "Prometheus", url: "http://localhost:{puerto}/" },
  {
    servicio: "alertmanager",
    contenedor: "9093",
    interfaz: "Alertmanager",
    url: "http://localhost:{puerto}/",
  },
  { servicio: "jaeger", contenedor: "16686", interfaz: "Jaeger", url: "http://localhost:{puerto}/" },
  {
    servicio: "opensearch-dashboards",
    contenedor: "5601",
    interfaz: "OpenSearch Dashboards",
    url: "http://localhost:{puerto}/",
  },
  {
    servicio: "opensearch",
    contenedor: "9200",
    interfaz: "OpenSearch (API)",
    url: "http://localhost:{puerto}/",
  },
  {
    servicio: "apisix",
    contenedor: "9080",
    interfaz: "APISIX (plataforma existente simulada)",
    url: "http://localhost:{puerto}/",
  },
  {
    servicio: "nginx-legacy",
    contenedor: "80",
    interfaz: "NGINX (plataforma existente simulada)",
    url: "http://localhost:{puerto}/health",
  },
];
const filasAccesos = [];
for (const a of ACCESOS) {
  if (!servicios[a.servicio]) {
    console.warn(`[${SCRIPT}] aviso: el servicio ${a.servicio} ya no está en ${COMPOSE}; se omite su acceso`);
    continue;
  }
  const p = puertos(a.servicio).find((x) => x.contenedor === a.contenedor);
  if (!p) {
    console.warn(
      `[${SCRIPT}] aviso: ${a.servicio} ya no publica el puerto ${a.contenedor}; se omite su acceso`,
    );
    continue;
  }
  filasAccesos.push([
    cell(a.interfaz),
    code(a.url.replace("{puerto}", p.host), { inTable: true }),
    perfiles(servicios[a.servicio])
      .map((x) => (x === "núcleo" ? "núcleo" : code(x, { inTable: true })))
      .join(", "),
  ]);
}
writeGenerated(
  fromSite("docs/_generated/accesos-laboratorio.md"),
  `${banner(SCRIPT, COMPOSE)}
${table(["Interfaz", "URL", "Perfil"], filasAccesos)}
`,
);

// ------------------------------------------------------------------ Makefile

const makefile = readFileSync(fromRepo(MAKEFILE), "utf8");
const lineas = makefile.split(/\r?\n/);
const objetivos = new Map();
for (let i = 0; i < lineas.length; i++) {
  const m = /^([a-z][\w-]*):(?!=)/.exec(lineas[i]);
  if (!m) continue;
  const previa = lineas[i - 1] ?? "";
  objetivos.set(m[1], previa.startsWith("## ") ? previa.slice(3).trim() : undefined);
}
// Lo que docs/laboratorio.md explica paso a paso: si el Makefile cambia, el build avisa.
const REQUERIDOS = ["env", "build", "up", "core", "down", "clean", "status", "logs", "bootstrap", "hosts"];
const faltantes = REQUERIDOS.filter((t) => !objetivos.has(t));
if (faltantes.length > 0) {
  fail(
    SCRIPT,
    `${MAKEFILE} ya no define: ${faltantes.join(", ")}. Actualice docs/laboratorio.md y este script.`,
  );
}
const DESCRIPCION_OBJETIVO = {
  env: "Crea `.env` desde `.env.example` si no existe.",
  build: "Compila los backends de ejemplo y construye las imágenes del laboratorio.",
  down: "Detiene y elimina los contenedores (conserva los volúmenes).",
  status: "Muestra el estado y los puertos de cada servicio.",
  logs: "Sigue los logs; `S=<servicio>` filtra por servicio.",
};
const perfilesPorOmision = /^PROFILES\s*\?=\s*(.+)$/m.exec(makefile)?.[1]?.trim();
writeGenerated(
  fromSite("docs/_generated/comandos-laboratorio.md"),
  `${banner(SCRIPT, MAKEFILE)}
${table(
  ["Comando", "Qué hace"],
  [...objetivos.entries()].map(([t, comentario]) => [
    code(`make -C deploy/compose ${t}`, { inTable: true }),
    comentario ? cell(comentario) : (DESCRIPCION_OBJETIVO[t] ?? "—"),
  ]),
)}
${perfilesPorOmision ? `\nPerfiles por omisión (variable ${code("PROFILES")}): ${code(perfilesPorOmision)}.\n` : ""}`,
);

const hosts = /echo\s+"(127\.0\.0\.1\s+[^"#]+?)\s*(?:#[^"]*)?"/.exec(makefile)?.[1]?.trim();
if (!hosts) fail(SCRIPT, `no se encontró la línea de /etc/hosts del objetivo hosts en ${MAKEFILE}`);
writeGenerated(
  fromSite("docs/_generated/hosts-laboratorio.md"),
  `${banner(SCRIPT, MAKEFILE)}
\`\`\`text title="/etc/hosts (línea que agrega make hosts)"
${hosts} # nexo-lab
\`\`\`
`,
);

// ------------------------------------------------------------------ variables del arranque (lab-bootstrap)

const BOOTSTRAP = "tools/lab-bootstrap/src/index.ts";
const fuenteBootstrap = readFileSync(fromRepo(BOOTSTRAP), "utf8");
const variables = [...fuenteBootstrap.matchAll(/env\("([A-Z0-9_]+)",\s*"([^"]*)"\)/g)].map((m) => ({
  nombre: m[1],
  omision: m[2],
}));
if (variables.length === 0) fail(SCRIPT, `no se encontraron variables env("...") en ${BOOTSTRAP}`);
const esSecreto = (n) => /PASSWORD|SECRET|TOKEN|(?:^|_)KEY(?:_|$)/.test(n);
writeGenerated(
  fromSite("docs/_generated/variables-bootstrap.md"),
  `${banner(SCRIPT, BOOTSTRAP)}
${table(
  ["Variable", "Valor por omisión"],
  variables.map((v) => [
    code(v.nombre, { inTable: true }),
    esSecreto(v.nombre) ? "el de `deploy/compose/.env.example`" : code(v.omision, { inTable: true }),
  ]),
)}
`,
);

// ------------------------------------------------------------------ observabilidad del laboratorio

const FLUENT = "deploy/compose/fluent-bit/fluent-bit.yaml";
const PROMETHEUS = "deploy/compose/prometheus/prometheus.yml";
const REGLAS = "deploy/compose/prometheus/rules/nexo.yml";
const fluent = YAML.parse(readFileSync(fromRepo(FLUENT), "utf8"));
const prom = YAML.parse(readFileSync(fromRepo(PROMETHEUS), "utf8"));
const reglas = YAML.parse(readFileSync(fromRepo(REGLAS), "utf8"));

const entradas = new Map((fluent.pipeline?.inputs ?? []).map((i) => [i.tag, i.path]));
const rutasLogs = (fluent.pipeline?.outputs ?? [])
  .filter((o) => o.name === "opensearch")
  .map((o) => [
    code(entradas.get(o.match) ?? o.match, { inTable: true }),
    code(`${o.logstash_prefix ?? o.index ?? "—"}-*`, { inTable: true }),
    o.retry_limit === "no_limits" || o.retry_limit === false
      ? "sin límite"
      : cell(String(o.retry_limit ?? "por omisión")),
  ]);
const conBuffer = (fluent.pipeline?.inputs ?? []).every((i) => i["storage.type"] === "filesystem");

const trabajos = (prom.scrape_configs ?? []).map((j) => [
  code(j.job_name, { inTable: true }),
  (j.static_configs ?? [])
    .flatMap((s) => s.targets ?? [])
    .map((t) => code(t, { inTable: true }))
    .join(", "),
  code(j.metrics_path ?? "/metrics", { inTable: true }),
]);
// Destinos cuyo host no es un servicio del compose (salvo localhost): servicios aún no incluidos.
const hostDe = (destino) =>
  String(destino)
    .replace(/^https?:\/\//, "")
    .split(/[:/]/)[0];
const destinosFuturos = (prom.scrape_configs ?? [])
  .flatMap((j) => (j.static_configs ?? []).flatMap((s) => s.targets ?? []))
  .filter((t) => hostDe(t) !== "localhost" && !servicios[hostDe(t)]);

const ALERTMANAGER = "deploy/compose/alertmanager/alertmanager.yml";
const am = YAML.parse(readFileSync(fromRepo(ALERTMANAGER), "utf8"));
const webhooksSinReceptor = (am.receivers ?? [])
  .flatMap((r) => r.webhook_configs ?? [])
  .map((w) => w.url)
  .filter((u) => u && !servicios[hostDe(u)]);

const alertas = (reglas.groups ?? []).flatMap((g) =>
  (g.rules ?? [])
    .filter((r) => r.alert)
    .map((r) => [
      code(r.alert, { inTable: true }),
      code(r.labels?.severidad ?? "—", { inTable: true }),
      code(r.for ?? "—", { inTable: true }),
      cell(
        String(r.annotations?.resumen ?? "—").replace(
          /\{\{\s*\$labels\.(\w+)\s*\}\}/g,
          (_, l) => `«${{ job: "trabajo", instance: "instancia", queue: "cola" }[l] ?? l}»`,
        ),
      ),
    ]),
);

writeGenerated(
  fromSite("docs/_generated/observabilidad-laboratorio.md"),
  `${banner(SCRIPT, FLUENT, PROMETHEUS, REGLAS, ALERTMANAGER)}
**Logs y analítica (Fluent Bit → OpenSearch).** ${conBuffer ? "Las entradas usan buffer en disco, de modo que los eventos esperan si OpenSearch no está disponible." : ""}

${table(["Archivo de origen (contenedor de API Manager)", "Índice en OpenSearch", "Reintentos"], rutasLogs)}

**Métricas (Prometheus).** Intervalo de recolección: ${code(prom.global?.scrape_interval ?? "—")}.

${table(["Trabajo", "Destinos", "Ruta"], trabajos)}
${
  destinosFuturos.length > 0
    ? `\nLos destinos ${destinosFuturos.map((t) => code(t)).join(", ")} son servicios de Nexo que todavía no forman parte del laboratorio: aparecen caídos en Prometheus y activan la alerta de componente caído. Es esperado en esta versión.\n`
    : ""
}
**Alertas (reglas de Prometheus).**

${table(["Alerta", "Severidad", "Duración mínima", "Resumen"], alertas)}
${
  webhooksSinReceptor.length > 0
    ? `\nAlertmanager envía las notificaciones a ${webhooksSinReceptor.map((u) => code(u)).join(", ")}. Ese servicio todavía no forma parte del laboratorio, así que por ahora las notificaciones no tienen receptor; las alertas se ven en Prometheus y Alertmanager.\n`
    : ""
}`,
);

// ------------------------------------------------------------------ realm de Keycloak del laboratorio

const REALM = "deploy/compose/keycloak/realm-nexo.json";
const realm = readJson(fromRepo(REALM));
const politica = String(realm.passwordPolicy ?? "");
const exige = [];
const largo = /length\((\d+)\)/.exec(politica)?.[1];
if (largo) exige.push(`al menos ${largo} caracteres`);
if (/upperCase/.test(politica)) exige.push("mayúsculas");
if (/lowerCase/.test(politica)) exige.push("minúsculas");
if (/digits/.test(politica)) exige.push("dígitos");
if (/specialChars/.test(politica)) exige.push("símbolos");
if (/notUsername/.test(politica)) exige.push("distinta del nombre de usuario");
const minutos = (s) => (typeof s === "number" ? `${Math.round(s / 60)} minutos` : "—");
const rolesConsola = (realm.roles?.client?.["nexo-console"] ?? []).map((r) => r.name);
writeGenerated(
  fromSite("docs/_generated/keycloak-laboratorio.md"),
  `${banner(SCRIPT, REALM)}
${table(
  ["Parámetro del realm de laboratorio", "Valor"],
  [
    ["Realm", code(realm.realm ?? "—", { inTable: true })],
    ["Contraseñas", exige.length ? cell(exige.join(", ")) : "—"],
    ["Protección contra fuerza bruta", realm.bruteForceProtected ? "activada" : "desactivada"],
    ["Registro abierto de usuarios", realm.registrationAllowed ? "permitido" : "no permitido"],
    ["Vigencia del token de acceso", minutos(realm.accessTokenLifespan)],
    ["Cierre de sesión por inactividad", minutos(realm.ssoSessionIdleTimeout)],
    [
      "Eventos de inicio de sesión y de administración",
      realm.eventsEnabled && realm.adminEventsEnabled ? "registrados" : "no registrados",
    ],
    ["Clientes", (realm.clients ?? []).map((c) => code(c.clientId, { inTable: true })).join(", ") || "—"],
    ["Roles de la Consola", rolesConsola.map((r) => code(r, { inTable: true })).join(", ") || "—"],
  ],
)}
`,
);

// ------------------------------------------------------------------ componentes y licencias

const datos = readJson(fromSite("src/data/componentes.json"));
const release = readJson(fromSite("src/data/release.json"));

function enLaboratorio(c) {
  const lab = c.laboratorio;
  if (!lab) return "No incluido todavía";
  if (lab.servicio) {
    if (!servicios[lab.servicio])
      fail(SCRIPT, `componentes.json: el servicio ${lab.servicio} no existe en ${COMPOSE}`);
    const img = imagen(lab.servicio);
    return `${code(img.version ?? "—", { inTable: true })} (servicio ${code(lab.servicio, { inTable: true })})`;
  }
  if (lab.dockerfileArg) {
    const { archivo, arg } = lab.dockerfileArg;
    return `${code(argDockerfile(archivo, arg), { inTable: true })} (${code(archivo.replace("deploy/compose/", ""), { inTable: true })})`;
  }
  fail(SCRIPT, `componentes.json: "laboratorio" de ${c.componente} no tiene servicio ni dockerfileArg`);
}

const filaComponente = (c) => [
  cell(c.funcion),
  cell(c.componente),
  c.agpl ? `**${cell(c.licencia)}**` : cell(c.licencia),
  enLaboratorio(c),
  cell(c.nota ?? "") || " ",
];

writeGenerated(
  fromSite("docs/_generated/componentes.md"),
  `${banner(SCRIPT, "apps/site/src/data/componentes.json", COMPOSE)}
${table(
  ["Función", "Componente", "Licencia", "En el laboratorio", "Nota"],
  [
    ...datos.componentes.map(filaComponente),
    [
      "Consola Nexo, motores, mediadores, instaladores y pruebas",
      "Capa Yago (código propio)",
      "Licencia de uso de Yago",
      `${code(release.version, { inTable: true })} (${cell(release.estado)}): bibliotecas y backends de ejemplo`,
      "Ver [Licencia y avisos](/docs/licencia-y-avisos).",
    ],
  ],
)}
`,
);

writeGenerated(
  fromSite("docs/_generated/componentes-solo-laboratorio.md"),
  `${banner(SCRIPT, "apps/site/src/data/componentes.json", COMPOSE)}
${table(
  ["Función", "Componente", "Licencia", "En el laboratorio"],
  datos.soloLaboratorio.map((c) => filaComponente(c).slice(0, 4)),
)}
`,
);

// ------------------------------------------------------------------ LICENSE y NOTICE (texto literal)

for (const [archivo, salida] of [
  ["LICENSE", "licencia.md"],
  ["NOTICE", "aviso.md"],
]) {
  const texto = readFileSync(fromRepo(archivo), "utf8").trimEnd();
  if (texto.includes("````")) fail(SCRIPT, `${archivo} contiene una secuencia de cuatro acentos graves`);
  writeGenerated(
    fromSite(`docs/_generated/${salida}`),
    `${banner(SCRIPT, archivo)}\n\`\`\`\`text title="${archivo}"\n${texto}\n\`\`\`\`\n`,
  );
}

console.log(
  `[${SCRIPT}] ${Object.keys(servicios).length} servicios del laboratorio, ${objetivos.size} comandos make, ` +
    `${datos.componentes.length + datos.soloLaboratorio.length} componentes, LICENSE y NOTICE`,
);
