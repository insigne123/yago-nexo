// Páginas de ensayo (V09) de los guiones D-01, D-02, D-04 y D-05: imitan, con los mismos data-testid que la
// Consola real, las pantallas de Descubrimiento, Anomalías y Continuidad y la tarjeta «Endpoint estable» del
// detalle de un despliegue. Los datos vienen del servidor de ensayo (simulados). Se inyecta como script de
// inicio en el contexto del navegador solo con `grabar --ensayo`; todo lleva el rótulo ENSAYO. No es la Consola.
(() => {
  if (location.port !== "5173") return;
  const esc = (t) =>
    String(t ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const api = async (metodo, ruta, cuerpo) => {
    const r = await fetch(`/api/v1${ruta}`, {
      method: metodo,
      headers: {
        authorization: `Bearer ${sessionStorage.getItem("ensayo-token") || ""}`,
        ...(cuerpo ? { "content-type": "application/json" } : {}),
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const yo = () => sessionStorage.getItem("ensayo-usuario") || "";
  const estilo = `
    .d0x-fila { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .d0x-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
    .d0x-grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 14px; }
    .d0x-caja { background: #fff; border: 1px solid #d5dbe3; border-radius: 8px; padding: 12px 14px; }
    .d0x-caja small { color: #5f6b7a; display: block; font-size: 12px; }
    .d0x-caja b { font-size: 20px; }
    .d0x-dialogo { position: fixed; inset: 0; background: rgba(15,23,32,.45); display: none; align-items: center; justify-content: center; z-index: 50; }
    .d0x-dialogo.abierto { display: flex; }
    .d0x-dialogo > div { background: #fff; border-radius: 10px; padding: 20px 24px; width: 520px; box-shadow: 0 10px 30px rgba(0,0,0,.25); }
    .d0x-tabs { display: flex; gap: 6px; margin-bottom: 12px; }
    .d0x-tabs button { border: 1px solid #c7d0db; background: #fff; padding: 7px 14px; border-radius: 6px; cursor: pointer; font-size: 14px; }
    .d0x-tabs button[aria-selected=true] { background: #1d4f91; color: #fff; border-color: #1d4f91; }
    .d0x-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; background: #e8edf3; }
    .d0x-badge.bien { background: #dff3e4; color: #1b6b34; } .d0x-badge.mal { background: #fde2e1; color: #a12622; } .d0x-badge.aviso { background: #fff1d6; color: #8a5a00; }
    .d0x-barras { display: flex; gap: 6px; align-items: flex-end; height: 120px; padding-top: 8px; }
    .d0x-barras i { display: block; width: 34px; background: #1d4f91; border-radius: 3px 3px 0 0; }
    #d0x-rule-form { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; } #d0x-rule-form .campo { margin: 4px 0; } #rule-dialog > div { width: 640px; }
    textarea { width: 100%; box-sizing: border-box; font: 14px/1.4 monospace; padding: 8px; border: 1px solid #b8c2cc; border-radius: 4px; }
  `;
  const dialogo = (id, titulo, cuerpo) =>
    `<div class="d0x-dialogo" id="${id}" data-testid="${id}"><div><h3 style="margin-top:0">${esc(titulo)}</h3>${cuerpo}</div></div>`;
  const abrirDlg = (id) => document.getElementById(id)?.classList.add("abierto");
  const cerrarDlg = (id) => document.getElementById(id)?.classList.remove("abierto");
  const pintar = (html) => {
    const main = document.getElementById("contenido");
    if (!main) return false;
    main.innerHTML = `<style>${estilo}</style>${html}`;
    return true;
  };
  const sondeos = [];
  const cada = (ms, fn) => {
    fn();
    sondeos.push(setInterval(fn, ms));
  };

  // ── Descubrimiento (D-01) ─────────────────────────────────────────────────────────────────────────
  function descubrimiento() {
    if (
      !pintar(`<div class="d0x-fila"><h1 style="margin:0">Descubrimiento de APIs</h1><span style="flex:1"></span>
        <button class="btn sec" data-testid="btn-download-discovery-report">Descargar reporte</button>
        <button class="btn" data-testid="btn-new-scan">Nuevo escaneo</button></div>
        <p class="sub">D-01 · Endpoints del perímetro que no están en el catálogo gobernado (simulación de ensayo).</p>
        <div class="d0x-grid"><div class="d0x-caja" data-testid="kpi-ungoverned"><small>No gobernados</small><b id="d0x-nog">—</b></div>
          <div class="d0x-caja"><small>Riesgo alto</small><b id="d0x-alto">—</b></div><div class="d0x-caja"><small>Endpoints</small><b id="d0x-total">—</b></div>
          <div class="d0x-caja"><small>Último escaneo</small><b id="d0x-ultimo" style="font-size:15px">—</b></div></div>
        <div class="tarjeta"><h3 style="margin-top:0">Escaneos</h3><table data-testid="table-scans"><thead><tr><th>Id</th><th>Estado</th><th>Solicitó</th></tr></thead><tbody id="d0x-scans"></tbody></table></div>
        <div class="tarjeta"><h3 style="margin-top:0">Hallazgos</h3><table data-testid="table-findings"><thead><tr><th>Puntaje</th><th>Fuente</th><th>Endpoint</th><th>Autenticación</th><th>Datos personales</th><th>Catálogo</th></tr></thead><tbody id="d0x-hallazgos"></tbody></table></div>
        ${dialogo(
          "scan-dialog",
          "Nuevo escaneo",
          `<form data-testid="scan-form" id="d0x-scan-form"><fieldset style="border:0;padding:0"><legend>Fuentes</legend>
            ${["apisix", "nginx", "red"].map((s) => `<label style="margin-right:14px"><input type="checkbox" id="scan-source-${s}" data-testid="scan-source-${s}" ${s === "red" ? "" : "checked"} style="width:auto"> ${s === "red" ? "Red autorizada" : s.toUpperCase()}</label>`).join("")}</fieldset>
            <div class="campo"><label for="scan-targets">Direcciones de la red autorizada (una por línea)</label><textarea id="scan-targets" data-testid="scan-targets" rows="4"></textarea></div>
            <button class="btn" type="submit" data-testid="btn-start-scan">Iniciar escaneo</button></form>`,
        )}`)
    )
      return;
    document.querySelector("[data-testid=btn-new-scan]").onclick = () => abrirDlg("scan-dialog");
    // Descarga como la Consola: pedido con la sesión y archivo desde un blob.
    document.querySelector("[data-testid=btn-download-discovery-report]").onclick = async () => {
      const r = await fetch("/api/v1/discovery/report?format=csv", {
        headers: { authorization: `Bearer ${sessionStorage.getItem("ensayo-token") || ""}` },
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await r.blob());
      a.download = "reporte-exposicion.csv";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1000);
    };
    document.getElementById("d0x-scan-form").onsubmit = async (e) => {
      e.preventDefault();
      await api("POST", "/discovery/scans", {
        sources: ["apisix", "nginx", "red"],
        targets: document.getElementById("scan-targets").value.split("\n"),
      });
      cerrarDlg("scan-dialog");
    };
    cada(1500, async () => {
      const [s, h] = await Promise.all([api("GET", "/discovery/scans"), api("GET", "/discovery/findings")]);
      const scans = s.data || [];
      document.getElementById("d0x-scans").innerHTML =
        scans
          .map(
            (x) =>
              `<tr><td>${esc(x.id)}</td><td><span class="estado ${x.status}" data-testid="scan-status-${esc(x.id)}">${esc(x.status)}</span></td><td>${esc(x.requestedBy)}</td></tr>`,
          )
          .join("") || '<tr><td colspan="3">Sin escaneos.</td></tr>';
      const t = scans[0]?.totals;
      if (t) {
        document.getElementById("d0x-nog").textContent = t.noGobernados;
        document.getElementById("d0x-alto").textContent = t.riesgoAlto;
        document.getElementById("d0x-total").textContent = t.endpoints;
        document.getElementById("d0x-ultimo").textContent = scans[0].status;
      }
      document.getElementById("d0x-hallazgos").innerHTML =
        (h.data || [])
          .map(
            (f) =>
              `<tr><td><span class="d0x-badge ${f.exposureScore >= 70 ? "mal" : f.exposureScore >= 40 ? "aviso" : ""}" data-testid="finding-score-${esc(f.id)}">${f.exposureScore}</span></td><td>${esc(f.source)}</td><td><code>${esc(f.host)}${f.port ? `:${f.port}` : ""}${esc(f.path)}</code></td><td>${esc(f.authDetected)}</td><td>${f.personalDataSuspected ? "sí" : "no"}</td><td>${f.matchedApiId ? "ligado a API gobernada" : "no gobernada"}</td></tr>`,
          )
          .join("") || '<tr><td colspan="6">Sin hallazgos todavía.</td></tr>';
    });
  }

  // ── Anomalías (D-02) ──────────────────────────────────────────────────────────────────────────────
  function anomalias() {
    const pestana = new URLSearchParams(location.search).get("pestana") || "eventos";
    if (
      !pintar(`<h1>Anomalías de consumo</h1><p class="sub">D-02 · El guardián compara cada consumidor con su línea base (simulación de ensayo).</p>
        <div class="d0x-tabs" role="tablist">${[
          ["eventos", "Eventos"],
          ["bloqueos", "Bloqueos activos"],
          ["reglas", "Reglas"],
        ]
          .map(
            ([id, l]) =>
              `<button role="tab" data-testid="tab-${id}" data-p="${id}" aria-selected="${id === pestana}">${l}</button>`,
          )
          .join("")}</div>
        <div class="tarjeta" data-p="eventos"><table data-testid="table-anomalies"><thead><tr><th>Consumidor</th><th>Métrica</th><th>Observado</th><th>Línea base</th><th>Puntaje</th><th>Estado</th></tr></thead><tbody id="d0x-anom"></tbody></table></div>
        <div class="tarjeta" data-p="bloqueos"><table data-testid="table-blocks"><thead><tr><th>Consumidor bloqueado</th><th>Vence</th><th>Estado</th><th></th></tr></thead><tbody id="d0x-bloq"></tbody></table></div>
        <div class="tarjeta" data-p="reglas"><button class="btn" data-testid="btn-new-rule">Nueva regla</button><table data-testid="table-rules" style="margin-top:12px"><thead><tr><th>Regla</th><th>Métrica</th><th>Acción</th><th>Activa</th></tr></thead><tbody id="d0x-reglas"></tbody></table></div>
        ${dialogo(
          "rule-dialog",
          "Nueva regla de anomalías",
          `<form data-testid="rule-form" id="d0x-rule-form">
            <div class="campo"><label for="rule-name">Nombre</label><input id="rule-name" data-testid="rule-name"></div>
            <div class="campo"><label for="rule-api">API</label><select id="rule-api" data-testid="rule-api"><option value="">Todas las APIs</option><option value="wso2-concesiones">Concesiones 1.0.0</option></select></div>
            <div class="campo"><label for="rule-metric">Métrica</label><select id="rule-metric" data-testid="rule-metric"><option value="volumen">Volumen de llamadas</option><option value="errores">Tasa de errores</option><option value="latencia">Latencia</option><option value="tamano">Tamaño de respuestas</option></select></div>
            <div class="campo"><label for="rule-sensitivity">Sensibilidad: <output id="d0x-sens">3</output></label><input id="rule-sensitivity" data-testid="rule-sensitivity" type="range" min="1" max="10" step="0.5" value="3"></div>
            <div class="campo"><label for="rule-min-volume">Volumen mínimo</label><input id="rule-min-volume" type="number" value="20"></div>
            <div class="campo"><label for="rule-action">Acción</label><select id="rule-action" data-testid="rule-action"><option value="alertar">Solo alertar</option><option value="bloquear_con_aprobacion">Bloquear con aprobación</option><option value="bloquear_automatico">Bloquear automáticamente</option></select></div>
            <div class="campo"><label for="rule-ttl">Duración del bloqueo (minutos)</label><input id="rule-ttl" type="number" value="10"></div>
            <button class="btn" type="submit" data-testid="btn-save-rule">Guardar regla</button></form>`,
        )}
        ${dialogo("release-dialog", "Liberar el bloqueo", `<div class="campo"><label for="release-dialog-reason">Motivo</label><textarea id="release-dialog-reason" data-testid="release-dialog-reason" rows="3"></textarea></div><button class="btn" data-testid="release-dialog-confirm">Liberar</button>`)}`)
    )
      return;
    const mostrar = (id) => {
      document
        .querySelectorAll(".tarjeta[data-p]")
        .forEach((t) => (t.style.display = t.dataset.p === id ? "block" : "none"));
      document
        .querySelectorAll("[role=tab]")
        .forEach((b) => b.setAttribute("aria-selected", String(b.dataset.p === id)));
      history.replaceState({}, "", `/anomalias?pestana=${id}`);
    };
    document.querySelectorAll("[role=tab]").forEach((b) => (b.onclick = () => mostrar(b.dataset.p)));
    mostrar(pestana);
    const sens = document.getElementById("rule-sensitivity");
    sens.oninput = () => (document.getElementById("d0x-sens").textContent = sens.value);
    document.querySelector("[data-testid=btn-new-rule]").onclick = () => abrirDlg("rule-dialog");
    document.getElementById("d0x-rule-form").onsubmit = async (e) => {
      e.preventDefault();
      await api("POST", "/anomaly-rules", {
        name: document.getElementById("rule-name").value,
        apiId: document.getElementById("rule-api").value || undefined,
        metric: document.getElementById("rule-metric").value,
        sensitivity: Number(sens.value),
        minVolume: Number(document.getElementById("rule-min-volume").value),
        action: document.getElementById("rule-action").value,
        blockTtlMinutes: Number(document.getElementById("rule-ttl").value),
        enabled: true,
      });
      cerrarDlg("rule-dialog");
    };
    let liberar;
    document.querySelector("[data-testid=release-dialog-confirm]").onclick = async () => {
      if (liberar)
        await api("POST", `/blocks/${liberar}/release`, {
          reason: document.getElementById("release-dialog-reason").value,
        });
      cerrarDlg("release-dialog");
    };
    cada(1500, async () => {
      const [a, b, r] = await Promise.all([
        api("GET", "/anomalies"),
        api("GET", "/blocks"),
        api("GET", "/anomaly-rules"),
      ]);
      document.getElementById("d0x-anom").innerHTML =
        (a.data || [])
          .map(
            (x) =>
              `<tr><td>${esc(x.consumer)}</td><td>${esc(x.metric || "volumen")}</td><td>${Math.round(x.observed)}</td><td>${Math.round(x.baseline)}</td><td>${x.score}</td><td><span class="d0x-badge mal">${esc(x.status)}</span></td></tr>`,
          )
          .join("") || '<tr><td colspan="6">Sin eventos.</td></tr>';
      const tb = document.getElementById("d0x-bloq");
      tb.innerHTML =
        (b.data || [])
          .filter((x) => x.active)
          .map(
            (x) =>
              `<tr><td>${esc(x.conditionValue)}</td><td>${esc(new Date(x.expiresAt).toLocaleTimeString("es-CL"))}</td><td><span class="d0x-badge mal">activo</span></td><td><button class="btn sec" data-testid="btn-release-${esc(x.id)}" data-id="${esc(x.id)}">Liberar</button></td></tr>`,
          )
          .join("") || '<tr><td colspan="4">Sin bloqueos activos.</td></tr>';
      tb.querySelectorAll("button[data-id]").forEach(
        (btn) => (btn.onclick = () => ((liberar = btn.dataset.id), abrirDlg("release-dialog"))),
      );
      document.getElementById("d0x-reglas").innerHTML =
        (r.data || [])
          .map(
            (x) =>
              `<tr><td>${esc(x.name)}</td><td>${esc(x.metric)}</td><td>${esc(x.action)}</td><td>${x.enabled ? "sí" : "no"}</td></tr>`,
          )
          .join("") || '<tr><td colspan="4">Sin reglas.</td></tr>';
    });
  }

  // ── Continuidad (D-05) ────────────────────────────────────────────────────────────────────────────
  function continuidad() {
    if (
      !pintar(`<div class="d0x-fila"><h1 style="margin:0">Continuidad operacional</h1><span style="flex:1"></span><span id="d0x-acciones"></span></div>
        <p class="sub">D-05 · Tres agentes votan la salud del sitio principal; se conmuta con 2 de 3 votos (simulación de ensayo).</p>
        <div class="d0x-grid"><div class="d0x-caja" data-testid="active-site"><small>Sitio activo</small><b id="d0x-activo">—</b><div id="d0x-activo-nota" style="font-size:12px;color:#8a5a00"></div></div>
          <div class="d0x-caja" data-testid="quorum"><small>Quórum</small><b>2 de 3</b><div id="d0x-votos" style="font-size:12px;color:#5f6b7a"></div></div>
          <div class="d0x-caja"><small>Objetivos</small><div style="font-size:14px">RTO 15 min · RPO 1 min</div><div style="font-size:12px;color:#5f6b7a">El RPO no se mide en esta versión.</div></div>
          <div class="d0x-caja"><small>Modo de conmutación</small><b id="d0x-modo" data-testid="continuity-mode" style="font-size:16px">—</b></div></div>
        <div id="d0x-pendiente"></div>
        <div class="d0x-grid3" id="d0x-sitios"></div>
        <h3>Historial de conmutaciones y simulacros</h3><ol data-testid="failover-events" id="d0x-eventos" style="padding-left:18px"></ol>
        ${dialogo("failback-request-dialog", "Solicitar el retorno al sitio principal", `<div class="campo"><label for="failback-request-dialog-reason">Motivo</label><textarea id="failback-request-dialog-reason" data-testid="failback-request-dialog-reason" rows="3"></textarea></div><button class="btn" data-testid="failback-request-dialog-confirm">Solicitar retorno</button>`)}
        ${dialogo("failback-dialog", "Aprobar el retorno al sitio principal", `<div class="campo"><label for="failback-dialog-reason">Comentario (opcional)</label><textarea id="failback-dialog-reason" data-testid="failback-dialog-reason" rows="2"></textarea></div><button class="btn" data-testid="failback-dialog-confirm">Aprobar retorno</button>`)}`)
    )
      return;
    let pendiente;
    document.querySelector("[data-testid=failback-request-dialog-confirm]").onclick = async () => {
      await api("POST", "/continuity/failback/requests", {
        reason: document.getElementById("failback-request-dialog-reason").value,
      });
      cerrarDlg("failback-request-dialog");
    };
    document.querySelector("[data-testid=failback-dialog-confirm]").onclick = async () => {
      if (pendiente)
        await api("POST", `/continuity/failback/requests/${pendiente.id}/approve`, {
          reason: document.getElementById("failback-dialog-reason").value || undefined,
        });
      cerrarDlg("failback-dialog");
    };
    let accionesClave = "";
    cada(1000, async () => {
      const [s, ev] = await Promise.all([api("GET", "/continuity"), api("GET", "/continuity/events")]);
      const st = s.data;
      if (!st) return;
      pendiente = st.pendingFailback;
      document.getElementById("d0x-activo").textContent =
        st.activeSite === "cpd" ? "CPD" : "GCP (Google Cloud)";
      document.getElementById("d0x-activo-nota").textContent =
        st.activeSite === "cpd"
          ? ""
          : pendiente
            ? "Operando en el respaldo. Retorno solicitado, falta la aprobación."
            : "Operando en el respaldo. El retorno no se ha solicitado.";
      const sanos = st.sites.filter((x) => x.vote === "primario_sano").length;
      document.getElementById("d0x-votos").textContent =
        `${sanos} votos «primario sano» · ${st.votosPrimarioCaido} «primario caído»`;
      document.getElementById("d0x-modo").textContent = st.mode === "automatico" ? "Automático" : "Manual";
      document.getElementById("d0x-sitios").innerHTML = st.sites
        .map(
          (
            x,
          ) => `<div class="d0x-caja" data-testid="continuity-site-${x.id}"><div class="d0x-fila"><b style="font-size:16px">${esc(x.name)}</b><small>${esc(x.role)}</small>${x.active ? `<span class="d0x-badge bien" data-testid="site-active-${x.id}">activo</span>` : ""}</div>
          <div style="margin-top:8px">Voto: <span class="d0x-badge ${x.vote === "primario_caido" ? "mal" : "bien"}" data-testid="site-vote-${x.id}">${x.vote === "primario_caido" ? "primario caído" : "primario sano"}</span></div></div>`,
        )
        .join("");
      document.getElementById("d0x-pendiente").innerHTML = pendiente
        ? `<div class="aviso pend" data-testid="pending-failback">Retorno al sitio principal solicitado por ${esc(pendiente.requestedBy)} · Motivo: ${esc(pendiente.reason)} · Debe aprobarlo otra persona con el rol aprobador.</div>`
        : "";
      const clave = `${st.activeSite}|${pendiente ? pendiente.requestedBy : ""}`;
      if (clave !== accionesClave) {
        accionesClave = clave;
        const acc = document.getElementById("d0x-acciones");
        acc.innerHTML = pendiente
          ? `<button class="btn sec" data-testid="btn-reject-failback">Rechazar retorno</button> <button class="btn" data-testid="btn-approve-failback" ${pendiente.requestedBy === yo() ? 'disabled title="Regla de cuatro ojos: usted solicitó este retorno"' : ""}>Aprobar retorno</button>`
          : `<button class="btn" data-testid="btn-request-failback" ${st.activeSite === "cpd" ? 'disabled title="El sitio principal ya está activo"' : ""}>Solicitar retorno</button>`;
        const pedir = acc.querySelector("[data-testid=btn-request-failback]");
        if (pedir) pedir.onclick = () => abrirDlg("failback-request-dialog");
        const aprobar = acc.querySelector("[data-testid=btn-approve-failback]");
        if (aprobar) aprobar.onclick = () => abrirDlg("failback-dialog");
      }
      document.getElementById("d0x-eventos").innerHTML = (ev.data || [])
        .map(
          (
            x,
          ) => `<li data-testid="failover-event-${esc(x.id)}" class="d0x-caja" style="margin-bottom:8px"><div class="d0x-fila"><b>${x.kind === "retorno" ? "Retorno" : "Conmutación"} ${esc(x.from)} → ${esc(x.to)}</b><span class="d0x-badge">${esc(x.trigger)}</span><span class="d0x-badge ${x.status === "completado" ? "bien" : "aviso"}" data-testid="failover-status-${esc(x.id)}">${esc(x.status)}</span>
          ${x.rtoSeconds ? `<span class="d0x-badge bien" data-testid="failover-rto-${esc(x.id)}">RTO ${String(x.rtoSeconds).replace(".", ",")} s</span>` : ""}<span class="d0x-badge" data-testid="failover-rpo-${esc(x.id)}">RPO no medido</span>${x.approvedBy ? `<small>pidió ${esc(x.requestedBy)} · aprobó ${esc(x.approvedBy)}</small>` : ""}</div></li>`,
        )
        .join("");
    });
  }

  // ── Detalle de un despliegue (D-04): tarjeta «Endpoint estable» y gráfico del peso ────────────────
  function detalleDespliegue(id) {
    const agregar = async () => {
      const main = document.getElementById("contenido");
      if (!main || document.getElementById("d0x-endpoints")) return;
      const tarjeta = document.createElement("div");
      tarjeta.id = "d0x-endpoints";
      tarjeta.className = "tarjeta";
      tarjeta.innerHTML =
        "<style>" +
        estilo +
        "</style><div class='d0x-grid' id='d0x-endpoints-grid'></div><h3 style='margin:6px 0 0'>Peso en el tiempo</h3><div class='d0x-barras' data-testid='chart-weight' id='d0x-barras'></div>";
      const ancla = main.querySelector(".tarjeta");
      if (ancla) ancla.after(tarjeta);
      else main.appendChild(tarjeta);
      const { data: r } = await api("GET", `/rollouts/${id}`);
      if (!r) return;
      const g = document.getElementById("d0x-endpoints-grid");
      if (g)
        g.innerHTML = `<div><dt><small>Endpoint candidato</small></dt><dd style="margin:0"><code>${esc(r.candidateEndpoint)}</code></dd></div><div><dt>Endpoint estable</dt><dd style="margin:0"><code>${esc(r.stableEndpoint)}</code></dd></div>
          <div><dt><small>Plan de pasos</small></dt><dd style="margin:0">${(r.steps || []).map((s) => `${s} %`).join(" → ")}</dd></div><div><dt><small>Aprobado por</small></dt><dd style="margin:0">${esc(r.approvedBy || "Sin aprobación")}</dd></div>`;
      const b = document.getElementById("d0x-barras");
      if (b)
        b.innerHTML =
          (r.stepsDone || [])
            .map(
              (s) =>
                `<i title="${s.weight} %" style="height:${Math.max(4, s.weight * 1.1)}px;background:${s.decision === "revierte" ? "#c62828" : "#1d4f91"}"></i>`,
            )
            .join("") + `<i style="height:${Math.max(4, (r.currentWeight || 0) * 1.1)}px;opacity:.5"></i>`;
    };
    new MutationObserver(() => void agregar()).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function iniciar() {
    sondeos.splice(0).forEach(clearInterval);
    const p = location.pathname;
    if (p === "/descubrimiento") descubrimiento();
    else if (p === "/anomalias") anomalias();
    else if (p === "/continuidad") continuidad();
    else {
      const m = /^\/despliegues\/([^/]+)$/.exec(p);
      if (m) detalleDespliegue(m[1]);
    }
  }
  document.addEventListener("DOMContentLoaded", () => setTimeout(iniciar, 0));
})();
