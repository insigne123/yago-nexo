import EstadoBadge from "@site/src/components/EstadoBadge";
import { capacidadesDe, grupo as buscarGrupo, grupos, type Grupo } from "@site/src/data/estado";
import Heading from "@theme/Heading";
import type { ReactNode } from "react";

import styles from "./styles.module.css";

interface Props {
  /** id del grupo en capacidades.json; sin grupo se muestran todos, con su título. */
  grupo?: string;
  /** Agrega la descripción y la evidencia en el repositorio de cada capacidad. */
  detalle?: boolean;
  /** Con `grupo`: muestra antes de la tabla la descripción del grupo (de capacidades.json). */
  descripcion?: boolean;
}

function Tabla({ g, detalle }: { g: Grupo; detalle: boolean }): ReactNode {
  return (
    <div className={styles.contenedor}>
      <table className={styles.tabla}>
        <caption className={styles.titulo}>{g.nombre}</caption>
        <thead>
          <tr>
            <th scope="col">Capacidad</th>
            <th scope="col" className={styles.colEstado}>
              Estado
            </th>
            {detalle && <th scope="col">Evidencia en el repositorio</th>}
          </tr>
        </thead>
        <tbody>
          {capacidadesDe(g.id).map((c) => (
            <tr key={c.id} id={detalle ? `capacidad-${c.id}` : undefined}>
              <td>
                <span className={styles.nombre}>{c.nombre}</span>
                {detalle && <span className={styles.descripcion}>{c.descripcion}</span>}
              </td>
              <td className={styles.colEstado}>
                <EstadoBadge estado={c.estado} />
              </td>
              {detalle && (
                <td className={styles.evidencia}>
                  {c.estado === "Disponible" && c.evidencia?.length ? (
                    <ul>
                      {c.evidencia.map((ruta) => (
                        <li key={ruta}>
                          <code>{ruta}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span aria-label="sin evidencia todavía">—</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TablaCapacidades({ grupo, detalle = false, descripcion = false }: Props): ReactNode {
  if (grupo) {
    const g = buscarGrupo(grupo);
    return (
      <>
        {descripcion && <p className={styles.grupoDescripcion}>{g.descripcion}</p>}
        <Tabla g={g} detalle={detalle} />
      </>
    );
  }
  return (
    <div className={styles.grupos}>
      {grupos.map((g) => (
        <section key={g.id} className={styles.grupo}>
          <Heading as="h3" id={`grupo-${g.id}`}>
            {g.nombre}
          </Heading>
          <p className={styles.grupoDescripcion}>{g.descripcion}</p>
          <Tabla g={g} detalle={detalle} />
        </section>
      ))}
    </div>
  );
}
