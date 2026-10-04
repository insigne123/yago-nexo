import EstadoBadge from "@site/src/components/EstadoBadge";
import { DESCRIPCION_ESTADO, ESTADOS } from "@site/src/data/estado";
import type { ReactNode } from "react";

import styles from "./styles.module.css";

export default function LeyendaEstados(): ReactNode {
  return (
    <dl className={styles.leyenda} aria-label="Significado de los estados">
      {ESTADOS.map((estado) => (
        <div key={estado} className={styles.item}>
          <dt>
            <EstadoBadge estado={estado} />
          </dt>
          <dd>{DESCRIPCION_ESTADO[estado]}</dd>
        </div>
      ))}
    </dl>
  );
}
