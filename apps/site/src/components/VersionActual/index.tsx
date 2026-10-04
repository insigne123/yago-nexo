import { fechaLarga, release } from "@site/src/data/estado";
import type { ReactNode } from "react";

interface Props {
  /** "numero": 1.0.0 · "completa": 1.0.0 (publicada, 4 de octubre de 2026) */
  formato?: "numero" | "completa";
}

/** Versión actual del producto, leída de src/data/release.json. */
export default function VersionActual({ formato = "completa" }: Props): ReactNode {
  if (formato === "numero") return <span>{release.version}</span>;
  return (
    <span>
      <strong>{release.version}</strong> ({release.estado}, {fechaLarga(release.fecha)})
    </span>
  );
}
