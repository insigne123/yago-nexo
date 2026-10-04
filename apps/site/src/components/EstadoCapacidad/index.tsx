import EstadoBadge from "@site/src/components/EstadoBadge";
import { capacidad } from "@site/src/data/estado";
import type { ReactNode } from "react";

interface Props {
  /** id de la capacidad en src/data/capacidades.json (un id inexistente rompe el build). */
  id: string;
  /** Muestra el nombre de la capacidad antes de la insignia. */
  conNombre?: boolean;
}

export default function EstadoCapacidad({ id, conNombre = false }: Props): ReactNode {
  const c = capacidad(id);
  if (!conNombre) return <EstadoBadge estado={c.estado} />;
  return (
    <span>
      {c.nombre}: <EstadoBadge estado={c.estado} />
    </span>
  );
}
