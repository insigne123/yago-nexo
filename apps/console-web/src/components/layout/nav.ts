import type { Permission } from "@nexo/shared/browser";
import {
  ChartColumn,
  Info,
  LayoutDashboard,
  Library,
  MailWarning,
  Network,
  PackageOpen,
  Radar,
  Rocket,
  ScrollText,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Basta con alguno de estos permisos para entrar. */
  anyOf?: readonly Permission[];
  reference?: string;
  testId: string;
}

export interface NavGroup {
  label?: string;
  items: readonly NavItem[];
}

export const NAVIGATION: readonly NavGroup[] = [
  {
    label: "General",
    items: [
      { to: "/", label: "Inicio", icon: LayoutDashboard, testId: "nav-inicio" },
      { to: "/catalogo", label: "Catálogo", icon: Library, anyOf: ["catalog:read"], testId: "nav-catalogo" },
      {
        to: "/dependencias",
        label: "Dependencias e impacto",
        icon: Network,
        anyOf: ["catalog:read"],
        testId: "nav-dependencias",
      },
    ],
  },
  {
    label: "Capacidades",
    items: [
      {
        to: "/descubrimiento",
        label: "Descubrimiento",
        icon: Radar,
        anyOf: ["discovery:read"],
        reference: "D-01",
        testId: "nav-descubrimiento",
      },
      {
        to: "/anomalias",
        label: "Anomalías",
        icon: ShieldAlert,
        anyOf: ["anomaly:read"],
        reference: "D-02",
        testId: "nav-anomalias",
      },
      {
        to: "/despliegues",
        label: "Despliegues",
        icon: Rocket,
        anyOf: ["rollout:read"],
        reference: "D-04",
        testId: "nav-despliegues",
      },
      {
        to: "/continuidad",
        label: "Continuidad",
        icon: ServerCog,
        anyOf: ["continuity:read"],
        reference: "D-05",
        testId: "nav-continuidad",
      },
    ],
  },
  {
    label: "Operación",
    items: [
      {
        to: "/consumo",
        label: "Consumo",
        icon: ChartColumn,
        anyOf: ["usage:read:all", "usage:read:own"],
        reference: "BT-021",
        testId: "nav-consumo",
      },
      {
        to: "/mensajes-fallidos",
        label: "Mensajes fallidos",
        icon: MailWarning,
        anyOf: ["dlq:read"],
        reference: "BT-051",
        testId: "nav-mensajes-fallidos",
      },
    ],
  },
  {
    label: "Gobierno",
    items: [
      {
        to: "/auditoria",
        label: "Auditoría",
        icon: ScrollText,
        anyOf: ["audit:read"],
        testId: "nav-auditoria",
      },
      {
        to: "/cumplimiento",
        label: "Cumplimiento",
        icon: ShieldCheck,
        anyOf: ["compliance:read"],
        testId: "nav-cumplimiento",
      },
      {
        to: "/exportacion",
        label: "Exportación",
        icon: PackageOpen,
        anyOf: ["export:create"],
        testId: "nav-exportacion",
      },
    ],
  },
  {
    items: [{ to: "/acerca-de", label: "Acerca de", icon: Info, testId: "nav-acerca-de" }],
  },
];
