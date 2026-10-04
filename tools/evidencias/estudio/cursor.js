// Se inyecta en el navegador operado: dibuja el puntero (Chromium sin interfaz no lo muestra en el
// screencast) y un destello en cada clic, para que en el video se vea dónde actúa el guion.
(() => {
  if (window.top !== window) return;
  const montar = () => {
    if (document.getElementById("__nexo-cursor")) return;
    const d = document.createElement("div");
    d.id = "__nexo-cursor";
    d.style.cssText =
      "position:fixed;left:-50px;top:-50px;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;" +
      "border:2px solid #e8364f;background:rgba(232,54,79,.22);pointer-events:none;z-index:2147483647;" +
      "box-shadow:0 0 0 2px rgba(255,255,255,.8);transition:transform .12s ease-out";
    document.documentElement.appendChild(d);
    const pos = JSON.parse(sessionStorage.getItem("__nexoCursor") || "null");
    if (pos) {
      d.style.left = `${pos[0]}px`;
      d.style.top = `${pos[1]}px`;
    }
    addEventListener(
      "mousemove",
      (e) => {
        d.style.left = `${e.clientX}px`;
        d.style.top = `${e.clientY}px`;
        try {
          sessionStorage.setItem("__nexoCursor", JSON.stringify([e.clientX, e.clientY]));
        } catch {
          /* sin almacenamiento */
        }
      },
      true,
    );
    addEventListener("mousedown", () => (d.style.transform = "scale(1.7)"), true);
    addEventListener("mouseup", () => (d.style.transform = "scale(1)"), true);
  };
  if (document.documentElement) montar();
  else document.addEventListener("DOMContentLoaded", montar);
  document.addEventListener("DOMContentLoaded", montar);
})();
