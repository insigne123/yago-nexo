import { useAuthProvider } from "../../auth/AuthContext";
import { useSession } from "../../auth/session";
import { PageHeader } from "../../components/PageHeader";
import { Card } from "../../components/ui/Card";
import { DataTable, type Column } from "../../components/ui/Table";
import { useRuntime } from "../../config/RuntimeContext";

interface Component {
  name: string;
  version: string;
  license: string;
  role: string;
}

/** Componentes de código abierto y sus licencias (versiones del laboratorio; el detalle está en el SBOM). */
const COMPONENTS: readonly Component[] = [
  {
    name: "WSO2 API Manager",
    version: "4.7.0",
    license: "Apache 2.0",
    role: "Gateway, Publisher, Developer Portal y Key Manager",
  },
  {
    name: "WSO2 Micro Integrator",
    version: "4.6.0",
    license: "Apache 2.0",
    role: "Integración y orquestación (REST, SOAP, colas)",
  },
  { name: "Keycloak", version: "26.8", license: "Apache 2.0", role: "Identidad y SSO (OIDC)" },
  {
    name: "PostgreSQL",
    version: "16",
    license: "PostgreSQL License",
    role: "Bases de datos de la plataforma y de la Consola",
  },
  { name: "RabbitMQ", version: "4.3", license: "MPL 2.0", role: "Mensajería y colas de mensajes fallidos" },
  { name: "OpenSearch", version: "3.9.0", license: "Apache 2.0", role: "Analítica de tráfico y registros" },
  { name: "Prometheus", version: "3.13.4", license: "Apache 2.0", role: "Métricas y alertas" },
  {
    name: "Grafana",
    version: "13.0.10",
    license: "AGPL 3.0",
    role: "Tableros de observabilidad (sin modificaciones)",
  },
  {
    name: "OpenTelemetry Collector",
    version: "0.161.0",
    license: "Apache 2.0",
    role: "Trazas, métricas y registros",
  },
  { name: "Jaeger", version: "2.21.0", license: "Apache 2.0", role: "Trazas distribuidas" },
  {
    name: "OpenMetadata",
    version: "Según instalación",
    license: "Apache 2.0",
    role: "Catálogo de datos y linaje",
  },
];

const columns: Column<Component>[] = [
  {
    id: "name",
    header: "Componente",
    sortValue: (c) => c.name,
    cell: (c) => <span className="font-medium text-fg">{c.name}</span>,
  },
  { id: "version", header: "Versión", cell: (c) => c.version },
  { id: "license", header: "Licencia", sortValue: (c) => c.license, cell: (c) => c.license },
  { id: "role", header: "Uso en Nexo", cell: (c) => <span className="text-fg-muted">{c.role}</span> },
];

export default function AcercaDePage() {
  const { config, mock } = useRuntime();
  const provider = useAuthProvider();
  const session = useSession();
  return (
    <>
      <PageHeader
        title="Acerca de Yago Nexo"
        description="Versión, ambiente y componentes de la plataforma."
      />
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card title="Esta instalación">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-fg-muted">Producto</dt>
            <dd className="text-fg">Yago Nexo · Consola Nexo</dd>
            <dt className="text-fg-muted">Versión</dt>
            <dd className="text-fg" data-testid="about-version">
              {config.version}
              <span className="ml-2 text-xs text-fg-subtle">(build de la Consola {__APP_VERSION__})</span>
            </dd>
            <dt className="text-fg-muted">Ambiente</dt>
            <dd className="text-fg" data-testid="about-environment">
              {config.environmentLabel}
            </dd>
            <dt className="text-fg-muted">Inicio de sesión</dt>
            <dd className="text-fg">{provider.label}</dd>
            <dt className="text-fg-muted">API de la Consola</dt>
            <dd>
              <code className="font-mono text-xs">{config.apiBaseUrl}</code>
            </dd>
            <dt className="text-fg-muted">Datos</dt>
            <dd className="text-fg">
              {mock ? "Simulados (sin conexión a sistemas reales)" : "Plataforma en operación"}
            </dd>
            <dt className="text-fg-muted">Permisos</dt>
            <dd className="text-fg">
              {session.permissions.size} permisos efectivos (
              {session.source === "api" ? "informados por la API" : "calculados desde los roles"})
            </dd>
          </dl>
        </Card>
        <Card title="Aviso de origen">
          <p className="text-sm text-fg" data-testid="about-notice">
            Yago Nexo está basado en WSO2 (Apache 2.0). WSO2 es marca de WSO2 LLC.
          </p>
          <p className="mt-3 text-sm text-fg-muted">
            Nexo es una distribución de Sociedad de Inversiones Yago SpA que integra componentes de código
            abierto con su capa propia: Consola Nexo, motores de descubrimiento, anomalías, despliegues
            progresivos y continuidad, instaladores y pruebas de aceptación. La lista completa de componentes,
            versiones y licencias se entrega en el SBOM y en los archivos NOTICE de cada paquete.
          </p>
        </Card>
      </div>
      <DataTable
        rows={COMPONENTS}
        columns={columns}
        rowKey={(c) => c.name}
        caption="Componentes y licencias"
        testId="table-components"
      />
    </>
  );
}
