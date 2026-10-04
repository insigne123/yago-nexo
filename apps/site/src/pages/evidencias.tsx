import Link from "@docusaurus/Link";
import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import type { ReactNode } from "react";

import indice from "@site/src/data/evidencias.json";
import release from "@site/src/data/release.json";
import rendimiento from "@site/src/data/rendimiento.json";

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

/** Resumen del informe de rendimiento (lo genera tools/lab-bootstrap/src/rendimiento.ts; ver resultados.json). */
interface Fase {
  nombre: string;
  tasaObjetivo: number;
  tasaLograda: number;
  solicitudes: number;
  tasaError: number;
  cumple: boolean;
  motivo: string;
  p99: { operadores: number; publico: number; integracion: number };
}
interface Rendimiento {
  fecha: string;
  version: string;
  commit: string;
  maquina: string;
  fases: Fase[];
  estres: Fase[];
  limite: number | null;
  nota: string;
  pdf: string;
  html: string;
}
const informe = rendimiento as Rendimiento;
const REPO = "https://github.com/insigne123/yago-nexo";
const num = (n: number) => n.toLocaleString("es-CL", { maximumFractionDigits: 1 });

function TablaFases({ fases }: { fases: Fase[] }): ReactNode {
  return (
    <table>
      <thead>
        <tr>
          <th>Fase</th>
          <th>Objetivo (tx/s)</th>
          <th>Lograda (tx/s)</th>
          <th>Solicitudes</th>
          <th>Error</th>
          <th>p99 operadores (ms)</th>
          <th>p99 público (ms)</th>
          <th>p99 integración (ms)</th>
          <th>Resultado</th>
        </tr>
      </thead>
      <tbody>
        {fases.map((f) => (
          <tr key={f.nombre}>
            <td>{f.nombre}</td>
            <td>{num(f.tasaObjetivo)}</td>
            <td>{num(f.tasaLograda)}</td>
            <td>{num(f.solicitudes)}</td>
            <td>{(f.tasaError * 100).toLocaleString("es-CL", { maximumFractionDigits: 2 })} %</td>
            <td>{num(f.p99.operadores)}</td>
            <td>{num(f.p99.publico)}</td>
            <td>{num(f.p99.integracion)}</td>
            <td>{f.cumple ? "Cumple" : f.motivo}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

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

        <section aria-labelledby="rendimiento">
          <Heading as="h2" id="rendimiento">
            Informe de rendimiento
          </Heading>
          <p>
            Prueba con k6 a tasa constante de llegadas, con la mezcla 50 % gateway de operadores, 30 % gateway público y
            20 % integración (gateway, Micro Integrator con validación, llamada SOAP, transformación y cola). Umbrales:
            error menor a 1 %, p99 menor a 1.000 ms en REST y a 2.000 ms en integración. {informe.version}, commit{" "}
            {informe.commit}, {fecha(informe.fecha)}, {informe.maquina}.
          </p>
          <TablaFases fases={informe.fases} />
          {informe.estres.length > 0 && (
            <>
              <p>
                Estrés por escalones hasta que deja de cumplir:{" "}
                {informe.limite
                  ? `el último escalón que cumplió fue ${num(informe.limite)} tx/s.`
                  : "ningún escalón adicional cumplió los umbrales."}
              </p>
              <TablaFases fases={informe.estres} />
            </>
          )}
          <p>{informe.nota}</p>
          <p>
            Informe completo: <a href={informe.pdf}>PDF</a> · <a href={informe.html}>HTML</a>. Se reproduce con{" "}
            <code>pnpm --filter @nexo/lab-bootstrap rendimiento</code>.
          </p>
        </section>

        <section aria-labelledby="descargas">
          <Heading as="h2" id="descargas">
            Descargas de la versión {release.version}
          </Heading>
          <p>
            La <a href={`${REPO}/releases/tag/v${release.version}`}>versión {release.version} en GitHub</a> publica el
            inventario de componentes (SBOM CycloneDX), el inventario de licencias, las sumas SHA-256 y la lista de
            imágenes, cada archivo con su firma Sigstore, y las imágenes de contenedor propias firmadas en GHCR. Para
            verificar un archivo con <code>cosign</code>:
          </p>
          <pre>
            <code>{`cosign verify-blob --bundle <archivo>.sigstore.json \\
  --certificate-identity-regexp '^${REPO}/\\.github/workflows/release\\.yml@' \\
  --certificate-oidc-issuer https://token.actions.githubusercontent.com <archivo>`}</code>
          </pre>
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
