// Página narradora del estudio: recibe el estado por Server-Sent Events y muestra en vivo la pantalla
// del navegador operado (MJPEG). No inventa datos: todo lo que muestra lo envía el guion en ejecución.
(() => {
  const $ = (id) => document.getElementById(id);
  const ZONA = "America/Santiago";
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
  const tic = () => {
    $("b-reloj").textContent = `${reloj.format(new Date())} · ${ZONA} (${desfase()})`;
    const s = Math.max(0, Math.floor((Date.now() - inicio) / 1000));
    $("r-tiempo").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  setInterval(tic, 250);
  tic();

  const MAX = 400;
  const lineas = $("t-lineas");
  function agregar({ texto, tipo, hora }) {
    for (const parte of String(texto).split("\n")) {
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
    while (lineas.childElementCount > MAX) lineas.firstElementChild.remove();
  }

  let imgIniciada = false;
  function aplicar(e) {
    if (e.vista) document.body.dataset.vista = e.vista;
    if (e.inicio) inicio = e.inicio;
    if (e.banner) {
      $("b-producto").textContent = e.banner.producto;
      $("b-ambiente").textContent = e.banner.ambiente;
    }
    if (e.portada) {
      $("p-id").textContent = e.portada.id;
      $("p-nombre").textContent = e.portada.nombre;
      $("p-version").textContent = e.portada.version;
      $("p-fecha").textContent = e.portada.fecha;
      $("p-ambiente").textContent = e.portada.ambiente;
      $("p-afirmacion").textContent = e.portada.afirmacion;
    }
    if (e.rotulo) {
      $("r-paso").textContent = e.rotulo.paso ?? "";
      $("r-texto").textContent = e.rotulo.texto ?? "";
    }
    if (e.monitor) {
      $("m-url").textContent = e.monitor.url ?? "";
      if (!imgIniciada && e.monitor.activo) {
        $("m-img").src = "/__estudio/monitor.mjpg";
        imgIniciada = true;
      }
    }
    if (e.terminal) $("t-titulo").textContent = e.terminal.titulo ?? "Salida del escenario";
    if (e.panel !== undefined) $("panel-cuerpo").innerHTML = e.panel ?? "";
    if (e.resultado) {
      const r = e.resultado;
      $("resultado").classList.toggle("fallo", !r.ok);
      $("r-sobretitulo").textContent = r.sobretitulo ?? "Resultado medido";
      $("r-titulo").textContent = r.titulo;
      $("r-medido").textContent = r.medido;
      const ul = $("r-verificaciones");
      ul.innerHTML = "";
      for (const v of r.verificaciones ?? []) {
        const li = document.createElement("li");
        if (!v.ok) li.className = "mal";
        li.textContent = v.texto;
        ul.appendChild(li);
      }
      $("r-nota").textContent = r.nota ?? "";
    }
  }

  const fuente = new EventSource("/__estudio/eventos");
  fuente.onmessage = (m) => aplicar(JSON.parse(m.data));
  fuente.addEventListener("linea", (m) => agregar(JSON.parse(m.data)));
  fuente.addEventListener("limpiar", () => (lineas.innerHTML = ""));
  window.__estudioListo = true;
})();
