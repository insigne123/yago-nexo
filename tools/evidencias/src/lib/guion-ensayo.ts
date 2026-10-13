/**
 * Guion propio del motor (solo en modo ensayo): ejercita todas las capas sobre las páginas del servidor de
 * ensayo — escritura visible con clave enmascarada, lista desplegable, casilla, clic con recuadro y onda,
 * desplazamiento suave, ampliación que sigue al objetivo, panel con verificaciones en vivo, indicadores,
 * un despliegue simulado aprobado por otra persona, música y codificación. No demuestra ninguna capacidad
 * del producto: es la prueba del motor.
 *
 *   pnpm --filter @nexo/evidencias grabar --ensayo motor
 */
import type { Demo } from "./grabador.js";
import { consola, tokenPersona } from "./lab.js";

const AGENDA = [
  "Escritura visible con la clave oculta",
  "Lista desplegable, casilla y guardado",
  "Desplazamiento suave y ampliación que sigue al objetivo",
  "Despliegue simulado: aprobación y avance",
];

type Rollout = {
  id: string;
  status: string;
  currentWeight: number;
  stepsDone: Array<{ kind: string; weight: number }>;
};

export const guionMotor: Demo = {
  id: "MOTOR",
  archivo: "MOTOR_ensayo_del_motor",
  nombre: "Ensayo del motor de grabación",
  afirmacion:
    "Ensayo sin laboratorio: ejercita la captura, el cursor, el teclado visible, la lista desplegable, el desplazamiento, la ampliación en vivo, el panel y la música. No demuestra ninguna capacidad del producto.",
  pasos: AGENDA.length,
  agenda: AGENDA,
  usuarioInicial: "luis.aprobador",

  async preparar() {
    return [
      "servidor de ensayo local (sin laboratorio): páginas y respuestas simuladas",
      "sesión de luis.aprobador abierta en la Consola de ensayo",
    ];
  },

  async ejecutar(c) {
    const e = c.estudio;
    const u = c.app;

    await e.paso({
      titulo: AGENDA[0]!,
      quePasa:
        "La persona abre el formulario, escribe el nombre de la API y una clave. El teclado visible muestra cada letra; la clave se ve como puntos.",
      porQueImporta:
        "Quien mira el video debe poder seguir cada acción a ritmo humano, sin que se filtren secretos en pantalla.",
      comprueba: ["el campo recibe exactamente lo escrito", "el campo de la clave es de tipo contraseña"],
    });
    await c.ir("/ensayo/formulario");
    await u.getByTestId("ensayo-nombre").waitFor();
    await e.escribir(u.getByTestId("ensayo-nombre"), "Concesiones de ensayo");
    await e.escribir(u.getByTestId("ensayo-clave"), "clave-de-ensayo");
    const nombre = await u.getByTestId("ensayo-nombre").inputValue();
    e.comprueba("el campo recibe exactamente lo escrito", nombre === "Concesiones de ensayo", nombre);
    e.comprueba(
      "el campo de la clave es de tipo contraseña",
      (await u.getByTestId("ensayo-clave").getAttribute("type")) === "password",
      "type=password",
    );

    await e.paso({
      titulo: AGENDA[1]!,
      quePasa:
        "Se despliega la lista de audiencias con sus opciones reales, se elige «Operadores», se marca la casilla y se guarda.",
      porQueImporta:
        "Las listas nativas no aparecen en una captura sin interfaz: el motor las dibuja con sus opciones reales para que se vea qué se eligió.",
      comprueba: ["la audiencia quedó en «operadores»", "aparece el aviso de guardado"],
    });
    await e.elegir(u.getByTestId("ensayo-audiencia"), "Operadores");
    await e.marcar(u.getByTestId("ensayo-acepta"));
    await e.clic(u.getByTestId("ensayo-guardar"));
    const aviso = u.getByTestId("ensayo-guardado");
    await aviso.waitFor({ timeout: 5000 });
    e.comprueba(
      "la audiencia quedó en «operadores»",
      (await u.getByTestId("ensayo-audiencia").inputValue()) === "operadores",
      await u.getByTestId("ensayo-audiencia").inputValue(),
    );
    e.comprueba("aparece el aviso de guardado", await aviso.isVisible(), (await aviso.textContent()) ?? "");

    await e.paso({
      titulo: AGENDA[2]!,
      quePasa:
        "La página baja suavemente hasta el final del inventario; luego se amplía la tabla en vivo y la ampliación sigue al cursor.",
      porQueImporta:
        "La ampliación hace legible el detalle sin editar la imagen: es la misma pantalla en vivo, con minimapa e insignia.",
      comprueba: ["el final del inventario queda a la vista"],
    });
    await e.desplazar(u.getByTestId("ensayo-fin"));
    await e.zoom(u.getByTestId("ensayo-tabla").locator("tbody tr").nth(30));
    await e.mover(u.getByTestId("ensayo-tabla").locator("tbody tr").nth(38));
    await e.mover(u.getByTestId("ensayo-fin"));
    await e.esperar(1200);
    e.comprueba(
      "el final del inventario queda a la vista",
      await u.getByTestId("ensayo-fin").isVisible(),
      "40 filas",
    );
    await e.desplazar(-3000);

    await e.paso({
      titulo: AGENDA[3]!,
      quePasa:
        "ana.desarrollo solicita un despliegue canary (simulado) y luis.aprobador lo aprueba en la Consola; el peso avanza 5 → 25 → 50 → 100 %.",
      porQueImporta:
        "Ejercita la regla de cuatro ojos y las esperas largas con indicadores en vivo, como en los videos reales.",
      comprueba: ["el despliegue simulado termina completado"],
    });
    const dev = await tokenPersona("ana.desarrollo");
    const apr = await tokenPersona("luis.aprobador");
    const r = await consola<Rollout>(dev, "POST", "/rollouts", {
      strategy: "canary",
      candidateEndpoint: "http://concesiones-v2:7001",
      shadowSeconds: 3,
      steps: [5, 25, 50, 100],
      stepDurationSec: 2,
    });
    c.log(`$ POST /api/v1/rollouts  (ana.desarrollo)  canary 1.1.0 · sombra 3 s · pasos de 2 s`, "cmd");
    await c.ir(`/despliegues/${r.data.id}`);
    await u.getByTestId("rollout-pending").waitFor();
    await e.clic(u.getByTestId("btn-approve-rollout"));
    c.log("aprobado por luis.aprobador (quien solicita no aprueba)", "tenue");
    let fin: Rollout | undefined;
    for (let i = 0; i < 30; i++) {
      fin = (await consola<Rollout>(apr, "GET", `/rollouts/${r.data.id}`)).data;
      e.indicadores({
        estado: fin.status,
        "peso de 1.1.0": `${fin.currentWeight} %`,
        "pasos cumplidos": fin.stepsDone.length,
      });
      if (fin.status !== "en_curso") break;
      await c.esperar(1000);
    }
    await u
      .getByTestId("rollout-completed")
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined);
    await e.zoom(u.getByTestId("rollout-weight"), { ms: 2200 });
    const plan =
      fin?.stepsDone.map((s) => (s.kind === "sombra" ? "sombra" : `${s.weight} %`)).join(" → ") ?? "";
    e.comprueba("el despliegue simulado termina completado", fin?.status === "completado", plan);
    return {
      medido: `ensayo del motor: ${c.verificaciones.filter((v) => v.ok).length} verificaciones en vivo, despliegue simulado ${plan}`,
      datos: { ensayo: true },
    };
  },
};
