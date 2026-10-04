import { DESCRIPCION_ESTADO, type Estado } from "@site/src/data/estado";
import clsx from "clsx";
import type { ReactNode } from "react";

import styles from "./styles.module.css";

/** Insignia de estado: texto + forma + color (no depende solo del color). */
export default function EstadoBadge({ estado }: { estado: Estado }): ReactNode {
  return (
    <span
      className={clsx(
        styles.badge,
        estado === "Disponible" && styles.disponible,
        estado === "En desarrollo" && styles.desarrollo,
        estado === "Planificado" && styles.planificado,
      )}
      title={DESCRIPCION_ESTADO[estado]}
    >
      {estado}
    </span>
  );
}
