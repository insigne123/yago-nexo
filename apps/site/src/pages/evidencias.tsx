import Link from "@docusaurus/Link";
import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import type { ReactNode } from "react";

import indice from "@site/src/data/evidencias.json";

import styles from "./evidencias.module.css";

/** Una demostración registrada (lo genera tools/evidencias en cada grabación). */
interface Evidencia {
  id: string;
  title: string;
  claim: string;
  file: string;
  poster?: string;
  duration_seconds: number;
  sha256: string;
  size_bytes?: number;
  version: string;
  commit: string;
  recorded_at: string;
  environment: string;
  result: string;
  checks?: Array<{ texto: string; ok: boolean; detalle?: string }>;
}

const evidencias = (indice as { evidencias: Evidencia[] }).evidencias;

const duracion = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

const fecha = (iso: string) =>
  new Intl.DateTimeFormat("es-CL", { dateStyle: "long", timeStyle: "short", timeZone: "America/Santiago" }).format(
    new Date(iso),
  );

const megas = (b?: number) => (b ? `${(b / 1048576).toLocaleString("es-CL", { maximumFractionDigits: 1 })} MB` : "");

function Tarjeta({ e }: { e: Evidencia }): ReactNode {
  const url = `/evidencias/${e.file}`;
  return (
    <article className={styles.tarjeta} id={e.file.replace(/\.\w+$/, "").replace(/^[A-Z]+-\d+_/, "")}>
      <Heading as="h2" className={styles.titulo}>
        {e.title}
      </Heading>
      <p className={styles.afirmacion}>{e.claim}</p>
      <video
        className={styles.video}
        controls
        preload="metadata"
        src={url}
        poster={e.poster ? `/evidencias/${e.poster}` : undefined}
      >
        Su navegador no reproduce WebM; <a href={url}>descargue el video</a>.
      </video>
      <p className={styles.resultado}>
        <strong>Resultado medido: </strong>
        {e.result}
      </p>
      <dl className={styles.ficha}>
        <dt>Duración</dt>
        <dd>{duracion(e.duration_seconds)}</dd>
        <dt>Grabado</dt>
        <dd>{fecha(e.recorded_at)} (hora de Santiago)</dd>
        <dt>Versión</dt>
        <dd>
          Yago Nexo {e.version} · commit <code>{e.commit}</code>
        </dd>
        <dt>Ambiente</dt>
        <dd>{e.environment}</dd>
        <dt>SHA-256</dt>
        <dd>
          <code className={styles.hash}>{e.sha256}</code>
        </dd>
      </dl>
      <p className={styles.acciones}>
        <a className="button button--primary button--sm" href={url} download>
          Descargar el video (WebM{e.size_bytes ? `, ${megas(e.size_bytes)}` : ""})
        </a>
      </p>
      {e.checks && e.checks.length > 0 && (
        <details className={styles.verificaciones}>
          <summary>Verificaciones automáticas del escenario ({e.checks.length}, todas cumplidas)</summary>
          <ul>
            {e.checks.map((c) => (
              <li key={`${c.texto}-${c.detalle ?? ""}`}>
                {c.texto}
                {c.detalle ? `: ${c.detalle}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

export default function Evidencias(): ReactNode {
  return (
    <Layout
      title="Demostraciones registradas"
      description="Videos de las capacidades de Yago Nexo grabados mientras su escenario corre contra el laboratorio, con su suma SHA-256."
    >
      <main className="container margin-vert--lg">
        <Heading as="h1">Demostraciones registradas</Heading>
        <p className={styles.intro}>
          Cada video muestra una capacidad de Yago Nexo funcionando de verdad en el laboratorio de la versión indicada:
          la Consola Nexo y los portales de WSO2 operan contra los servicios reales (sin datos simulados), mientras el
          escenario corre y se verifica automáticamente. La grabación es continua, sin cortes ni aceleración: abre con
          una portada (capacidad, versión, commit, fecha y ambiente), mantiene un banner con la fecha y hora de
          Santiago y cierra con el resultado medido. Si alguna verificación falla, el video no se guarda.
        </p>

        <section className={styles.verificar} aria-labelledby="verificar">
          <Heading as="h2" id="verificar">
            Cómo verificar que un video no fue modificado
          </Heading>
          <p>
            Descargue el video y calcule su suma SHA-256; debe ser idéntica a la que aparece en su ficha y en{" "}
            <a href="/evidencias/SHA256SUMS.txt">SHA256SUMS.txt</a>.
          </p>
          <ul>
            <li>
              Linux: <code>sha256sum archivo.webm</code>, o con todos los videos en la misma carpeta que
              SHA256SUMS.txt: <code>sha256sum -c SHA256SUMS.txt</code>
            </li>
            <li>
              macOS: <code>shasum -a 256 archivo.webm</code>
            </li>
            <li>
              Windows (PowerShell): <code>Get-FileHash .\archivo.webm -Algorithm SHA256</code>
            </li>
          </ul>
          <p>
            El commit indicado en cada ficha identifica el código exacto con que se grabó. El laboratorio está descrito
            en <Link to="/docs/laboratorio">Laboratorio</Link>.
          </p>
        </section>

        {evidencias.length === 0 ? (
          <p>Todavía no hay demostraciones publicadas.</p>
        ) : (
          evidencias.map((e) => <Tarjeta key={e.id} e={e} />)
        )}
      </main>
    </Layout>
  );
}
