/**
 * Plataforma "actual" de SUBTEL simulada (para D-01 y la migración): una ruta en APISIX protegida con
 * key-auth hacia un sistema departamental y algo de tráfico por el NGINX heredado, para que su registro
 * de accesos muestre las rutas que se usan de verdad. Idempotente.
 */
import { fetch } from "undici";

const ADMIN = process.env.APISIX_ADMIN_URL ?? "http://localhost:9180";
const KEY = process.env.APISIX_ADMIN_KEY ?? "nexo-lab-apisix-admin-key";
const NGINX = process.env.NGINX_LEGACY_URL ?? "http://localhost:8088";

async function put(path: string, body: unknown) {
  const res = await fetch(`${ADMIN}/apisix/admin/${path}`, { method: "PUT", headers: { "x-api-key": KEY, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`APISIX ${path}: ${res.status} ${await res.text()}`);
}

async function main() {
  await put("consumers", { username: "sistema_fiscalizacion", plugins: { "key-auth": { key: "llave-fiscalizacion-lab" } } });
  await put("routes/fiscalizacion", {
    name: "fiscalizacion",
    uri: "/fiscalizacion/*",
    plugins: { "key-auth": {} },
    upstream: { type: "roundrobin", nodes: { "ocultas:7001": 1 } },
  });
  console.log("[legado] APISIX: ruta /fiscalizacion/* con key-auth hacia ocultas:7001");
  const paths = ["/interno/reportes/titulares", "/legacy/tarifas", "/legacy/v2/api-docs"];
  let n = 0;
  for (let i = 0; i < 5; i++) {
    for (const p of paths) {
      const res = await fetch(`${NGINX}${p}`, { headers: { host: "legacy.subtel.lab" } });
      await res.arrayBuffer();
      n++;
    }
  }
  console.log(`[legado] NGINX: ${n} llamadas de uso real registradas en el log de accesos`);
}

main().catch((e) => {
  console.error("[legado] ERROR", e instanceof Error ? e.message : e);
  process.exit(1);
});
