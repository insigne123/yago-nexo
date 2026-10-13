import { DESCRIPCION_ESTADO, ETIQUETA_ESTADO, type Estado } from "@site/src/data/estado";
import clsx from "clsx";
import type { ReactNode } from "react";

import styles from "./styles.module.css";

/** Insignia de estado: texto + forma + color (no depende solo del color). */
export default function EstadoBadge({ estado }: { estado: Estado }): ReactNode {
  return (
    <span
      className={clsx(
        styles.badge,
        estado === "Incluida" && styles.incluida,
        estado === "Servicio" && styles.servicio,
      )}
      title={DESCRIPCION_ESTADO[estado]}
    >
      {ETIQUETA_ESTADO[estado]}
    </span>
  );
}
