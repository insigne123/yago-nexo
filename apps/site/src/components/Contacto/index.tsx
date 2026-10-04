import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import type { ReactNode } from "react";

const CAMPOS = {
  seguridad: "CONTACTO_SEGURIDAD",
  soporte: "CONTACTO_SOPORTE",
} as const;

/** Enlace de correo tomado de customFields en docusaurus.config.ts (una sola fuente por casilla). */
export default function Contacto({ tipo }: { tipo: keyof typeof CAMPOS }): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const correo = siteConfig.customFields?.[CAMPOS[tipo]];
  if (typeof correo !== "string" || correo === "") {
    throw new Error(`Falta customFields.${CAMPOS[tipo]} en docusaurus.config.ts`);
  }
  return <a href={`mailto:${correo}`}>{correo}</a>;
}
