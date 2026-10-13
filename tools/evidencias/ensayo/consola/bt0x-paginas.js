// Consola de ensayo (V09), páginas que usan los guiones D-06..D-08 y BT-008/018/021/049: catálogo, ficha,
// dependencias, mensajes fallidos, consumo y exportación, con los mismos data-testid que la Consola real.
// Se inyecta solo en ensayo (src/demos/bt0x-ensayo.ts, prepararEnsayo) y dibuja sobre la pantalla genérica de
// ensayo/consola/consola.js. Los datos vienen del servidor de ensayo (simulados) y todo lleva el rótulo ENSAYO.
(() => {
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const api = async (metodo, ruta, cuerpo) => {
    const r = await fetch(`/api/v1${ruta}`, {
      method: metodo,
      headers: { authorization: `Bearer ${sessionStorage.getItem("ensayo-token") || ""}`, ...(cuerpo ? { "content-type": "application/json" } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const RUTAS = [/^\/catalogo$/, /^\/catalogo\/[^/]+$/, /^\/dependencias$/, /^\/mensajes-fallidos$/, /^\/consumo$/, /^\/exportacion$/];
  const mia = (p) => RUTAS.some((r) => r.test(p));
  const aviso = (texto) => {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = texto;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  };
  // Descarga como la Consola real: fetch con el token y blob (un enlace relativo lo tomaría el enrutador de consola.js).
  const descargar = async (ruta, nombre) => {
    const r = await fetch(ruta, { headers: { authorization: `Bearer ${sessionStorage.getItem("ensayo-token") || ""}` } });
    const url = URL.createObjectURL(await r.blob());
    const x = document.createElement("a");
    x.href = url;
    x.download = nombre;
    document.body.appendChild(x);
    x.click();
    x.remove();
  };
  const relleno = (n) =>
    `<div class="tarjeta"><h3 style="margin-top:0">Detalle (simulado)</h3><table><tbody>${Array.from({ length: n }, (_, i) => `<tr><td>Registro ${i + 1}</td><td>valor de ensayo ${i + 1}</td></tr>`).join("")}</tbody></table></div>`;

  async function catalogo(main) {
    const { data } = await api("GET", "/apis");
    const filas = (data || [])
      .map((a) => `<tr><td><a href="/catalogo/${encodeURIComponent(a.id)}">${esc(a.name)}</a></td><td>${esc(a.version)}</td><td>${esc(a.type)}</td><td>${esc(a.state)}</td><td>${a.completeness} %</td></tr>`)
      .join("");
    main.innerHTML = `<h1>Catálogo de APIs</h1><p class="sub">Sincronizado con WSO2 (simulado en el ensayo).</p>
      <div class="tarjeta"><button class="btn" data-testid="btn-sync-wso2">Sincronizar con WSO2</button></div>
      <div class="tarjeta"><table data-testid="table-apis"><thead><tr><th>API</th><th>Versión</th><th>Tipo</th><th>Estado</th><th>Completitud</th></tr></thead><tbody>${filas}</tbody></table></div>`;
    main.querySelector("[data-testid=btn-sync-wso2]").onclick = async () => {
      const r = await api("POST", "/catalog/sync");
      aviso(`Catálogo sincronizado: ${r.data?.apis ?? 0} APIs (ensayo)`);
    };
  }

  async function ficha(main, id) {
    const { data: f } = await api("GET", `/apis/${encodeURIComponent(id)}`);
    if (!f) return (main.innerHTML = "<h1>No existe</h1>");
    const campo = (k, v) => `<tr><td style="width:180px;color:#5c6b7a">${k}</td><td>${esc(v)}</td></tr>`;
    main.innerHTML = `<h1>${esc(f.name)} ${esc(f.version)}</h1><p class="sub">Ficha del catálogo (ensayo).</p>
      <div class="tarjeta" data-testid="api-summary"><table>${campo("Propósito", f.purpose)}${campo("Propietario", `${f.ownerTeam} <${f.ownerContact}>`)}${campo("Contrato", f.contractRef)}${campo("Autenticación", f.authType)}${campo("Estado", f.state)}${campo("Completitud", `${f.completeness} %`)}</table></div>
      <div class="tarjeta"><button class="btn sec" data-testid="tab-consumidores">Consumidores</button> <button class="btn sec" data-testid="tab-dependencias">Dependencias</button><div id="pestana" style="margin-top:12px"></div></div>${relleno(14)}`;
    const pest = main.querySelector("#pestana");
    main.querySelector("[data-testid=tab-consumidores]").onclick = () =>
      (pest.innerHTML = `<table>${(f.consumers || []).map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.plan)}</td></tr>`).join("") || "<tr><td>Sin consumidores</td></tr>"}</table>`);
    main.querySelector("[data-testid=tab-dependencias]").onclick = () =>
      (pest.innerHTML = `<table>${(f.dependencies || []).map((d) => `<tr><td>${esc(d.relation)}</td><td>${esc(d.to)}</td></tr>`).join("") || "<tr><td>Sin dependencias</td></tr>"}</table>`);
  }

  async function dependencias(main) {
    const { data } = await api("GET", "/graph");
    const nodos = (data?.nodes || [])
      .map(
        (n, i) =>
          `<div data-testid="graph-node-${esc(n.id)}" style="position:absolute;left:${60 + (i % 3) * 300}px;top:${50 + Math.floor(i / 3) * 140}px;background:${n.kind === "flujo" ? "#e8f5e9" : "#e3ebf5"};border:1px solid #9fb3c8;border-radius:8px;padding:12px 16px;cursor:pointer;min-width:200px"><b>${esc(n.label)}</b><br><small>${esc(n.kind)}</small></div>`,
      )
      .join("");
    main.innerHTML = `<h1>Dependencias e impacto</h1><p class="sub">Grafo simulado del ensayo.</p><div class="tarjeta" data-testid="graph-canvas" style="position:relative;height:340px">${nodos}</div><div id="seleccion" class="tarjeta">Seleccione un nodo.</div>`;
    main.querySelectorAll("[data-testid^=graph-node-]").forEach((el) => (el.onclick = () => (main.querySelector("#seleccion").innerHTML = `Seleccionado: <b>${esc(el.textContent)}</b>`)));
  }

  async function fallidos(main) {
    const pintar = async () => {
      const { data } = await api("GET", "/dead-letters");
      const filas = (data || [])
        .map(
          (d) =>
            `<tr data-testid="dlq-row-${esc(d.id)}"><td><code>${esc(d.id.slice(0, 22))}…</code></td><td>${esc(d.error)}</td><td>${d.attempts}</td><td>${esc(d.status)}</td><td>${d.status === "pendiente" ? `<button class="btn" data-testid="btn-reprocess-${esc(d.id)}" data-id="${esc(d.id)}">Reprocesar</button>` : esc(d.reprocessedBy || "")}</td></tr>`,
        )
        .join("");
      main.innerHTML = `<h1>Mensajes fallidos</h1><p class="sub">Cola de fallidos del flujo SolicitudesConcesion (ensayo).</p>
        <div class="tarjeta"><table data-testid="table-dead-letters"><thead><tr><th>Mensaje</th><th>Error</th><th>Intentos</th><th>Estado</th><th></th></tr></thead><tbody>${filas || '<tr><td colspan="5">No hay mensajes con este estado</td></tr>'}</tbody></table></div>
        <div data-testid="reprocess-dialog" style="display:none" class="tarjeta"><h3>Reprocesar mensaje</h3><label for="motivo-r">Motivo</label><textarea id="motivo-r" data-testid="reprocess-dialog-reason" style="width:100%"></textarea>
        <p><button class="btn" data-testid="reprocess-dialog-confirm">Reprocesar</button></p></div>`;
      let elegido;
      main.querySelectorAll("[data-testid^=btn-reprocess-]").forEach(
        (b) =>
          (b.onclick = () => {
            elegido = b.dataset.id;
            main.querySelector("[data-testid=reprocess-dialog]").style.display = "block";
          }),
      );
      main.querySelector("[data-testid=reprocess-dialog-confirm]").onclick = async () => {
        await api("POST", `/dead-letters/${encodeURIComponent(elegido)}/reprocess`, { reason: main.querySelector("[data-testid=reprocess-dialog-reason]").value });
        aviso("Mensaje reprocesado (ensayo)");
        await pintar();
      };
    };
    await pintar();
  }

  async function consumo(main) {
    const hoy = new Date().toISOString().slice(0, 10);
    const pintar = async (g) => {
      const { data } = await api("GET", `/usage?from=${hoy}&to=${hoy}&groupBy=${g}`);
      main.querySelector("#tabla-uso").innerHTML = `<table><thead><tr><th>${g === "endpoint" ? "Endpoint" : "Consumidor"}</th><th>Llamadas</th><th>Errores</th></tr></thead><tbody>${(data || [])
        .map((f) => `<tr><td>${esc(f.label)}</td><td>${f.llamadas}</td><td>${f.errores}</td></tr>`)
        .join("")}</tbody></table>`;
    };
    main.innerHTML = `<h1>Consumo</h1><div data-testid="billing-disabled-notice" class="tarjeta" style="border-left:4px solid #1d4f91"><b>Medición sin facturación: los cobros están desactivados</b><br>Ensayo: valores simulados.</div>
      <div class="tarjeta"><label for="agrupar">Agrupar por</label> <select id="agrupar" data-testid="usage-group-by"><option value="consumer">Consumidor</option><option value="endpoint">Endpoint</option><option value="day">Día</option></select>
      <button class="btn" data-testid="btn-export-usage" style="margin-left:16px">Exportar CSV</button></div>
      <div class="tarjeta" id="tabla-uso"></div>${relleno(18)}`;
    main.querySelector("[data-testid=btn-export-usage]").onclick = () => descargar(`/api/v1/usage/export?from=${hoy}&to=${hoy}`, "consumo.csv");
    const sel = main.querySelector("[data-testid=usage-group-by]");
    sel.onchange = () => pintar(sel.value);
    await pintar("consumer");
  }

  function exportacion(main) {
    main.innerHTML = `<h1>Exportación</h1><p class="sub">Paquete con APIs, flujos, metadatos y configuración (ensayo).</p><div class="tarjeta"><button class="btn" data-testid="btn-create-export">Generar paquete</button><div id="estado-exp" style="margin-top:14px"></div></div>`;
    main.querySelector("[data-testid=btn-create-export]").onclick = async () => {
      main.querySelector("#estado-exp").textContent = "Generando…";
      const r = await api("POST", "/exports");
      setTimeout(() => {
        main.querySelector("#estado-exp").innerHTML = `Paquete listo: <button class="btn" data-testid="btn-download-export">Descargar paquete</button>`;
        main.querySelector("[data-testid=btn-download-export]").onclick = () => descargar(r.data?.downloadUrl, "nexo-export.zip");
      }, 1500);
    };
  }

  function dibujar() {
    const main = document.getElementById("contenido");
    const p = location.pathname;
    if (!main || !mia(p) || main.dataset.bt0x === p) return;
    main.dataset.bt0x = p;
    if (p === "/catalogo") return catalogo(main);
    if (p.startsWith("/catalogo/")) return ficha(main, decodeURIComponent(p.split("/")[2]));
    if (p === "/dependencias") return dependencias(main);
    if (p === "/mensajes-fallidos") return fallidos(main);
    if (p === "/consumo") return consumo(main);
    if (p === "/exportacion") return exportacion(main);
  }

  const iniciar = () => {
    new MutationObserver(() => dibujar()).observe(document.body, { childList: true, subtree: true });
    dibujar();
  };
  if (document.body) iniciar();
  else document.addEventListener("DOMContentLoaded", iniciar);
})();
