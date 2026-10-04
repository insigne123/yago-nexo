import { capacidades, type Estado } from "@site/src/data/estado";
import type { ReactNode } from "react";

interface Props {
  /** Estado a listar (por omisión, Disponible). */
  estado?: Estado;
}

/** Lista de capacidades con un estado dado, con su descripción, leída de capacidades.json. */
export default function ListaCapacidades({ estado = "Disponible" }: Props): ReactNode {
  const lista = capacidades.filter((c) => c.estado === estado);
  if (lista.length === 0) return <p>Ninguna capacidad en estado «{estado}».</p>;
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
