// Página narradora del estudio (lo único que se graba). Recibe el estado del guion por Server-Sent Events
// y muestra en vivo la pantalla del navegador operado (MJPEG del screencast de Chromium). No inventa datos:
// todo lo que aparece lo envía el guion en ejecución o lo mide el motor.
//
// Contrato con el diseño (index.html y estudio.css, de otro módulo):
//   - <body data-lienzo="1920x1080"> declara el diseño de 1920×1080; sin ese atributo se usa el modo de
//     compatibilidad (diseño anterior de 1280×720 escalado al lienzo, con un panel lateral mínimo).
//   - #m-img dentro de un contenedor que es el área visible de la pantalla operada: el motor ajusta la
//     ventana del navegador operado al tamaño de ese contenedor en cada vista (1 píxel = 1 píxel) y le
//     agrega la ampliación (insignia, minimapa) y el teclado visible.
//   - Ids que se llenan si existen (ver aplicar()): banner b-*, chip b-chip, portada p-*, panel lateral l-*,
//     capítulos c-*, resultado r-*, terminal t-*, panel libre panel-cuerpo.
//   - Cada cambio se emite también como evento de window: «estudio:estado» (detalle = cambios) y
//     «estudio:<tipo>» para los eventos puntuales (linea, limpiar, comprobado), y window.estudio.estado
//     guarda el estado completo, para que el diseño agregue lo que necesite sin tocar este archivo.
(() => {
  const $ = (id) => document.getElementById(id);
  const ZONA = "America/Santiago";
  const VISTAS = ["dividido", "app", "panel", "terminal", "terminal-panel", "panel-completo"];
  const estado = {};
  window.estudio = { estado };

  // ── Lienzo: diseño 1920×1080 o compatibilidad con el diseño anterior ─────────────────────────────────
  const declarado = (document.body.dataset.lienzo || "").split("x").map(Number);
  const compat = !(declarado[0] > 0);
  let escalaCompat = 1;
  if (compat && innerWidth > 1300) {
    escalaCompat = innerWidth / 1280;
    document.documentElement.style.zoom = String(escalaCompat);
  }

  // ── Reloj y tiempo transcurrido ──────────────────────────────────────────────────────────────────────
  const reloj = new Intl.DateTimeFormat("es-CL", {
    timeZone: ZONA,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const desfase = () =>
    new Intl.DateTimeFormat("en-US", { timeZone: ZONA, timeZoneName: "shortOffset" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")
      ?.value.replace("GMT", "UTC") ?? "";
  let inicio = Date.now();
  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  const texto = (id, t) => {
    const el = $(id);
    if (el && el.textContent !== t) el.textContent = t;
  };
  const tic = () => {
    texto("b-reloj", `${reloj.format(new Date())} · ${ZONA} (${desfase()})`);
    const s = Math.max(0, Math.floor((Date.now() - inicio) / 1000));
    texto("r-tiempo", mmss(s));
    texto("c-reloj", mmss(s));
    pintarCapitulos();
  };

  // ── Capa del motor: ENSAYO, chip del código, ampliación, minimapa, teclado ───────────────────────────
  const CSS_MOTOR = `
    #motor-ensayo { display: inline-flex; align-items: center; gap: 8px; flex: none; height: 20px; padding: 0 10px; border-radius: 10px;
      background: #c62828; color: #fff; font: bold 12.5px/1 "Liberation Sans", "DejaVu Sans", Arial, sans-serif; letter-spacing: .12em;
      white-space: nowrap; box-shadow: 0 0 0 2px rgba(198, 40, 40, .35); }
    #motor-ensayo small { font-weight: normal; letter-spacing: .02em; font-size: 11.5px; opacity: .95; }
    #motor-ensayo.suelto { position: fixed; z-index: 2147483000; top: 6px; left: 50%; transform: translateX(-50%); }
    #motor-ensayo-marca { position: fixed; inset: 0; z-index: 2147482999; pointer-events: none; overflow: hidden; }
    #motor-ensayo-marca span { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%) rotate(-24deg);
      font: bold 190px/1 "Liberation Sans", Arial, sans-serif; letter-spacing: .12em; color: rgba(198, 40, 40, .07); white-space: nowrap; }
    body.ensayo #banner { box-shadow: inset 0 -3px 0 #c62828; }
    #b-chip.motor-chip { display: inline-flex; align-items: center; height: 18px; padding: 0 8px; border-radius: 9px;
      background: rgba(90, 169, 255, .18); border: 1px solid rgba(90, 169, 255, .55); color: #cfe4ff;
      font: bold 11.5px/1 "DejaVu Sans Mono", monospace; letter-spacing: .04em; }
    .motor-pantalla { position: relative !important; overflow: hidden !important; }
    #m-img.motor-img { position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: contain; object-position: left top;
      transform-origin: 0 0; transition: transform .7s cubic-bezier(.65, 0, .35, 1); will-change: transform; }
    #motor-insignia { position: absolute; left: 14px; top: 12px; z-index: 5; display: flex; align-items: center; gap: 8px;
      padding: 6px 12px 6px 9px; border-radius: 16px; background: rgba(6, 16, 28, .86); color: #fff; border: 1px solid rgba(255, 205, 0, .75);
      font: 600 14px/1 "Liberation Sans", "DejaVu Sans", Arial, sans-serif; box-shadow: 0 3px 12px rgba(0,0,0,.35);
      opacity: 0; transform: translateY(-6px); transition: opacity .35s, transform .35s; pointer-events: none; }
    #motor-insignia svg { width: 16px; height: 16px; }
    #motor-insignia.visible, #motor-minimapa.visible { opacity: 1; transform: none; }
    #motor-minimapa { position: absolute; right: 14px; bottom: 14px; z-index: 5; padding: 5px; border-radius: 8px;
      background: rgba(6, 16, 28, .86); border: 1px solid rgba(255,255,255,.35); box-shadow: 0 4px 16px rgba(0,0,0,.4);
      opacity: 0; transform: translateY(6px); transition: opacity .35s, transform .35s; pointer-events: none; }
    #motor-minimapa canvas { display: block; border-radius: 4px; }
    #motor-minimapa p { margin: 4px 2px 0; color: #cfdced; font: 11px/1.2 "Liberation Sans", Arial, sans-serif; }
    #motor-teclado { position: absolute; left: 50%; bottom: 18px; z-index: 6; transform: translate(-50%, 8px); opacity: 0;
      display: flex; align-items: center; gap: 10px; max-width: 80%; padding: 8px 14px; border-radius: 12px;
      background: rgba(6, 16, 28, .9); color: #fff; border: 1px solid rgba(255,255,255,.28); box-shadow: 0 6px 20px rgba(0,0,0,.45);
      font: 16px/1.2 "DejaVu Sans Mono", monospace; transition: opacity .25s, transform .25s; pointer-events: none; white-space: nowrap; }
    #motor-teclado.visible { opacity: 1; transform: translate(-50%, 0); }
    #motor-teclado .icono { display: inline-flex; }
    #motor-teclado .campo { color: #9fb3c8; font: 13px/1.2 "Liberation Sans", Arial, sans-serif; }
    #motor-teclado .texto { overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
    #motor-teclado .texto bdi { direction: ltr; }
    #motor-teclado .caret { display: inline-block; width: 2px; height: 1.05em; margin-left: 1px; background: #ffcd00; vertical-align: -2px; animation: caret 1s steps(1) infinite; }
    #motor-teclado kbd { display: inline-block; min-width: 26px; padding: 3px 7px; border-radius: 5px; background: #f5f7fa; color: #1b2430;
      border-bottom: 3px solid #b6c0cc; font: bold 14px/1 "Liberation Sans", Arial, sans-serif; text-align: center; }
    #motor-teclado kbd.pulsada { background: #ffcd00; border-bottom-color: #b08d00; }
    @keyframes caret { 50% { opacity: 0; } }
    #motor-lateral { position: absolute; z-index: 4; background: #0f1d30; border: 1px solid #23405f; border-radius: 8px; padding: 12px 14px;
      color: #e8eef6; font: 13.5px/1.35 "Liberation Sans", "DejaVu Sans", Arial, sans-serif; overflow: hidden; display: none; }
    body[data-vista="dividido"] #motor-lateral, body[data-vista="panel"] #motor-lateral { display: block; }
    #motor-lateral #l-paso { color: #5aa9ff; font-weight: bold; text-transform: uppercase; letter-spacing: .08em; font-size: 12px; }
    #motor-lateral #l-titulo { margin: 4px 0 8px; font-size: 16px; font-weight: bold; }
    #motor-lateral h4 { margin: 8px 0 2px; color: #9fb3c8; font-size: 11.5px; text-transform: uppercase; letter-spacing: .08em; }
    #motor-lateral p { margin: 0; }
    #motor-lateral ul { margin: 0; padding: 0; list-style: none; }
    #motor-lateral li { margin: 2px 0; }
    #l-comprobado li { color: #3fcf8e; } #l-comprobado li.mal { color: #ff6b6b; }
    #l-comprobado li.nuevo { animation: nuevo 1.2s ease-out; }
    @keyframes nuevo { from { background: rgba(63, 207, 142, .3); } to { background: transparent; } }
  `;
  const estilo = document.createElement("style");
  estilo.textContent = CSS_MOTOR;
  document.head.appendChild(estilo);

  const img = $("m-img");
  const pantalla = img ? img.parentElement : null;
  let insignia, minimapa, mini, teclado;
  if (img && pantalla) {
    img.classList.add("motor-img");
    pantalla.classList.add("motor-pantalla");
    insignia = document.createElement("div");
    insignia.id = "motor-insignia";
    insignia.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="#ffcd00" stroke-width="2.4" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21M10.5 7.5v6M7.5 10.5h6"/></svg><span></span>';
    minimapa = document.createElement("div");
    minimapa.id = "motor-minimapa";
    minimapa.innerHTML = "<canvas></canvas><p>Vista completa · el recuadro es lo ampliado</p>";
    mini = minimapa.querySelector("canvas");
    teclado = document.createElement("div");
    teclado.id = "motor-teclado";
    pantalla.append(insignia, minimapa, teclado);
  }

  // Rótulo ENSAYO (V09): en el banner (sin tapar nada) y como marca de agua tenue sobre todo el cuadro.
  function asegurarEnsayo(activo) {
    if (!activo) {
      $("motor-ensayo")?.remove();
      $("motor-ensayo-marca")?.remove();
      return;
    }
    if ($("motor-ensayo")) return;
    const a = document.createElement("span");
    a.id = "motor-ensayo";
    a.innerHTML = "ENSAYO <small>sin laboratorio · no es evidencia · no se publica</small>";
    const banner = $("banner");
    const ancla = $("b-chip") || banner?.querySelector(".marca");
    if (ancla) ancla.after(a);
    else if (banner) banner.prepend(a);
    else {
      a.classList.add("suelto");
      document.body.appendChild(a);
    }
    const b = document.createElement("div");
    b.id = "motor-ensayo-marca";
    b.innerHTML = "<span>ENSAYO</span>";
    document.body.appendChild(b);
  }

  function asegurarChip(id) {
    let chip = $("b-chip");
    if (!chip) {
      const banner = $("banner");
      if (!banner) return;
      chip = document.createElement("span");
      chip.id = "b-chip";
      chip.className = "motor-chip";
      const marca = banner.querySelector(".marca");
      if (marca) marca.after(chip);
      else banner.prepend(chip);
      const pill = $("motor-ensayo");
      if (pill && pill.parentElement === banner) chip.after(pill);
    }
    chip.textContent = id || "";
    chip.style.display = id ? "" : "none";
  }

  // Panel lateral mínimo solo en modo de compatibilidad (el diseño de 1920×1080 trae el suyo).
  function asegurarLateralCompat() {
    if (!compat || $("l-titulo")) return;
    const principal = $("principal");
    if (!principal) return;
    const l = document.createElement("section");
    l.id = "motor-lateral";
    l.style.cssText = "left:882px;top:10px;width:388px;max-height:330px;";
    l.innerHTML =
      '<div id="l-paso"></div><div id="l-titulo"></div><h4>Qué está pasando</h4><p id="l-que"></p>' +
      '<h4>Por qué importa</h4><p id="l-porque"></p><h4>Se comprueba</h4><ul id="l-se-comprueba"></ul><h4>Comprobado</h4><ul id="l-comprobado"></ul>';
    principal.appendChild(l);
  }

  // ── Ampliación en vivo (V05) ────────────────────────────────────────────────────────────────────────
  let zoom = { activo: false };
  function aplicarZoom(z) {
    zoom = z || { activo: false };
    if (!img || !pantalla) return;
    if (!zoom.activo || !zoom.ventana || !zoom.vista) {
      img.style.transform = "translate(0px, 0px) scale(1)";
      insignia?.classList.remove("visible");
      minimapa?.classList.remove("visible");
      return;
    }
    const cw = pantalla.clientWidth;
    const ch = pantalla.clientHeight;
    const s0 = Math.min(cw / zoom.vista.width, ch / zoom.vista.height);
    const f = zoom.ventana.factor;
    const tx = -zoom.ventana.x * s0 * f;
    const ty = -zoom.ventana.y * s0 * f;
    img.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${f})`;
    insignia.querySelector("span").textContent = zoom.insignia || "Ampliación · imagen en vivo";
    insignia.classList.add("visible");
    const ancho = 236;
    mini.width = ancho;
    mini.height = Math.round((ancho * zoom.vista.height) / zoom.vista.width);
    minimapa.classList.add("visible");
    pintarMinimapa();
  }
  function pintarMinimapa() {
    if (!zoom.activo || !mini || !zoom.vista) return;
    const ctx = mini.getContext("2d");
    try {
      ctx.drawImage(img, 0, 0, zoom.vista.width, zoom.vista.height, 0, 0, mini.width, mini.height);
    } catch {
      ctx.fillStyle = "#dfe6ee";
      ctx.fillRect(0, 0, mini.width, mini.height);
    }
    ctx.fillStyle = "rgba(6, 16, 28, .45)";
    const k = mini.width / zoom.vista.width;
    const v = zoom.ventana;
    ctx.fillRect(0, 0, mini.width, v.y * k);
    ctx.fillRect(0, (v.y + v.height) * k, mini.width, mini.height);
    ctx.fillRect(0, v.y * k, v.x * k, v.height * k);
    ctx.fillRect((v.x + v.width) * k, v.y * k, mini.width, v.height * k);
    ctx.strokeStyle = "#ffcd00";
    ctx.lineWidth = 2.5;
    ctx.strokeRect(v.x * k, v.y * k, v.width * k, v.height * k);
  }
  setInterval(pintarMinimapa, 200);

  // ── Teclado visible (V02) ───────────────────────────────────────────────────────────────────────────
  let ocultarTeclado;
  function aplicarTeclado(t) {
    if (!teclado) return;
    clearTimeout(ocultarTeclado);
    if (!t || !t.activo) {
      ocultarTeclado = setTimeout(() => teclado.classList.remove("visible"), 900);
      return;
    }
    teclado.innerHTML = "";
    const icono = document.createElement("span");
    icono.className = "icono";
    icono.innerHTML =
      '<svg viewBox="0 0 24 16" width="26" height="18" fill="none" stroke="#ffcd00" stroke-width="1.6"><rect x="1" y="1" width="22" height="14" rx="2.5"/>' +
      '<path d="M5 5h1M9 5h1M13 5h1M17 5h2M5 8.5h1M9 8.5h1M13 8.5h1M17 8.5h2M7 12h10" stroke-linecap="round"/></svg>';
    teclado.appendChild(icono);
    if (t.campo) {
      const c = document.createElement("span");
      c.className = "campo";
      c.textContent = t.campo;
      teclado.appendChild(c);
    }
    if (t.tecla) {
      const k = document.createElement("kbd");
      k.className = "pulsada";
      k.textContent = t.tecla;
      teclado.appendChild(k);
    } else {
      const s = document.createElement("span");
      s.className = "texto";
      const bdi = document.createElement("bdi");
      bdi.textContent = t.texto || "";
      s.appendChild(bdi);
      const caret = document.createElement("i");
      caret.className = "caret";
      s.appendChild(caret);
      teclado.appendChild(s);
    }
    teclado.classList.add("visible");
  }

  // ── Terminal ─────────────────────────────────────────────────────────────────────────────────────────
  const MAX = 400;
  const lineas = $("t-lineas");
  const ultimas = [];
  function agregar({ texto: t, tipo, hora }) {
    for (const parte of String(t).split("\n")) {
      ultimas.push({ texto: parte, tipo, hora });
      if (ultimas.length > 8) ultimas.shift();
      if (!lineas) continue;
      const div = document.createElement("div");
      if (tipo) div.className = tipo;
      if (hora) {
        const h = document.createElement("span");
        h.className = "hora";
        h.textContent = `${hora} `;
        div.appendChild(h);
      }
      div.appendChild(document.createTextNode(parte));
      lineas.appendChild(div);
    }
    if (lineas) while (lineas.childElementCount > MAX) lineas.firstElementChild.remove();
    const mini8 = $("l-terminal");
    if (mini8) {
      mini8.innerHTML = "";
      for (const l of ultimas) {
        const d = document.createElement("div");
        if (l.tipo) d.className = l.tipo;
        d.textContent = l.texto;
        mini8.appendChild(d);
      }
    }
  }

  // ── Panel lateral, capítulos y comprobaciones (V04/V07: el diseño decide cómo se ven) ──────────────
  function lista(id, items, clase) {
    const ul = $(id);
    if (!ul) return;
    ul.innerHTML = "";
    for (const it of items || []) {
      const li = document.createElement("li");
      if (clase) li.className = clase(it);
      li.textContent = typeof it === "string" ? it : it.texto;
      ul.appendChild(li);
    }
  }
  function textoComprobado(c) {
    return `${c.ok ? "✓" : "✗"} ${c.texto}${c.valor !== undefined && c.valor !== "" ? `: ${c.valor}` : ""}`;
  }
  function aplicarPaso(p) {
    if (!p) return;
    texto("l-paso", p.n ? `Paso ${p.n} de ${p.total}` : "");
    texto("l-titulo", p.titulo || "");
    texto("l-que", p.quePasa || "");
    texto("l-porque", p.porQueImporta || "");
    lista("l-se-comprueba", p.comprueba || []);
    const ul = $("l-comprobado");
    if (ul) {
      ul.innerHTML = "";
      for (const c of p.comprobado || []) agregarComprobado(c, false);
    }
    document.body.dataset.paso = String(p.n || 0);
  }
  function agregarComprobado(c, nuevo = true) {
    const ul = $("l-comprobado");
    if (!ul) return;
    const li = document.createElement("li");
    li.className = `${c.ok ? "ok" : "mal"}${nuevo ? " nuevo" : ""}`;
    li.textContent = textoComprobado(c);
    ul.appendChild(li);
  }
  function aplicarIndicadores(ind) {
    const dl = $("l-indicadores");
    if (!dl) return;
    dl.innerHTML = "";
    for (const [k, v] of Object.entries(ind || {})) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = String(v);
      dl.append(dt, dd);
    }
  }
  function pintarCapitulos() {
    const barra = $("c-barra");
    const caps = estado.capitulos;
    if (!barra || !caps) return;
    const total = caps.total || (caps.agenda || []).length || 0;
    if (barra.childElementCount !== total) {
      barra.innerHTML = "";
      for (let i = 1; i <= total; i++) {
        const seg = document.createElement("span");
        seg.className = "c-seg";
        seg.dataset.n = String(i);
        seg.title = (caps.agenda || [])[i - 1] || "";
        const relleno = document.createElement("i");
        seg.appendChild(relleno);
        barra.appendChild(seg);
      }
    }
    const actual = caps.actual || 0;
    const minimo = caps.minimoS || 7;
    for (const seg of barra.children) {
      const n = Number(seg.dataset.n);
      seg.classList.toggle("hecho", n < actual);
      seg.classList.toggle("actual", n === actual);
      const relleno = seg.firstElementChild;
      let u = n < actual ? 1 : 0;
      if (n === actual && caps.inicioPaso) u = Math.min(0.97, (Date.now() - caps.inicioPaso) / 1000 / Math.max(minimo, caps.estimadoS || 20));
      if (relleno) relleno.style.width = `${(u * 100).toFixed(1)}%`;
    }
  }

  // ── Cierre: verificaciones en páginas de 6 ─────────────────────────────────────────────────────────
  let paginador;
  function aplicarResultado(r) {
    $("resultado")?.classList.toggle("fallo", !r.ok);
    texto("r-sobretitulo", r.sobretitulo ?? "Resultado medido");
    texto("r-titulo", r.titulo ?? "");
    texto("r-medido", r.medido ?? "");
    texto("r-nota", r.nota ?? "");
    const todas = r.verificaciones || [];
    const porPagina = r.porPagina || 6;
    const paginas = Math.max(1, Math.ceil(todas.length / porPagina));
    let pagina = 0;
    clearInterval(paginador);
    const mostrar = () => {
      lista("r-verificaciones", todas.slice(pagina * porPagina, (pagina + 1) * porPagina), (v) => (v.ok ? "" : "mal"));
      texto("r-pagina", paginas > 1 ? `Verificaciones ${pagina + 1} de ${paginas}` : "");
    };
    mostrar();
    if (paginas > 1) {
      const cada = Math.max(3000, ((r.segundos || 14) * 1000) / paginas);
      paginador = setInterval(() => {
        pagina = (pagina + 1) % paginas;
        mostrar();
      }, cada);
    }
  }

  // ── Estado ───────────────────────────────────────────────────────────────────────────────────────────
  let imgIniciada = false;
  function aplicar(e) {
    Object.assign(estado, e);
    if (e.vista) {
      document.body.dataset.vista = e.vista;
      if (e.vista !== "portada" && e.vista !== "resultado") aplicarZoom(zoom);
    }
    if (e.inicio) inicio = e.inicio;
    if (e.ensayo !== undefined) {
      document.body.classList.toggle("ensayo", !!e.ensayo);
      asegurarEnsayo(!!e.ensayo);
    }
    if (e.chip !== undefined) asegurarChip(e.chip);
    if (e.banner) {
      texto("b-producto", e.banner.producto ?? "");
      texto("b-ambiente", e.banner.ambiente ?? "");
      texto("b-commits", e.banner.commits ?? "");
    }
    if (e.portada) {
      const p = e.portada;
      texto("p-id", p.id ?? "");
      texto("p-nombre", p.nombre ?? "");
      texto("p-version", p.version ?? "");
      texto("p-fecha", p.fecha ?? "");
      texto("p-ambiente", p.ambiente ?? "");
      texto("p-afirmacion", p.afirmacion ?? "");
      texto("p-commits", p.commits ?? "");
      texto("p-capas", p.capas ? `Capas: ${p.capas.join(", ")}` : "");
      lista("p-agenda", p.agenda || []);
    }
    if (e.rotulo) {
      texto("r-paso", e.rotulo.paso ?? "");
      texto("r-texto", e.rotulo.texto ?? "");
    }
    if (e.paso) aplicarPaso(e.paso);
    if (e.indicadores) aplicarIndicadores(e.indicadores);
    if (e.capitulos) pintarCapitulos();
    if (e.zoom) aplicarZoom(e.zoom);
    if (e.teclado) aplicarTeclado(e.teclado);
    if (e.monitor) {
      texto("m-url", e.monitor.url ?? "");
      if (!imgIniciada && e.monitor.activo && img) {
        img.src = "/__estudio/monitor.mjpg";
        imgIniciada = true;
      }
    }
    if (e.terminal) texto("t-titulo", e.terminal.titulo ?? "Salida del escenario");
    if (e.panel !== undefined && $("panel-cuerpo")) $("panel-cuerpo").innerHTML = e.panel ?? "";
    if (e.resultado) aplicarResultado(e.resultado);
    window.dispatchEvent(new CustomEvent("estudio:estado", { detail: e }));
  }

  // ── Medidas: tamaño del área de pantalla en cada vista (la ventana operada se ajusta a esto) ─────────
  function medir() {
    const r = {};
    if (!pantalla) return r;
    const actual = document.body.dataset.vista;
    for (const v of VISTAS) {
      document.body.dataset.vista = v;
      // Con zoom CSS (modo de compatibilidad) getBoundingClientRect ya viene en píxeles del lienzo
      // (Chromium ≥ 128), que es lo que importa para que la ventana operada se vea 1:1.
      const b = pantalla.getBoundingClientRect();
      if (b.width > 80 && b.height > 80) r[v] = { ancho: Math.floor(b.width), alto: Math.floor(b.height) };
    }
    document.body.dataset.vista = actual;
    return r;
  }
  function informarMedidas() {
    const cuerpo = { vistas: medir(), lienzo: { ancho: innerWidth, alto: innerHeight }, compat, escala: escalaCompat };
    fetch("/__estudio/medidas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo) }).catch(() => undefined);
  }

  asegurarLateralCompat();
  setInterval(tic, 250);
  tic();
  const fuente = new EventSource("/__estudio/eventos");
  fuente.onmessage = (m) => aplicar(JSON.parse(m.data));
  fuente.addEventListener("linea", (m) => {
    const d = JSON.parse(m.data);
    agregar(d);
    window.dispatchEvent(new CustomEvent("estudio:linea", { detail: d }));
  });
  fuente.addEventListener("limpiar", () => {
    if (lineas) lineas.innerHTML = "";
    window.dispatchEvent(new CustomEvent("estudio:limpiar"));
  });
  fuente.addEventListener("comprobado", (m) => {
    const c = JSON.parse(m.data);
    if (estado.paso) (estado.paso.comprobado ||= []).push(c);
    agregarComprobado(c, true);
    window.dispatchEvent(new CustomEvent("estudio:comprobado", { detail: c }));
  });
  const listo = () => {
    informarMedidas();
    window.__estudioListo = true;
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(listo, listo);
  else listo();
})();
