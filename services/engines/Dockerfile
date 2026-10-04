# nexo-motores: un solo binario (bundle esbuild) para los motores y el agente de continuidad.
#   pnpm --filter @nexo/engines build && docker build -t nexo/motores services/engines
FROM node:22-alpine
WORKDIR /app
COPY dist/nexo-motores.mjs ./nexo-motores.mjs
USER node
EXPOSE 9465 9466
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:9465/health >/dev/null || exit 1
ENTRYPOINT ["node", "nexo-motores.mjs"]
