// Texto condicionado al estado de una capacidad: si el release engineer cambia el estado en
// capacidades.json, las frases que dejarían de ser ciertas desaparecen solas.
import { capacidad } from "@site/src/data/estado";
import type { ReactNode } from "react";

interface Props {
  /** id de la capacidad en src/data/capacidades.json. */
  id: string;
  children: ReactNode;
}

/** Muestra el contenido solo si la capacidad está incluida en la versión publicada. */
export function SiDisponible({ id, children }: Props): ReactNode {
  return capacidad(id).estado === "Incluida" ? children : null;
}

/** Muestra el contenido solo si la capacidad se entrega con el servicio de implementación. */
export function SiNoDisponible({ id, children }: Props): ReactNode {
  return capacidad(id).estado === "Incluida" ? null : children;
}
