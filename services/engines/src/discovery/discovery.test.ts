import { describe, expect, it } from "vitest";
import { exposureScore, parseAccessLog, parseNginxConfig, parseSpec, personalDataInBody, personalFieldsInSpec } from "./analysis.js";
import { cloudRunToFindings, expandTargets } from "./sources.js";

describe("datos personales", () => {
  it("reconoce RUT con dígito verificador válido, correos y teléfonos chilenos", () => {
    expect(personalDataInBody('{"rut":"76.086.428-5","email":"ana@ejemplo.invalid","fono":"+56 9 1234 5678"}').sort()).toEqual(["RUT", "correo", "teléfono"]);
    expect(personalDataInBody('{"folio":"12.345.678-9"}')).toEqual([]); // dígito verificador inválido
  });

  it("detecta campos personales en los esquemas de un contrato", () => {
    expect(personalFieldsInSpec({ components: { schemas: { T: { properties: { rut: {}, correo: {}, banda: {}, fecha_nacimiento: {} } } } } }).sort()).toEqual(
      ["RUT", "correo", "fecha de nacimiento"].sort(),
    );
  });
});

describe("contratos", () => {
  it("lee OpenAPI 3 con la ruta del servidor y Swagger 2 con basePath", () => {
    const v3 = parseSpec(JSON.stringify({ openapi: "3.0.3", info: { title: "X", version: "1" }, servers: [{ url: "https://h/api/v1" }], paths: { "/a": {}, "/b/{id}": {} } }));
    expect(v3).toMatchObject({ kind: "openapi3", paths: ["/api/v1/a", "/api/v1/b/{id}"], securityDeclared: false });
    const v2 = parseSpec("swagger: '2.0'\nbasePath: /legacy\npaths:\n  /tarifas: {}\nsecurityDefinitions: { k: { type: apiKey } }\n");
    expect(v2).toMatchObject({ kind: "swagger2", paths: ["/legacy/tarifas"], securityDeclared: true });
  });

  it("lee las operaciones de un WSDL", () => {
    const w = parseSpec('<wsdl:definitions xmlns:wsdl="x"><wsdl:operation name="ConsultarOperador"/><wsdl:operation name="ConsultarOperador"/></wsdl:definitions>');
    expect(w).toMatchObject({ kind: "wsdl", paths: ["#ConsultarOperador"] });
  });

  it("no confunde una respuesta cualquiera con un contrato", () => {
    expect(parseSpec('{"items":[]}')).toBeUndefined();
    expect(parseSpec("<html>hola</html>")).toBeUndefined();
  });
});

describe("NGINX", () => {
  const conf = `
    # comentario
    server {
      listen 80;
      server_name legacy.subtel.lab;
      location /interno/ { proxy_pass http://ocultas:7001; }
      location /privado/ { auth_basic "restringido"; proxy_pass http://otra:8080; }
      location = /health { return 200 "ok"; }
      location ~ \\.php$ { fastcgi_pass php:9000; }
    }
    server { listen 443 ssl; server_name api.subtel.lab; location / { proxy_pass https://backend; } }`;

  it("inventaria las locations con su destino, autenticación y TLS", () => {
    const locs = parseNginxConfig(conf);
    expect(locs.map((l) => [l.path, l.upstream, l.auth ?? "-", l.tls, l.static])).toEqual([
      ["/interno/", "http://ocultas:7001", "-", false, false],
      ["/privado/", "http://otra:8080", "basic (NGINX)", false, false],
      ["/health", undefined, "-", false, true],
      ["/", "https://backend", "-", true, false],
    ]);
  });

  it("cuenta llamadas por ruta en el registro de accesos", () => {
    const log = [
      '10.0.0.1 - - [04/Oct/2026:07:00:01 +0000] "GET /interno/reportes/titulares?x=1 HTTP/1.1" 200 512 "-" "curl/8"',
      '10.0.0.2 - - [04/Oct/2026:07:00:02 +0000] "GET /interno/reportes/titulares HTTP/1.1" 200 512 "-" "curl/8"',
      '10.0.0.2 - - [04/Oct/2026:07:00:03 +0000] "POST /legacy/tarifas HTTP/1.1" 401 10 "-" "curl/8"',
      '10.0.0.3 - - [04/Oct/2026:07:00:04 +0000] "GET /no/existe HTTP/1.1" 404 10 "-" "curl/8"',
      '10.0.0.9 - - [04/Oct/2026:07:00:05 +0000] "GET /interno/openapi.json HTTP/1.1" 200 10 "-" "nexo-descubrimiento/0.1 (+inventario de APIs autorizado)"',
      "línea que no es de acceso",
    ].join("\n");
    const m = parseAccessLog(log);
    expect(m.get("/interno/reportes/titulares")).toEqual({ calls: 2, statuses: { "200": 2 } });
    expect(m.get("/legacy/tarifas")?.statuses).toEqual({ "401": 1 });
    expect(m.has("/no/existe")).toBe(false); // solo 404: no es una API
    expect(m.has("/interno/openapi.json")).toBe(false); // sondeo del propio motor
  });
});

describe("puntaje de exposición", () => {
  it("lo más grave: sin autenticación, datos personales, fuera del catálogo y sin TLS", () => {
    const r = exposureScore({ auth: "ninguna", tls: "sin TLS", personalData: ["RUT"], governed: false, bypassesGateway: false, external: true, specFound: false });
    expect(r.score).toBe(100);
    expect(r.reasons[0]).toBe("responde sin autenticación");
  });

  it("una API gobernada, con autenticación y TLS 1.3, casi no expone", () => {
    expect(exposureScore({ auth: "requerida", tls: "TLSv1.3", personalData: [], governed: true, bypassesGateway: false, external: false, specFound: true }).score).toBe(0);
  });
});

describe("objetivos de red y nube", () => {
  it("expande rangos acotados y rechaza los amplios", () => {
    expect(expandTargets(["10.1.2.0/30:80|443"]).length).toBe(8);
    expect(expandTargets(["ocultas:7001"])).toEqual([{ host: "ocultas", port: 7001 }]);
    expect(() => expandTargets(["10.0.0.0/16:80"])).toThrow(/demasiado amplio/);
  });

  it("marca los servicios de Cloud Run abiertos a allUsers", () => {
    const f = cloudRunToFindings(
      [
        { name: "projects/p/locations/r/services/abierto", uri: "https://abierto-x.a.run.app", ingress: "INGRESS_TRAFFIC_ALL" },
        { name: "projects/p/locations/r/services/interno", uri: "https://interno-x.a.run.app", ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY" },
      ],
      new Set(["projects/p/locations/r/services/abierto"]),
    );
    expect(f.map((x) => [x.host, x.authHint, x.external])).toEqual([
      ["abierto-x.a.run.app", "ninguna", true],
      ["interno-x.a.run.app", "requerida", false],
    ]);
  });
});
