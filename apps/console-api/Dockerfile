# API de la Consola Nexo. Se construye desde el paquete desplegable del monorepo (sin compilar en la imagen):
#   pnpm --filter @nexo/console-api... build
#   pnpm --filter @nexo/console-api deploy --prod --legacy apps/console-api/.deploy
#   docker build -t nexo/console-api apps/console-api/.deploy   (el Makefile del laboratorio copia este archivo ahí)
FROM node:22-alpine
ENV NODE_ENV=production NEXO_PORT=8090
WORKDIR /app
COPY --chown=node:node . .
USER node
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8090/api/v1/health >/dev/null || exit 1
CMD ["node", "dist/main.js"]
