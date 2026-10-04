/**
 * Catálogo de casos de aceptación con verificación automática. Cada caso ejecuta una verificación real del
 * laboratorio (tools/lab-bootstrap, tests/rendimiento, deploy/compose/fluent-bit/pruebas o tools/respaldo) y
 * pasa solo si esa verificación termina sin errores. Los casos sin verificación automática se ejecutan a mano
 * con el mismo formato de registro (ver el plan maestro de pruebas).
 */
export interface Caso {
  /** Identificador del caso (PA-nnn para requisitos, PA-Dnn para capacidades deseables). */
  id: string;
  /** Requisitos o capacidades que cubre. */
  requisitos: string[];
  titulo: string;
  /** Comando que ejecuta la verificación, desde la raíz del repositorio. */
  comando: string;
  condicionesPrevias: string;
  pasos: string[];
  datos: string;
  carga: string;
  resultadoEsperado: string;
  tolerancia: string;
  /** Componentes que participan (topología del caso). */
  componentes: string[];
  /** Perfil adicional del laboratorio que el caso necesita, si corresponde. */
  perfil?: "cont";
}

const LAB = "Laboratorio levantado con make up y configurado con make bootstrap";

export const CASOS: Caso[] = [
  {
    id: "PA-005",
    requisitos: ["BT-005", "D-08"],
    titulo: "Publicar y proteger una API a través del gateway, con flujos de aprobación",
    comando: "pnpm --filter @nexo/lab-bootstrap start",
    condicionesPrevias: `${LAB}; Keycloak y WSO2 sanos.`,
    pasos: ["Registra Keycloak como Key Manager", "Publica las APIs de ejemplo", "Crea aplicación y suscripción, que quedan pendientes de aprobación", "Aprueba como aprobador institucional", "Llama a la API con y sin token"],
    datos: "APIs y aplicación de ejemplo del laboratorio (datos sintéticos).",
    carga: "Llamadas individuales.",
    resultadoEsperado: "La API responde 200 con token válido y 401 sin token.",
    tolerancia: "Ninguna.",
    componentes: ["apim", "keycloak", "concesiones-v1"],
  },
  {
    id: "PA-008",
    requisitos: ["BT-008", "BT-009", "BT-033", "BT-051"],
    titulo: "Flujo de integración con validación, SOAP, transformación, cola, idempotencia y traza",
    comando: "pnpm --filter @nexo/lab-bootstrap check:integracion",
    condicionesPrevias: `${LAB}; Micro Integrator, RabbitMQ y Jaeger sanos.`,
    pasos: ["Envía una solicitud válida por el gateway", "Repite la misma llave de idempotencia", "Envía una solicitud inválida", "Busca la traza de extremo a extremo en Jaeger"],
    datos: "Solicitud sintética de concesión.",
    carga: "Llamadas individuales.",
    resultadoEsperado: "Solicitud válida procesada; la repetición no duplica; la inválida se rechaza con 400; la traza cruza gateway, Micro Integrator y destino.",
    tolerancia: "Ninguna.",
    componentes: ["apim", "mi", "rabbitmq", "registro-soap", "jaeger", "otel-collector"],
  },
  {
    id: "PA-020",
    requisitos: ["BT-020"],
    titulo: "Exposición por audiencias: gateway público y gateway de operadores",
    comando: "pnpm --filter @nexo/lab-bootstrap check:audiencias",
    condicionesPrevias: `${LAB}; gateway público sano.`,
    pasos: ["Llama a la API pública por el gateway público", "Llama a una API interna por el gateway público", "Repite por el gateway de operadores"],
    datos: "Concesión sintética CON-000001.",
    carga: "Llamadas individuales.",
    resultadoEsperado: "Cada gateway expone solo las APIs de su audiencia (200) y oculta las otras (404).",
    tolerancia: "Ninguna.",
    componentes: ["apim", "gw-publico", "keycloak"],
  },
  {
    id: "PA-018",
    requisitos: ["BT-018", "BT-021", "BT-024", "BT-026", "BT-031", "BT-034", "BT-049", "BT-051", "BT-060"],
    titulo: "Consola Nexo: catálogo, consumo, impacto, roles, auditoría, alertas, exportación y reproceso",
    comando: "pnpm --filter @nexo/lab-bootstrap check:consola",
    condicionesPrevias: `${LAB}; API de la Consola sana.`,
    pasos: ["Recorre las 43 verificaciones de la Consola (ver salida)"],
    datos: "Catálogo, consumo y auditoría del laboratorio.",
    carga: "Llamadas individuales.",
    resultadoEsperado: "43 de 43 verificaciones cumplen.",
    tolerancia: "Ninguna.",
    componentes: ["console-api", "apim", "mi", "postgres", "opensearch", "alertmanager"],
  },
  {
    id: "PA-032",
    requisitos: ["BT-031", "BT-032"],
    titulo: "Envío de auditoría al SIEM sin pérdida, en orden y sin duplicados",
    comando: "pnpm --filter @nexo/lab-bootstrap check:siem",
    condicionesPrevias: `${LAB}; receptor SIEM del laboratorio (Fluent Bit) y OpenSearch sanos.`,
    pasos: ["Genera eventos de auditoría", "Corta el destino SIEM y genera más eventos", "Restablece el destino", "Compara lo recibido con lo emitido"],
    datos: "Eventos de auditoría sintéticos.",
    carga: "Ráfaga de eventos de auditoría.",
    resultadoEsperado: "Todos los eventos llegan, en orden y sin duplicados, también los emitidos durante el corte.",
    tolerancia: "Ninguna.",
    componentes: ["motores", "fluent-bit", "opensearch", "postgres"],
  },
  {
    id: "PA-029",
    requisitos: ["BT-029"],
    titulo: "Enmascaramiento de datos personales y secretos en los logs",
    comando: "deploy/compose/fluent-bit/pruebas/probar-enmascaramiento.sh",
    condicionesPrevias: "Docker disponible; imagen de Fluent Bit del laboratorio.",
    pasos: ["Levanta un Fluent Bit aparte con el filtro del laboratorio", "Envía registros con RUT, correo, teléfono, tarjeta, tokens y claves", "Compara la salida"],
    datos: "Registros sintéticos con datos personales de prueba.",
    carga: "Registros individuales.",
    resultadoEsperado: "Ningún dato personal ni secreto en la salida; los registros sin datos personales quedan intactos.",
    tolerancia: "Ninguna.",
    componentes: ["fluent-bit"],
  },
  {
    id: "PA-039",
    requisitos: ["BT-039", "BT-040", "BT-041"],
    titulo: "Rendimiento a la capacidad de diseño y estrés por escalones",
    comando: "pnpm --filter @nexo/lab-bootstrap rendimiento",
    condicionesPrevias: `${LAB}; sin otras pruebas en curso.`,
    pasos: ["28 tx/s durante 3 min", "125 tx/s durante 3 min", "250 tx/s durante 5 min", "Escalones de estrés hasta que deja de cumplir"],
    datos: "Mezcla sintética: 50% operadores, 30% público, 20% integración.",
    carga: "Tasa constante de llegadas de 28, 125 y 250 tx/s y escalones crecientes.",
    resultadoEsperado: "A 250 tx/s: error < 1%, p99 < 1.000 ms en REST y < 2.000 ms en integración.",
    tolerancia: "Ninguna sobre los umbrales.",
    componentes: ["apim", "gw-publico", "mi", "keycloak", "rabbitmq", "registro-soap", "concesiones-v1"],
  },
  {
    id: "PA-058",
    requisitos: ["BT-058", "BT-053"],
    titulo: "Respaldo cifrado y restauración verificada",
    comando: "pnpm --filter @nexo/respaldo restaurar",
    condicionesPrevias: "Respaldo reciente generado con pnpm --filter @nexo/respaldo respaldar.",
    pasos: ["Verifica las sumas del respaldo", "Descifra", "Restaura en una base temporal", "Compara las filas de cada tabla y la cadena de auditoría"],
    datos: "Bases del laboratorio.",
    carga: "No aplica.",
    resultadoEsperado: "Todas las tablas con las mismas filas que en el respaldo; cadena de auditoría íntegra; tiempo de restauración informado.",
    tolerancia: "Ninguna.",
    componentes: ["postgres", "keycloak-db"],
  },
  {
    id: "PA-D01",
    requisitos: ["D-01"],
    titulo: "Descubrimiento de APIs no gobernadas e informe de exposición",
    comando: "pnpm --filter @nexo/lab-bootstrap check:d01",
    condicionesPrevias: `${LAB}; plataforma «actual» sembrada con make legado.`,
    pasos: ["Recorre APISIX, NGINX y la red autorizada", "Compara con el catálogo", "Genera el informe PDF y CSV"],
    datos: "APIs ocultas sembradas en el laboratorio.",
    carga: "No aplica.",
    resultadoEsperado: "Encuentra las APIs ocultas sembradas y las clasifica por exposición.",
    tolerancia: "Ninguna.",
    componentes: ["motores", "apisix", "nginx-legacy", "ocultas", "console-api"],
  },
  {
    id: "PA-D02",
    requisitos: ["D-02"],
    titulo: "Guardián de anomalías: bloqueo automático y liberación con cuatro ojos",
    comando: "pnpm --filter @nexo/lab-bootstrap check:d02",
    condicionesPrevias: `${LAB}; tráfico base de aprendizaje, y al menos una hora sin pruebas de carga sostenida de la misma aplicación (la línea base del guardián son los últimos 60 minutos: una prueba de carga la eleva y una ráfaga deja de ser anómala).`,
    pasos: ["Genera tráfico normal", "Genera una anomalía", "Verifica el bloqueo", "Libera con aprobación de una segunda persona"],
    datos: "Tráfico sintético.",
    carga: "Tráfico normal y una ráfaga anómala.",
    resultadoEsperado: "Bloqueo automático de la fuente anómala y liberación solo con dos personas.",
    tolerancia: "Detección dentro de la ventana configurada.",
    componentes: ["motores", "apim", "opensearch", "console-api"],
  },
  {
    id: "PA-D04",
    requisitos: ["D-04"],
    titulo: "Despliegues progresivos con reversa automática y sin cortes",
    comando: "pnpm --filter @nexo/lab-bootstrap check:d04",
    condicionesPrevias: `${LAB}; versiones v1 y v2 del backend disponibles.`,
    pasos: ["Canary por pasos con tráfico continuo", "Azul/verde", "Espejo", "Versión defectuosa con reversa automática"],
    datos: "Backends de prueba v1 y v2.",
    carga: "Tráfico continuo de consumidor durante cada despliegue.",
    resultadoEsperado: "Cero errores del consumidor durante los despliegues y reversa automática ante la versión defectuosa.",
    tolerancia: "Ninguna.",
    componentes: ["motores", "nexo-division", "apim", "concesiones-v1", "concesiones-v2"],
  },
  {
    id: "PA-D05",
    requisitos: ["D-05", "BT-035", "BT-036"],
    titulo: "Conmutación entre sitios con quórum, sin cerebro dividido y retorno",
    comando: "pnpm --filter @nexo/lab-bootstrap check:d05",
    condicionesPrevias: "Laboratorio de continuidad levantado con make continuidad.",
    pasos: ["Cae el sitio principal", "Quórum 2 de 3 decide la conmutación", "Promueve la base del respaldo y cambia el DNS", "Partición sin quórum no conmuta", "Retorno al sitio principal"],
    datos: "Escrituras sintéticas para medir el RPO.",
    carga: "Escrituras continuas.",
    resultadoEsperado: "Conmuta con quórum, sin cerebro dividido y sin pérdida de datos confirmados; vuelve al sitio principal.",
    tolerancia: "Tiempo de conmutación informado.",
    componentes: ["cont-cpd", "cont-gcp", "cont-etcd", "cont-coredns", "agentes de continuidad"],
    perfil: "cont",
  },
  {
    id: "PA-D06",
    requisitos: ["D-06"],
    titulo: "APIs GraphQL y de eventos (WebSocket con AsyncAPI) a través del gateway",
    comando: "pnpm --filter @nexo/lab-bootstrap check:d06",
    condicionesPrevias: LAB,
    pasos: ["Consulta la API GraphQL por el gateway", "Se suscribe a la API de eventos por WebSocket", "Verifica el contrato AsyncAPI publicado"],
    datos: "Concesiones y eventos sintéticos.",
    carga: "No aplica.",
    resultadoEsperado: "La consulta GraphQL responde por el gateway con token y la suscripción WebSocket recibe eventos.",
    tolerancia: "Ninguna.",
    componentes: ["apim"],
  },
  {
    id: "PA-D07",
    requisitos: ["D-07"],
    titulo: "Generación de SDK desde el contrato OpenAPI publicado",
    comando: "pnpm --filter @nexo/lab-bootstrap check:d07",
    condicionesPrevias: LAB,
    pasos: ["Descarga el SDK desde el Dev Portal en al menos tres lenguajes", "Verifica el contenido de cada paquete"],
    datos: "API publicada de ejemplo.",
    carga: "No aplica.",
    resultadoEsperado: "SDK generado en al menos tres lenguajes, con el cliente de la API.",
    tolerancia: "Ninguna.",
    componentes: ["apim"],
  },
];
