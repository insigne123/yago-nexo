// Consola de ensayo (V09): páginas mínimas con los mismos identificadores (data-testid) que usan los guiones
// en la Consola real, para iterar el motor de grabación sin laboratorio. Los datos vienen del servidor de
// ensayo (/api/v1, simulado) y todo lleva el rótulo ENSAYO. No es la Consola real.
(() => {
  const app = document.getElementById("app");
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const usuario = () => sessionStorage.getItem("ensayo-usuario");
  const api = async (metodo, ruta, cuerpo) => {
    const r = await fetch(`/api/v1${ruta}`, {
      method: metodo,
      headers: { authorization: `Bearer ${sessionStorage.getItem("ensayo-token") || ""}`, ...(cuerpo ? { "content-type": "application/json" } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const tokenDe = (u) => {
    const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    return `${b64({ alg: "none" })}.${b64({ preferred_username: u, ensayo: true })}.ensayo`;
  };

  // Retorno del inicio de sesión (Keycloak de ensayo).
  if (location.pathname === "/auth/callback") {
    const code = new URLSearchParams(location.search).get("code") || "";
    const u = code.replace(/^ensayo\./, "") || "persona";
    sessionStorage.setItem("ensayo-usuario", u);
    sessionStorage.setItem("ensayo-token", tokenDe(u));
    location.replace("/");
    return;
  }

  const NAV = [
    ["General", [["/", "Inicio"], ["/catalogo", "Catálogo"], ["/dependencias", "Dependencias e impacto"]]],
    [
      "Capacidades",
      [
        ["/descubrimiento", "Descubrimiento", "D-01"],
        ["/anomalias", "Anomalías", "D-02"],
        ["/contratos", "Contratos", "D-03"],
        ["/despliegues", "Despliegues", "D-04"],
        ["/continuidad", "Continuidad", "D-05"],
      ],
    ],
    ["Operación", [["/consumo", "Consumo"], ["/auditoria", "Auditoría"], ["/exportacion", "Exportación"], ["/ensayo/formulario", "Formulario de ensayo"]]],
  ];

  function shell(contenido) {
    const ruta = location.pathname;
    const nav = NAV.map(
      ([g, items]) =>
        `<h6>${g}</h6>${items
          .map(([to, label, ref]) => {
            const activo = to === "/" ? ruta === "/" : ruta.startsWith(to);
            return `<a href="${to}" data-testid="nav-${to.split("/").filter(Boolean).join("-") || "inicio"}" class="${activo ? "activo" : ""}">${esc(label)}${ref ? `<span>${ref}</span>` : ""}</a>`;
          })
          .join("")}`,
    ).join("");
    app.innerHTML = `<div class="shell"><aside><div class="logo"><i></i><div><b>Consola Nexo</b><small>Yago Nexo · Gestión de APIs</small></div></div><nav>${nav}</nav></aside>
      <div class="principal"><header><span class="ensayo-pill" data-testid="environment-label">ENSAYO · datos simulados</span><span class="esp"></span>
      <span class="usuario">Sesión: <b data-testid="current-user">${esc(usuario())}</b></span><button class="btn sec" data-testid="btn-logout">Salir</button></header>
      <main id="contenido">${contenido}</main></div></div>`;
    app.querySelector("[data-testid=btn-logout]").onclick = () => {
      sessionStorage.removeItem("ensayo-usuario");
      location.href = `http://keycloak:8080/realms/nexo/protocol/openid-connect/logout?post_logout_redirect_uri=${encodeURIComponent(`${location.origin}/`)}`;
    };
  }

  function login() {
    app.innerHTML = `<div class="login"><div class="tarjeta"><span class="ensayo-pill">ENSAYO</span><h1 style="margin-top:14px">Consola Nexo</h1>
      <p class="sub">Inicie sesión con su cuenta institucional.</p><button class="btn" data-testid="btn-oidc-login">Ingresar con Keycloak</button></div></div>`;
    app.querySelector("[data-testid=btn-oidc-login]").onclick = () => {
      const q = new URLSearchParams({ client_id: "nexo-console", response_type: "code", scope: "openid", state: "ensayo", redirect_uri: `${location.origin}/auth/callback` });
      location.href = `http://keycloak:8080/realms/nexo/protocol/openid-connect/auth?${q}`;
    };
  }

  function inicio() {
    shell(`<h1>Inicio</h1><p class="sub">Resumen de la plataforma (valores simulados del ensayo).</p>
      <div class="kpis"><div class="kpi"><small>APIs gobernadas</small><b>24</b></div><div class="kpi"><small>Llamadas última hora</small><b>18.240</b></div>
      <div class="kpi"><small>Errores 5xx</small><b>0,02 %</b></div><div class="kpi"><small>Despliegues en curso</small><b id="kpi-despliegues">0</b></div></div>
      <div class="tarjeta"><h3 style="margin-top:0">Actividad reciente</h3><table><thead><tr><th>Hora</th><th>Evento</th><th>Persona</th></tr></thead><tbody>
      ${["Despliegue aprobado", "Contrato validado", "Regla de anomalías creada", "Exportación generada", "API publicada"]
        .map((e, i) => `<tr><td>10:${String(12 + i * 7).padStart(2, "0")}</td><td>${e}</td><td>${["luis.aprobador", "ana.desarrollo", "admin.nexo"][i % 3]}</td></tr>`)
        .join("")}</tbody></table></div>`);
  }

  async function despliegues() {
    const { data } = await api("GET", "/rollouts");
    const filas = (data || [])
      .map((r) => `<tr><td><a href="/despliegues/${r.id}">${esc(r.id)}</a></td><td>${esc(r.apiName)}</td><td>${esc(r.strategy)}</td><td><span class="estado ${r.status}">${esc(r.status)}</span></td><td>${r.currentWeight} %</td></tr>`)
      .join("");
    shell(`<h1>Despliegues</h1><p class="sub">Canary y blue-green con reversión automática (simulación de ensayo).</p>
      <div class="tarjeta"><button class="btn" data-testid="btn-new-rollout">Nuevo despliegue</button>
      <form id="nuevo" style="display:none;margin-top:16px">
        <div class="campo"><label for="estrategia">Estrategia</label><select id="estrategia" name="estrategia" data-testid="rollout-strategy">
          <option value="canary">Canary (5 → 25 → 50 → 100 %)</option><option value="blue_green">Blue-green (todo de una vez)</option></select></div>
        <div class="campo"><label for="candidato">Versión candidata</label><select id="candidato" data-testid="rollout-candidate">
          <option value="http://concesiones-v2:7001">Concesiones 1.1.0 (concesiones-v2)</option><option value="http://concesiones-v1:7001">Concesiones 1.0.0 (concesiones-v1)</option></select></div>
        <div class="campo"><label for="sombra">Fase sombra (segundos)</label><input id="sombra" data-testid="rollout-shadow" value="10"></div>
        <div class="campo"><label for="motivo">Motivo del cambio</label><input id="motivo" data-testid="rollout-reason" placeholder="Describa el cambio"></div>
        <button class="btn" type="submit" data-testid="btn-create-rollout">Solicitar despliegue</button></form></div>
      <div class="tarjeta"><table data-testid="rollouts-table"><thead><tr><th>Id</th><th>API</th><th>Estrategia</th><th>Estado</th><th>Peso</th></tr></thead><tbody>${filas || '<tr><td colspan="5">Sin despliegues todavía.</td></tr>'}</tbody></table></div>`);
    const form = document.getElementById("nuevo");
    app.querySelector("[data-testid=btn-new-rollout]").onclick = () => (form.style.display = "block");
    form.onsubmit = async (e) => {
      e.preventDefault();
      const r = await api("POST", "/rollouts", {
        strategy: form.estrategia.value,
        candidateEndpoint: document.getElementById("candidato").value,
        shadowSeconds: Number(document.getElementById("sombra").value || 0),
        steps: [5, 25, 50, 100],
        stepDurationSec: 6,
      });
      if (r.status === 201) history.pushState({}, "", `/despliegues/${r.data.id}`), render();
    };
  }

  let sondeo;
  async function detalle(id) {
    const pintar = async () => {
      const { status, data: r } = await api("GET", `/rollouts/${id}`);
      if (status !== 200 || !r) return shell(`<h1>Despliegue ${esc(id)}</h1><p>No existe.</p>`);
      const avisos =
        r.status === "pendiente_aprobacion"
          ? `<div class="aviso pend" data-testid="rollout-pending">Pendiente de aprobación: lo solicitó ${esc(r.requestedBy)}; debe aprobarlo otra persona.</div>`
          : r.status === "revertido"
            ? `<div class="aviso mal" data-testid="rollback-banner">Revertido automáticamente: ${esc(r.rollbackReason)}</div>`
            : r.status === "completado"
              ? `<div class="aviso bien" data-testid="rollout-completed">Completado: la versión candidata recibe el 100 % del tráfico.</div>`
              : "";
      const pasos = (r.stepsDone || []).map((s) => `<tr><td>${s.kind}</td><td>${s.weight} %</td><td>${s.requests}</td><td>${Math.round(s.errorRate * 100)} %</td><td>${s.decision}</td></tr>`).join("");
      const html = `<h1>Despliegue ${esc(r.id)} <span class="estado ${r.status}">${esc(r.status)}</span></h1>
        <p class="sub">${esc(r.apiName)} · ${esc(r.strategy)} · candidata ${esc(r.candidateEndpoint)}</p>${avisos}
        <div class="tarjeta">${r.status === "pendiente_aprobacion" ? '<button class="btn" data-testid="btn-approve-rollout">Aprobar despliegue</button> <button class="btn sec" data-testid="btn-abort-rollout">Rechazar</button>' : ""}
        <h3>Peso de la versión candidata: <span data-testid="rollout-weight">${r.currentWeight} %</span></h3><div class="peso"><i style="width:${r.currentWeight}%"></i></div></div>
        <div class="tarjeta"><h3 style="margin-top:0">Pasos</h3><table><thead><tr><th>Fase</th><th>Peso</th><th>Llamadas</th><th>Errores</th><th>Decisión</th></tr></thead>
        <tbody>${pasos || '<tr><td colspan="5">Aún no hay pasos.</td></tr>'}</tbody></table></div>`;
      const main = document.getElementById("contenido");
      if (main) main.innerHTML = html;
      else shell(html);
      const aprobar = app.querySelector("[data-testid=btn-approve-rollout]");
      if (aprobar) aprobar.onclick = async () => (await api("POST", `/rollouts/${id}/approve`), pintar());
    };
    await pintar();
    clearInterval(sondeo);
    sondeo = setInterval(() => location.pathname === `/despliegues/${id}` && pintar(), 1000);
  }

  function formulario() {
    const filas = Array.from({ length: 40 }, (_, i) => `<tr><td>API-${String(i + 1).padStart(3, "0")}</td><td>${["Concesiones", "Tarifas", "Espectro", "Reclamos"][i % 4]} ${i + 1}</td><td>${(i * 37) % 900} ms</td><td>${["publicada", "en revisión", "obsoleta"][i % 3]}</td></tr>`).join("");
    shell(`<h1>Formulario de ensayo</h1><p class="sub">Página para ejercitar el motor: escritura, listas desplegables, casillas y desplazamiento.</p>
      <div class="tarjeta"><form id="f">
        <div class="campo"><label for="nombre">Nombre de la API</label><input id="nombre" data-testid="ensayo-nombre" placeholder="Ej.: Concesiones"></div>
        <div class="campo"><label for="clave">Clave de acceso</label><input id="clave" type="password" data-testid="ensayo-clave"></div>
        <div class="campo"><label for="audiencia">Audiencia</label><select id="audiencia" data-testid="ensayo-audiencia">
          <option value="interna">Interna</option><option value="operadores">Operadores</option><option value="publica">Pública</option><option value="socios">Socios</option></select></div>
        <div class="campo"><label><input type="checkbox" id="acepta" data-testid="ensayo-acepta" style="width:auto"> Acepto publicar el contrato</label></div>
        <button class="btn" type="submit" data-testid="ensayo-guardar">Guardar</button></form></div>
      <div class="tarjeta" data-testid="ensayo-tabla"><h3 style="margin-top:0">Inventario (simulado)</h3><table><thead><tr><th>Id</th><th>Nombre</th><th>p99</th><th>Estado</th></tr></thead><tbody>${filas}</tbody></table></div>
      <div class="tarjeta" data-testid="ensayo-fin"><b>Fin del inventario.</b> 40 APIs simuladas.</div>`);
    document.getElementById("f").onsubmit = (e) => {
      e.preventDefault();
      const t = document.createElement("div");
      t.className = "toast";
      t.dataset.testid = "ensayo-guardado";
      t.textContent = `Guardado: ${document.getElementById("nombre").value} · audiencia ${document.getElementById("audiencia").value}`;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 6000);
    };
  }

  function generica() {
    shell(`<h1>${esc(location.pathname)}</h1><p class="sub">Pantalla simulada del ensayo: el servidor de ensayo no imita esta página.</p>
      <div class="tarjeta"><table><thead><tr><th>Elemento</th><th>Valor</th></tr></thead><tbody>${Array.from({ length: 8 }, (_, i) => `<tr><td>Fila ${i + 1}</td><td>valor simulado ${i + 1}</td></tr>`).join("")}</tbody></table></div>`);
  }

  function render() {
    clearInterval(sondeo);
    if (!usuario()) return login();
    const p = location.pathname;
    if (p === "/") return inicio();
    if (p === "/despliegues") return despliegues();
    const m = /^\/despliegues\/([^/]+)$/.exec(p);
    if (m) return detalle(m[1]);
    if (p === "/ensayo/formulario") return formulario();
    return generica();
  }

  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href^='/']");
    if (!a) return;
    e.preventDefault();
    history.pushState({}, "", a.getAttribute("href"));
    render();
  });
  addEventListener("popstate", render);
  render();
})();
