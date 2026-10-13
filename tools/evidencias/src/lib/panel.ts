/**
 * Contenido del panel lateral, de la firma inferior y del cierre (V04, V07 y V10). Funciones puras: el
 * grabador las usa para publicar en la narradora lo que se ve, y las pruebas fijan sus reglas.
 *
 *   - «Se comprueba» une lo declarado en estudio.paso({ comprueba }) con lo verificado en vivo
 *     (estudio.comprueba): cada verificación real marca su línea declarada (✓ con el valor medido o ✗) o se
 *     agrega al final. Si no caben, se resumen primero las cumplidas más antiguas; una ✗ nunca se oculta.
 *   - Firma inferior: «Yago Nexo 1.2.0 · commit <producto> · herramientas <commit>».
 *   - Cierre: resumen «N de M verificaciones cumplidas» y las fallidas primero.
 */

export type EstadoComprobacion = "pendiente" | "ok" | "mal";

export interface ItemComprobacion {
  /** Identidad estable del renglón (para animar solo lo nuevo): «d<i>» declarado, «v<i>» en vivo. */
  clave: string;
  texto: string;
  estado: EstadoComprobacion;
  valor?: string;
}

export interface ListaComprobaciones {
  items: ItemComprobacion[];
  /** Verificaciones cumplidas que no caben (las más antiguas): se resumen en un renglón. */
  ocultasOk: number;
  /** Declaradas aún sin verificar que no caben. */
  ocultasPendientes: number;
}

export interface Viva {
  texto: string;
  ok: boolean;
  valor?: string | number;
}

/** Máximo de renglones de «Se comprueba» en el panel lateral de 1920×1080. */
export const MAX_COMPROBACIONES = 6;

/** Texto comparable: minúsculas, sin tildes, sin comillas ni puntuación final y con espacios simples. */
export function normalizar(t: string): string {
  return t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[«»"“”'‘’]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[\s.:;,]+$/, "")
    .trim();
}

const valorTexto = (v: string | number | undefined): string | undefined =>
  v === undefined || v === "" ? undefined : String(v);

/** Renglón unido con el índice de la última verificación en vivo que lo marcó (para saber cuándo llegó). */
interface ItemUnido extends ItemComprobacion {
  ultima?: number;
}

const limpio = ({ ultima: _u, ...it }: ItemUnido): ItemComprobacion => it;

/**
 * Une lo declarado con lo verificado en vivo, sin recortar. Orden: las declaradas en su orden (cada una se
 * marca cuando llega su verificación) y después las verificaciones que no estaban declaradas, en el orden en
 * que llegaron. Una verificación que se repite (mismo texto) actualiza su renglón: si alguna vez falló, queda ✗.
 */
function unir(declaradas: readonly string[], vivas: readonly Viva[]): ItemUnido[] {
  const items: ItemUnido[] = declaradas.map((texto, i) => ({
    clave: `d${i}`,
    texto,
    estado: "pendiente" as const,
  }));
  const porTexto = new Map<string, ItemUnido>();
  items.forEach((it) => porTexto.set(normalizar(it.texto), it));
  vivas.forEach((v, i) => {
    const k = normalizar(v.texto);
    const valor = valorTexto(v.valor);
    const existente = porTexto.get(k);
    if (existente) {
      existente.estado = existente.estado === "mal" || !v.ok ? "mal" : "ok";
      existente.ultima = i;
      if (valor !== undefined) existente.valor = valor;
      else delete existente.valor;
      return;
    }
    const it: ItemUnido = {
      clave: `v${i}`,
      texto: v.texto,
      estado: v.ok ? "ok" : "mal",
      ultima: i,
      ...(valor !== undefined ? { valor } : {}),
    };
    items.push(it);
    porTexto.set(k, it);
  });
  return items;
}

/** «Se comprueba» del paso en curso: lo declarado y lo verificado en vivo, recortado a `max` renglones. */
export function listaComprobaciones(
  declaradas: readonly string[],
  vivas: readonly Viva[],
  max = MAX_COMPROBACIONES,
): ListaComprobaciones {
  return recortar(unir(declaradas, vivas).map(limpio), Math.max(1, max));
}

/** Cuánto sigue a la vista una verificación cumplida del paso anterior, contado desde que llegó. */
export const ARRASTRE_MS = 6000;
/** Mínimo a la vista en el paso siguiente (aunque haya llegado hace más). */
export const ARRASTRE_MINIMO_MS = 3000;
/** Máximo de verificaciones cumplidas que se arrastran (las fallidas van todas). */
export const ARRASTRE_MAX = 3;

export interface Arrastre {
  /** Número del paso que se cerró. */
  n: number;
  items: ItemComprobacion[];
  /** Hasta cuándo se muestran (ms de reloj); sin valor: todo el paso siguiente (hay una ✗). */
  hastaMs?: number;
}

/**
 * Verificaciones del paso que se cierra que siguen a la vista al abrir el siguiente («Comprobado en el paso
 * N»). Sin esto, una verificación que llega justo antes de cambiar de paso (los guiones con c.paso(texto) no
 * esperan) aparecería y desaparecería en el mismo instante. Van las recientes (llegadas hace menos de
 * `ventanaMs`, a lo más `max`) y todas las fallidas, que se quedan durante todo el paso siguiente.
 * `llegadas[i]` es la hora en que llegó `vivas[i]`.
 */
export function arrastreAlCerrar(
  n: number,
  declaradas: readonly string[],
  vivas: readonly Viva[],
  llegadas: readonly number[],
  ahoraMs: number,
  o: { ventanaMs?: number; minimoMs?: number; max?: number } = {},
): Arrastre | undefined {
  const ventana = o.ventanaMs ?? ARRASTRE_MS;
  const llegada = (it: ItemUnido) =>
    it.ultima !== undefined ? (llegadas[it.ultima] ?? -Infinity) : -Infinity;
  const marcadas = unir(declaradas, vivas).filter((it) => it.estado !== "pendiente");
  const fallidas = marcadas.filter((it) => it.estado === "mal");
  const recientes = marcadas
    .filter((it) => it.estado === "ok" && llegada(it) + ventana > ahoraMs)
    .sort((a, b) => llegada(b) - llegada(a))
    .slice(0, Math.max(0, o.max ?? ARRASTRE_MAX))
    .reverse();
  if (!fallidas.length && !recientes.length) return undefined;
  const r: Arrastre = { n, items: [...fallidas, ...recientes].map(limpio) };
  if (!fallidas.length)
    r.hastaMs = Math.max(
      ahoraMs + (o.minimoMs ?? ARRASTRE_MINIMO_MS),
      Math.max(...recientes.map(llegada)) + ventana,
    );
  return r;
}

/**
 * Deja a lo más `max` renglones contando el renglón de resumen. Primero se resumen las cumplidas más
 * antiguas (ya se leyeron), después las declaradas pendientes del final; las fallidas nunca se ocultan.
 */
export function recortar(items: readonly ItemComprobacion[], max: number): ListaComprobaciones {
  const visibles = [...items];
  let ocultasOk = 0;
  let ocultasPendientes = 0;
  const lugar = () => max - (ocultasOk || ocultasPendientes ? 1 : 0);
  while (visibles.length > lugar()) {
    const i = visibles.findIndex((it) => it.estado === "ok");
    if (i >= 0) {
      visibles.splice(i, 1);
      ocultasOk++;
      continue;
    }
    let j = -1;
    for (let k = visibles.length - 1; k >= 0; k--) {
      if (visibles[k]!.estado === "pendiente") {
        j = k;
        break;
      }
    }
    if (j < 0) break; // solo quedan fallidas: se muestran todas
    visibles.splice(j, 1);
    ocultasPendientes++;
  }
  return { items: visibles, ocultasOk, ocultasPendientes };
}

/** Renglón de resumen de lo que no cabe (vacío si cabe todo). */
export function textoOcultas(l: Pick<ListaComprobaciones, "ocultasOk" | "ocultasPendientes">): string {
  const partes: string[] = [];
  if (l.ocultasOk) partes.push(`${l.ocultasOk} ${l.ocultasOk === 1 ? "cumplida" : "cumplidas"} antes ✓`);
  if (l.ocultasPendientes) partes.push(`${l.ocultasPendientes} más por comprobar`);
  return partes.length ? `+ ${partes.join(" · ")}` : "";
}

export interface DatosFirma {
  producto: string;
  version: string;
  commitProducto: string;
  commitHerramientas: string;
}

/** Firma inferior de cada cuadro (V10): producto, versión ofertada y los dos commits. */
export function textoFirma(f: DatosFirma): string {
  return `${f.producto} ${f.version} · commit ${f.commitProducto} · herramientas ${f.commitHerramientas}`;
}

export interface Resumen {
  cumplidas: number;
  total: number;
  fallidas: number;
  texto: string;
}

/** Resumen del cierre: «✓ 6 de 6 verificaciones cumplidas» o «✗ 1 de 6 verificaciones no se cumplió». */
export function resumenVerificaciones(vs: ReadonlyArray<{ ok: boolean }>): Resumen {
  const total = vs.length;
  const cumplidas = vs.filter((v) => v.ok).length;
  const fallidas = total - cumplidas;
  const pal = total === 1 ? "verificación" : "verificaciones";
  const texto = !total
    ? "Sin verificaciones registradas"
    : fallidas
      ? `✗ ${fallidas} de ${total} ${pal} ${fallidas === 1 ? "no se cumplió" : "no se cumplieron"}`
      : `✓ ${cumplidas} de ${total} ${pal} ${total === 1 ? "cumplida" : "cumplidas"}`;
  return { cumplidas, total, fallidas, texto };
}

/** Verificaciones para el cierre: las fallidas primero (nunca quedan fuera de la primera página). */
export function ordenCierre<T extends { ok: boolean }>(vs: readonly T[]): T[] {
  return [...vs.filter((v) => !v.ok), ...vs.filter((v) => v.ok)];
}
