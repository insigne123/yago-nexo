import { capacidades, ETIQUETA_ESTADO, type Estado } from "@site/src/data/estado";
import type { ReactNode } from "react";

interface Props {
  /** Estado a listar (por omisión, las incluidas en la versión publicada). */
  estado?: Estado;
}

/** Lista de capacidades con un estado dado, con su descripción, leída de capacidades.json. */
export default function ListaCapacidades({ estado = "Incluida" }: Props): ReactNode {
  const lista = capacidades.filter((c) => c.estado === estado);
  if (lista.length === 0) return <p>Ninguna capacidad en «{ETIQUETA_ESTADO[estado]}».</p>;
  return (
    <ul>
      {lista.map((c) => (
        <li key={c.id}>
          <strong>{c.nombre}.</strong> {c.descripcion}
        </li>
      ))}
    </ul>
  );
}
