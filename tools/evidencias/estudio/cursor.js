// Capa del puntero (V02) que se inyecta en el navegador operado. Chromium sin interfaz no dibuja el puntero
// en el screencast; esta capa lo dibuja dentro de la página (por eso también se ve en las ampliaciones):
//   - flecha de 28 px con halo amarillo, que sigue los eventos reales del mouse;
//   - recorridos suaves: el motor (src/lib/trayectoria.ts) calcula los puntos y aquí solo se reproducen;
//   - recuadro del objetivo antes del clic y onda en cada mousedown real;
//   - desplazamiento suave del contenedor que corresponde;
//   - listas desplegables visibles: los <select> nativos no se dibujan en el screencast, así que se
//     muestran sus opciones reales en una lista dibujada aquí mientras el motor elige la opción.
// La capa vive en un shadow DOM sin eventos de puntero ni texto: no altera la página ni su accesibilidad.
(() => {
  if (window.top !== window || window.__nexoCursor) return;
  const AMARILLO = "255, 205, 0";
  const CSS = `
    :host { all: initial; }
    .cursor { position: fixed; left: 0; top: 0; width: 0; height: 0; transform: translate(-80px, -80px); will-change: transform; }
    .halo { position: absolute; left: -23px; top: -23px; width: 46px; height: 46px; border-radius: 50%;
      background: radial-gradient(circle, rgba(${AMARILLO}, .55) 0%, rgba(${AMARILLO}, .32) 45%, rgba(${AMARILLO}, 0) 72%);
      box-shadow: 0 0 0 1.5px rgba(${AMARILLO}, .55); transition: transform .14s ease-out, background .14s; }
    .flecha { position: absolute; left: -2px; top: -2px; width: 20px; height: 28px; filter: drop-shadow(0 1.5px 2px rgba(0,0,0,.45)); }
    .cursor.presionado .halo { transform: scale(.78); background: radial-gradient(circle, rgba(${AMARILLO}, .8) 0%, rgba(${AMARILLO}, .45) 50%, rgba(${AMARILLO}, 0) 75%); }
    .cursor.presionado .flecha { transform: scale(.92); transform-origin: 2px 2px; }
    .onda { position: fixed; width: 14px; height: 14px; margin: -10px 0 0 -10px; border-radius: 50%;
      border: 3px solid rgba(${AMARILLO}, 1); box-shadow: 0 0 10px rgba(${AMARILLO}, .7);
      animation: onda .65s cubic-bezier(.2,.6,.3,1) forwards; }
    @keyframes onda { from { transform: scale(1); opacity: 1; } to { transform: scale(5.2); opacity: 0; } }
    .recuadro { position: fixed; border-radius: 9px; border: 3px solid rgb(${AMARILLO});
      box-shadow: 0 0 0 5px rgba(${AMARILLO}, .22), 0 0 22px rgba(${AMARILLO}, .55);
      opacity: 0; transition: opacity .18s ease-out; }
    .recuadro.visible { opacity: 1; }
    .lista { position: fixed; display: none; background: #fff; color: #1b2430; border: 1px solid #b9c4d0; border-radius: 6px;
      box-shadow: 0 10px 28px rgba(0,0,0,.28); overflow: hidden; font: 14px/1.2 system-ui, "Liberation Sans", sans-serif;
      transform-origin: top; animation: abrir .16s ease-out; }
    .lista.visible { display: block; }
    .lista div { padding: 0 12px; display: flex; align-items: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .lista div.actual { font-weight: 600; }
    .lista div.resaltada { background: #1d4f91; color: #fff; }
    @keyframes abrir { from { transform: scaleY(.85); opacity: 0; } to { transform: scaleY(1); opacity: 1; } }
  `;
  const FLECHA =
    '<svg class="flecha" viewBox="0 0 20 28" width="20" height="28"><path d="M2 2 L2 23 L7.2 18.1 L10.9 26.4 L14.7 24.8 L11.1 16.6 L18.2 16.6 Z" ' +
    'fill="#fff" stroke="#111" stroke-width="1.7" stroke-linejoin="round"/></svg>';

  const estado = { x: -80, y: -80, animando: false };
  let host, raiz, cursor, recuadro, lista;

  function guardar() {
    try {
      sessionStorage.setItem("__nexoCursor", JSON.stringify([estado.x, estado.y]));
    } catch {
      /* sin almacenamiento */
    }
  }

  function montar() {
    if (host && host.isConnected) return true;
    const padre = document.documentElement;
    if (!padre) return false;
    host = document.createElement("nexo-capa-cursor");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block;contain:layout style";
    raiz = host.attachShadow({ mode: "open" });
    try {
      const hoja = new CSSStyleSheet();
      hoja.replaceSync(CSS);
      raiz.adoptedStyleSheets = [hoja];
    } catch {
      const s = document.createElement("style");
      s.textContent = CSS;
      raiz.appendChild(s);
    }
    recuadro = document.createElement("div");
    recuadro.className = "recuadro";
    lista = document.createElement("div");
    lista.className = "lista";
    cursor = document.createElement("div");
    cursor.className = "cursor";
    cursor.innerHTML = `<div class="halo"></div>${FLECHA}`;
    raiz.append(recuadro, lista, cursor);
    padre.appendChild(host);
    if (estado.x < 0) {
      try {
        const p = JSON.parse(sessionStorage.getItem("__nexoCursor") || "null");
        if (p) [estado.x, estado.y] = p;
      } catch {
        /* sin almacenamiento */
      }
    }
    pintar();
    return true;
  }

  function pintar() {
    if (cursor) cursor.style.transform = `translate(${estado.x}px, ${estado.y}px)`;
  }

  function colocar(x, y) {
    montar();
    estado.x = x;
    estado.y = y;
    pintar();
    guardar();
  }

  // Reproduce una trayectoria [[x, y, t_ms], …] calculada por el motor. Resuelve al llegar.
  function recorrer(puntos) {
    montar();
    if (!puntos || !puntos.length) return Promise.resolve();
    estado.animando = true;
    const total = puntos[puntos.length - 1][2];
    return new Promise((ok) => {
      const t0 = performance.now();
      let i = 0;
      const cuadro = (ahora) => {
        const t = ahora - t0;
        while (i < puntos.length - 1 && puntos[i + 1][2] <= t) i++;
        if (t >= total || i >= puntos.length - 1) {
          const f = puntos[puntos.length - 1];
          colocar(f[0], f[1]);
          estado.animando = false;
          ok();
          return;
        }
        const a = puntos[i];
        const b = puntos[i + 1];
        const u = b[2] > a[2] ? (t - a[2]) / (b[2] - a[2]) : 1;
        estado.x = a[0] + (b[0] - a[0]) * u;
        estado.y = a[1] + (b[1] - a[1]) * u;
        pintar();
        requestAnimationFrame(cuadro);
      };
      requestAnimationFrame(cuadro);
    });
  }

  function marcarRecuadro(caja) {
    montar();
    if (!caja) {
      recuadro.classList.remove("visible");
      return;
    }
    const m = 6;
    Object.assign(recuadro.style, {
      left: `${caja.x - m}px`,
      top: `${caja.y - m}px`,
      width: `${caja.width + 2 * m}px`,
      height: `${caja.height + 2 * m}px`,
    });
    recuadro.classList.add("visible");
  }

  function onda(x, y) {
    if (!montar()) return;
    const o = document.createElement("div");
    o.className = "onda";
    o.style.left = `${x}px`;
    o.style.top = `${y}px`;
    raiz.appendChild(o);
    setTimeout(() => o.remove(), 700);
  }

  function desplazable(el) {
    const s = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
  }

  function contenedorDe(el) {
    while (el && el !== document.body && el !== document.documentElement) {
      if (desplazable(el)) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // Igual que duracionDesplazamiento() de src/lib/trayectoria.ts: 0,5 a 1,4 s según la distancia.
  const duracion = (dy) => (Math.abs(dy) < 2 ? 0 : Math.min(1400, Math.max(500, 450 + Math.abs(dy) * 0.9)));

  function animar(el, dy, ms) {
    const desde = el.scrollTop;
    const max = el.scrollHeight - el.clientHeight;
    const hasta = Math.max(0, Math.min(max, desde + dy));
    if (Math.abs(hasta - desde) < 1 || ms <= 0) {
      el.scrollTop = hasta;
      return Promise.resolve(hasta - desde);
    }
    return new Promise((ok) => {
      const t0 = performance.now();
      const cuadro = (ahora) => {
        const u = Math.min(1, (ahora - t0) / ms);
        const s = u * u * u * (10 - 15 * u + 6 * u * u);
        el.scrollTop = desde + (hasta - desde) * s;
        if (u < 1) requestAnimationFrame(cuadro);
        else ok(el.scrollTop - desde);
      };
      requestAnimationFrame(cuadro);
    });
  }

  // Desplazamiento suave del contenedor bajo (x, y) en dy píxeles. Devuelve lo desplazado.
  function desplazar(x, y, dy, ms) {
    return animar(contenedorDe(document.elementFromPoint(x, y)), dy, ms ?? duracion(dy));
  }

  // Lleva un elemento a la vista (en el tercio superior de su contenedor) con desplazamiento suave.
  function desplazarHasta(el, ms) {
    const c = contenedorDe(el.parentElement);
    const r = el.getBoundingClientRect();
    const raiz = c === document.scrollingElement || c === document.documentElement;
    const cr = raiz ? { top: 0, height: innerHeight } : c.getBoundingClientRect();
    if (r.top >= cr.top + 24 && r.bottom <= cr.top + cr.height - 24) return Promise.resolve(0);
    const destino = cr.top + Math.max(80, cr.height * 0.38 - r.height / 2);
    const dy = r.top - destino;
    return animar(c, dy, ms ?? duracion(dy));
  }

  // Lista desplegable visible con las opciones reales de un <select> (hasta 10, en una ventana que incluye la
  // opción `indice`). Devuelve la caja, el texto y el valor de cada opción mostrada.
  function desplegar(sel, indice) {
    montar();
    if (!sel || !sel.options) return [];
    const r = sel.getBoundingClientRect();
    const alto = Math.max(28, Math.min(40, r.height));
    const opciones = [...sel.options];
    const n = Math.min(opciones.length, 10);
    const desde = Math.max(0, Math.min(opciones.length - n, (indice ?? 0) - n + 1));
    const visibles = opciones.slice(desde, desde + n);
    const total = n * alto;
    const abajo = r.bottom + 2 + total <= innerHeight - 4 || r.top < total;
    const top = abajo ? r.bottom + 2 : r.top - 2 - total;
    const ancho = Math.max(r.width, 160);
    lista.innerHTML = "";
    const fuente = getComputedStyle(sel);
    lista.style.font = `${fuente.fontSize} ${fuente.fontFamily}`;
    visibles.forEach((o, i) => {
      const d = document.createElement("div");
      d.textContent = o.textContent;
      d.style.height = `${alto}px`;
      if (desde + i === sel.selectedIndex) d.className = "actual";
      lista.appendChild(d);
    });
    Object.assign(lista.style, { left: `${r.left}px`, top: `${top}px`, width: `${ancho}px` });
    lista.classList.add("visible");
    return visibles.map((o, i) => ({
      x: r.left,
      y: top + i * alto,
      width: ancho,
      height: alto,
      texto: o.textContent,
      valor: o.value,
      indice: desde + i,
    }));
  }

  function resaltar(i) {
    [...lista.children].forEach((d, j) => d.classList.toggle("resaltada", j === i));
  }

  function plegar() {
    lista.classList.remove("visible");
    lista.innerHTML = "";
  }

  addEventListener(
    "mousemove",
    (e) => {
      if (!estado.animando) colocar(e.clientX, e.clientY);
    },
    true,
  );
  addEventListener(
    "mousedown",
    (e) => {
      montar();
      cursor.classList.add("presionado");
      onda(e.clientX, e.clientY);
    },
    true,
  );
  addEventListener("mouseup", () => cursor && cursor.classList.remove("presionado"), true);

  window.__nexoCursor = {
    version: 2,
    colocar,
    recorrer,
    recuadro: marcarRecuadro,
    onda,
    desplazar,
    desplazarHasta,
    desplegar,
    resaltar,
    plegar,
    posicion: () => [estado.x, estado.y],
  };
  if (!montar()) document.addEventListener("DOMContentLoaded", montar, { once: true });
  // Algunas aplicaciones reemplazan el documento completo: se vuelve a montar si la capa desaparece.
  new MutationObserver(() => {
    if (host && !host.isConnected) montar();
  }).observe(document, { childList: true, subtree: false });
})();
