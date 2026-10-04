# El bundle se construye en el monorepo (pnpm --filter @nexo/demo-backends build).
FROM node:22-alpine
WORKDIR /app
COPY dist/server.mjs ./server.mjs
USER node
EXPOSE 7001
CMD ["node", "server.mjs"]
