import { describe, expect, it } from "vitest";
import { actualizarIndice, nombreBase, textoSumas, type Indice } from "./musica-mezclar.js";
import type { Publicacion } from "./video.js";

const indice: Indice = {
  $comment: "índice",
  generado: "2026-10-13T08:00:00.000Z",
  evidencias: [
    { id: "D-01", title: "Descubrimiento", file: "D-01_descubrimiento.mp4", sha256: "a".repeat(64) },
    { id: "D-02", title: "Anomalías", file: "D-02_anomalias.mp4", sha256: "b".repeat(64) },
  ],
};

describe("remezcla de la música", () => {
  it("reemplaza solo la entrada pedida y conserva el resto de sus campos", () => {
    const pub = {
      file: "D-02_anomalias.mp4",
      sha256: "c".repeat(64),
      music: { variant: 1 },
    } as unknown as Publicacion;
    const nuevo = actualizarIndice(
      { ...indice, evidencias: indice.evidencias.map((e) => ({ ...e, checks: [{ texto: "x", ok: true }] })) },
      "D-02",
      pub,
      "2026-10-13T09:00:00.000Z",
    );
    expect(nuevo.generado).toBe("2026-10-13T09:00:00.000Z");
    expect(nuevo.$comment).toBe("índice");
    expect(nuevo.evidencias[0]).toMatchObject({ id: "D-01", sha256: "a".repeat(64) });
    expect(nuevo.evidencias[1]).toMatchObject({
      id: "D-02",
      title: "Anomalías",
      sha256: "c".repeat(64),
      music: { variant: 1 },
      checks: [{ texto: "x", ok: true }],
    });
    expect(() => actualizarIndice(indice, "D-09", pub)).toThrow(/no está/);
  });

  it("SHA256SUMS.txt con el mismo formato que grabar.ts", () => {
    expect(textoSumas(indice.evidencias)).toBe(
      `${"a".repeat(64)}  D-01_descubrimiento.mp4\n${"b".repeat(64)}  D-02_anomalias.mp4\n`,
    );
  });

  it("nombre base del video", () => {
    expect(nombreBase("BT-005_publicar_proteger.mp4")).toBe("BT-005_publicar_proteger");
  });
});
