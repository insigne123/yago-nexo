import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import { themes as prismThemes } from "prism-react-renderer";

import release from "./src/data/release.json";

// Casilla para reportes de vulnerabilidades (se muestra en Seguridad y en el pie de página).
const CONTACTO_SEGURIDAD = "seguridad@yago.cl"; // TODO(Yago): confirmar casilla
// Casilla de soporte (se muestra en Ciclo de vida y soporte).
const CONTACTO_SOPORTE = "soporte@yago.cl"; // TODO(Yago): confirmar casilla

const AVISO_MARCA = "WSO2 es una marca de WSO2 LLC. Yago Nexo no está afiliado a WSO2 LLC.";

const config: Config = {
  title: "Yago Nexo",
  tagline: "Gestión de APIs e integración para instituciones públicas",
  favicon: "img/favicon.svg",

  // Firebase Hosting (sitio yago-nexo): sitio estático servido en la raíz.
  url: "https://yago-nexo.web.app",
  baseUrl: "/",
  trailingSlash: false,

  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",
  onDuplicateRoutes: "throw",

  i18n: {
    defaultLocale: "es",
    locales: ["es"],
    localeConfigs: {
      es: { label: "Español", htmlLang: "es-CL" },
    },
  },

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "throw",
      onBrokenMarkdownImages: "throw",
    },
  },

  customFields: {
    CONTACTO_SEGURIDAD,
    CONTACTO_SOPORTE,
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "docs",
        },
        blog: {
          path: "blog",
          routeBasePath: "novedades",
          blogTitle: "Novedades",
          blogDescription: "Versiones, avisos y cambios de Yago Nexo.",
          blogSidebarTitle: "Novedades recientes",
          blogSidebarCount: "ALL",
          showReadingTime: true,
          authorsMapPath: "authors.yml",
          onInlineAuthors: "throw",
          onInlineTags: "throw",
          onUntruncatedBlogPosts: "throw",
          feedOptions: {
            type: "rss",
            title: "Yago Nexo · Novedades",
            description: "Versiones, avisos y cambios de Yago Nexo.",
            copyright: "© 2026 Sociedad de Inversiones Yago SpA",
            language: "es",
            xslt: true,
          },
        },
        theme: {
          customCss: "./src/css/custom.css",
        },
        // Sin analítica ni etiquetas de seguimiento: no se configuran gtag, googleAnalytics ni GTM.
      } satisfies Preset.Options,
    ],
  ],

  themes: [
    "@docusaurus/theme-mermaid",
    [
      // Búsqueda local: el índice se genera en el build y se sirve con el sitio (sin servicios externos).
      "@easyops-cn/docusaurus-search-local",
      {
        hashed: true,
        language: ["es"],
        indexDocs: true,
        indexBlog: true,
        indexPages: true,
        docsRouteBasePath: "docs",
        blogRouteBasePath: "novedades",
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
        searchResultLimits: 10,
      },
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: "light",
      respectPrefersColorScheme: true,
    },
    metadata: [
      {
        name: "description",
        content: "Yago Nexo: plataforma de gestión de APIs e integración para instituciones públicas.",
      },
    ],
    announcementBar: {
      id: `version-${release.version}`,
      content: `Versión ${release.version} ${release.estado}: cada capacidad indica su estado real. Consulte la <a href="/docs/hoja-de-ruta">hoja de ruta</a>.`,
      backgroundColor: "var(--nexo-aviso-bg)",
      textColor: "var(--nexo-aviso-fg)",
      isCloseable: true,
    },
    navbar: {
      title: "Yago Nexo",
      logo: {
        alt: "Yago Nexo",
        src: "img/logo.svg",
        width: 28,
        height: 28,
      },
      items: [
        { type: "doc", docId: "intro", label: "Documentación", position: "left" },
        { to: "/docs/laboratorio", label: "Laboratorio", position: "left" },
        { to: "/docs/api-consola", label: "API", position: "left" },
        { to: "/docs/hoja-de-ruta", label: "Hoja de ruta", position: "left" },
        { to: "/novedades", label: "Novedades", position: "left" },
        {
          to: "/docs/ciclo-de-vida-y-soporte",
          label: `v${release.version} · ${release.estado}`,
          position: "right",
          className: "navbar-version",
          "aria-label": `Versión actual ${release.version} (${release.estado})`,
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Documentación",
          items: [
            { label: "Introducción", to: "/docs/intro" },
            { label: "Arquitectura", to: "/docs/arquitectura" },
            { label: "Laboratorio", to: "/docs/laboratorio" },
            { label: "API de la Consola", to: "/docs/api-consola" },
          ],
        },
        {
          title: "Producto",
          items: [
            { label: "Hoja de ruta", to: "/docs/hoja-de-ruta" },
            { label: "Ciclo de vida y soporte", to: "/docs/ciclo-de-vida-y-soporte" },
            { label: "Demostraciones registradas", to: "/evidencias" },
            { label: "Novedades", to: "/novedades" },
            { label: "RSS de novedades", href: "pathname:///novedades/rss.xml" },
          ],
        },
        {
          title: "Confianza",
          items: [
            { label: "Seguridad", to: "/docs/seguridad" },
            { label: "Componentes y licencias", to: "/docs/componentes-y-licencias" },
            { label: "Licencia y avisos", to: "/docs/licencia-y-avisos" },
            {
              label: `Reportar una vulnerabilidad: ${CONTACTO_SEGURIDAD}`,
              href: `mailto:${CONTACTO_SEGURIDAD}`,
            },
          ],
        },
      ],
      copyright: `© 2026 Sociedad de Inversiones Yago SpA. ${AVISO_MARCA} <a href="/docs/licencia-y-avisos">Licencia y avisos</a>.`,
    },
    docs: {
      sidebar: { hideable: true },
    },
    tableOfContents: {
      minHeadingLevel: 2,
      maxHeadingLevel: 3,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash"],
    },
    mermaid: {
      theme: { light: "neutral", dark: "dark" },
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
