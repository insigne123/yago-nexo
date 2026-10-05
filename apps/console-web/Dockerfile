# Consola Nexo (web). Imagen de ejecución: el build se hace antes con
#   pnpm --filter @nexo/console-web build
# y luego, desde apps/console-web:
#   docker build -t nexo/console-web:1.0.0 .
# Variante oficial sin privilegios de nginx (usuario nginx, uid 101): escucha en 8080 y admite plantillas.
FROM nginxinc/nginx-unprivileged:1.29-alpine

LABEL org.opencontainers.image.title="Consola Nexo (web)" \
      org.opencontainers.image.vendor="Sociedad de Inversiones Yago SpA" \
      org.opencontainers.image.version="1.1.0" \
      org.opencontainers.image.description="Interfaz de la Consola Nexo: catálogo, impacto, motores D-01, D-02, D-04 y D-05, consumo, auditoría y cumplimiento"

# Orígenes permitidos por la política de seguridad de contenido (CSP). En producción se agregan la
# API de la Consola y el Keycloak institucional; en la demo, el proyecto de Supabase. Ejemplo:
#   NEXO_CSP_CONNECT_SRC="'self' https://sso.institucion.example https://api-consola.institucion.example"
ENV NEXO_CSP_CONNECT_SRC="'self'" \
    NEXO_CSP_FRAME_SRC="'self'"

COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY dist/ /usr/share/nginx/html/

# Configuración por defecto; en cada ambiente se monta otra en /etc/nexo/config.json.
USER root
RUN mkdir -p /etc/nexo \
    && cp /usr/share/nginx/html/config.json /etc/nexo/config.json \
    && rm /usr/share/nginx/html/config.json \
    && chown -R 101:101 /etc/nexo
USER 101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
