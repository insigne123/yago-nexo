import EstadoBadge from "@site/src/components/EstadoBadge";
import { capacidades, conteoPorEstado, ESTADOS } from "@site/src/data/estado";
import type { ReactNode } from "react";

import styles from "./styles.module.css";

/** Conteo de capacidades por estado, calculado desde capacidades.json. */
export default function ResumenEstados(): ReactNode {
  const conteo = conteoPorEstado();
  return (
    <p className={styles.resumen}>
      <span className={styles.total}>{capacidades.length} capacidades:</span>
      {ESTADOS.map((estado) => (
        <span key={estado} className={styles.item}>
          <EstadoBadge estado={estado} /> <strong>{conteo[estado]}</strong>
        </span>
      ))}
    </p>
  );
}
