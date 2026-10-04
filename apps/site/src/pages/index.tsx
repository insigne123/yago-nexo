import Link from "@docusaurus/Link";
import LeyendaEstados from "@site/src/components/LeyendaEstados";
import ResumenEstados from "@site/src/components/ResumenEstados";
import TablaCapacidades from "@site/src/components/TablaCapacidades";
import { capacidades, conteoPorEstado, fechaLarga, release } from "@site/src/data/estado";
import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import clsx from "clsx";
import type { ReactNode } from "react";

import styles from "./index.module.css";

const USOS = [
  {
    titulo: "Publicar y proteger APIs",
    texto:
      "Gateway, portal para desarrolladores y ciclo de vida de cada API, con identidad centralizada en Keycloak y políticas de seguridad y de uso.",
  },
  {
    titulo: "Integrar sistemas",
    texto:
      "Flujos entre servicios REST y SOAP, colas de mensajes y bases de datos, con validación, manejo de errores y reproceso controlado.",
  },
  {
    titulo: "Gobernar y operar",
    texto:
      "Catálogo con dueños y dependencias, auditoría íntegra, observabilidad y continuidad entre el centro de datos y la nube.",
  },
];

const PUBLICO = [
  {
    titulo: "Arquitectura y desarrollo",
    texto: "Diseñan, publican y versionan APIs a partir de contratos OpenAPI.",
  },
  { titulo: "Operación", texto: "Despliega, monitorea y mantiene la continuidad del servicio." },
  {
    titulo: "Seguridad y auditoría",
    texto: "Controla el acceso por rol y revisa la auditoría y las evidencias.",
  },
  {
    titulo: "Consumidores autorizados",
    texto: "Otras instituciones, empresas o personas que usan las APIs desde el portal para desarrolladores.",
  },
];

const CAPAS = [
  {
    nombre: "Servicio",
    texto: "Soporte con niveles de servicio definidos, capacitación por rol y esta documentación pública.",
    enlace: { to: "/docs/ciclo-de-vida-y-soporte", texto: "Ciclo de vida y soporte" },
  },
  {
    nombre: "Capa Yago",
    texto:
      "Consola Nexo; motores de descubrimiento de APIs, detección de anomalías, despliegues progresivos y continuidad; instaladores y pruebas de aceptación. Software propio de Yago.",
    enlace: { to: "/docs/arquitectura", texto: "Arquitectura" },
  },
  {
    nombre: "Base abierta",
    texto:
      "WSO2 API Manager 4.7.0 y WSO2 Micro Integrator 4.6.0 (licencia Apache 2.0), con Keycloak, PostgreSQL, RabbitMQ y herramientas de observabilidad de código abierto.",
    enlace: { to: "/docs/componentes-y-licencias", texto: "Componentes y licencias" },
  },
  {
    nombre: "Infraestructura de la institución",
    texto:
      "Diseñado para el centro de datos de la institución (VMware vSphere), con respaldo en Google Cloud. Nexo no es un servicio en la nube de terceros.",
    enlace: undefined,
  },
];

const EMPEZAR = [
  {
    to: "/docs/intro",
    titulo: "Introducción",
    texto: "Qué es Nexo, qué existe hoy y cómo leer esta documentación.",
  },
  {
    to: "/docs/arquitectura",
    titulo: "Arquitectura",
    texto: "Capas, ambientes y continuidad entre sitios (diseño).",
  },
  {
    to: "/docs/laboratorio",
    titulo: "Laboratorio",
    texto: "Levante la base de Nexo en un equipo con Docker.",
  },
  {
    to: "/docs/seguridad",
    titulo: "Seguridad",
    texto: "Identidad, roles, auditoría, TLS, secretos y reporte de vulnerabilidades.",
  },
];

function Portada(): ReactNode {
  return (
    <header className={styles.portada}>
      <div className="container">
        <p className={styles.antetitulo}>Sociedad de Inversiones Yago SpA</p>
        <Heading as="h1" className={styles.marca}>
          Yago Nexo
        </Heading>
        <p className={styles.bajada}>
          Plataforma de gestión de APIs e integración para instituciones públicas, construida sobre
          componentes de código abierto y una capa propia de gobierno, automatización y continuidad.
        </p>
        <p className={styles.version}>
          Versión <strong>{release.version}</strong> · {release.estado} · {fechaLarga(release.fecha)}
        </p>
        <div className={styles.acciones}>
          <Link className="button button--primary button--lg" to="/docs/intro">
            Leer la documentación
          </Link>
          <Link className="button button--secondary button--lg" to="/docs/laboratorio">
            Probar el laboratorio
          </Link>
          <Link className={clsx("button button--link button--lg", styles.enlaceRuta)} to="/docs/hoja-de-ruta">
            Ver la hoja de ruta
          </Link>
        </div>
      </div>
    </header>
  );
}

export default function Inicio(): ReactNode {
  const conteo = conteoPorEstado();
  return (
    <Layout
      title="Gestión de APIs e integración para instituciones públicas"
      description="Yago Nexo: plataforma de gestión de APIs e integración para instituciones públicas, sobre WSO2 API Manager y Micro Integrator (Apache 2.0) más la capa propia de Yago."
    >
      <Portada />
      <main>
        <section className={clsx("container", styles.seccion)}>
          <div className={styles.aviso} role="note">
            <strong>Estado actual.</strong> Nexo está en desarrollo activo. La versión {release.version} es{" "}
            {release.estado}: hoy están disponibles {conteo.Disponible} de {capacidades.length} capacidades.
            El resto figura como <em>En desarrollo</em> o <em>Planificado</em> hasta que exista y se pueda
            verificar en el repositorio.
          </div>
        </section>

        <section className={clsx("container", styles.seccion)} aria-labelledby="que-es">
          <Heading as="h2" id="que-es">
            Qué es Nexo
          </Heading>
          <p className={styles.parrafo}>
            Nexo es una distribución de Yago para gestionar APIs e integraciones, diseñada para instalarse en
            la infraestructura de la institución. Reúne componentes de código abierto reconocidos,
            configurados como un solo producto, y software propio de Yago. Está pensado para tres tareas:
          </p>
          <div className={styles.grilla}>
            {USOS.map((u) => (
              <article key={u.titulo} className={styles.tarjeta}>
                <Heading as="h3">{u.titulo}</Heading>
                <p>{u.texto}</p>
              </article>
            ))}
          </div>
          <p className={styles.nota}>
            El estado de cada función se detalla en la <Link to="#capacidades">tabla de capacidades</Link>.
          </p>
        </section>

        <section className={clsx("container", styles.seccion)} aria-labelledby="para-quien">
          <Heading as="h2" id="para-quien">
            Para quién
          </Heading>
          <p className={styles.parrafo}>
            Para instituciones públicas que necesitan exponer e integrar servicios de forma segura, gobernada
            y auditable, con control sobre dónde corre la plataforma y quién accede a ella.
          </p>
          <div className={styles.grilla}>
            {PUBLICO.map((p) => (
              <article key={p.titulo} className={styles.tarjeta}>
                <Heading as="h3">{p.titulo}</Heading>
                <p>{p.texto}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={clsx("container", styles.seccion)} aria-labelledby="como-se-compone">
          <Heading as="h2" id="como-se-compone">
            Cómo se compone
          </Heading>
          <p className={styles.parrafo}>
            Nexo no reprograma lo que ya existe y está probado: parte de una base abierta y le agrega una capa
            propia.
          </p>
          <ol className={styles.capas}>
            {CAPAS.map((c) => (
              <li key={c.nombre} className={styles.capa}>
                <span className={styles.capaNombre}>{c.nombre}</span>
                <span className={styles.capaTexto}>
                  {c.texto}
                  {c.enlace && (
                    <>
                      {" "}
                      <Link to={c.enlace.to}>{c.enlace.texto}</Link>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className={clsx("container", styles.seccion)} aria-labelledby="capacidades">
          <Heading as="h2" id="capacidades">
            Capacidades y estado
          </Heading>
          <p className={styles.parrafo}>
            Cada capacidad muestra su estado real en la versión {release.version}. Solo figura como{" "}
            <em>Disponible</em> lo que existe y se puede verificar en el repositorio.
          </p>
          <ResumenEstados />
          <LeyendaEstados />
          <TablaCapacidades />
          <p className={styles.nota}>
            La <Link to="/docs/hoja-de-ruta">hoja de ruta</Link> detalla cada capacidad y la evidencia de las
            que están disponibles.
          </p>
        </section>

        <section className={clsx("container", styles.seccion)} aria-labelledby="empezar">
          <Heading as="h2" id="empezar">
            Por dónde empezar
          </Heading>
          <div className={styles.grilla}>
            {EMPEZAR.map((e) => (
              <Link key={e.to} to={e.to} className={clsx(styles.tarjeta, styles.tarjetaEnlace)}>
                <span className={styles.tarjetaTitulo}>{e.titulo}</span>
                <span>{e.texto}</span>
              </Link>
            ))}
          </div>
        </section>
      </main>
    </Layout>
  );
}
