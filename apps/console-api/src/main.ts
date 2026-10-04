import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createPool, migrate } from "@nexo/console-db";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module.js";
import { config } from "./config.js";

async function bootstrap() {
  const log = new Logger("nexo-consola");
  // Migraciones al iniciar (con bloqueo: varias réplicas pueden arrancar a la vez).
  const pool = createPool(config.databaseUrl);
  await migrate(pool, (m) => log.log(m));
  await pool.end();

  const app = await NestFactory.create(AppModule, { logger: ["log", "warn", "error"] });
  app.setGlobalPrefix("api/v1");
  app.enableCors({ origin: config.corsOrigins, credentials: false, allowedHeaders: ["authorization", "content-type", "x-correlation-id"] });
  const express = app.getHttpAdapter().getInstance();
  express.disable("x-powered-by");
  express.set("trust proxy", true);
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    const correlation = String(req.headers["x-correlation-id"] ?? crypto.randomUUID());
    res.setHeader("x-correlation-id", correlation);
    next();
  });
  app.enableShutdownHooks();
  await app.listen(config.port, "0.0.0.0");
  log.log(`API de la Consola Nexo ${config.version} escuchando en :${config.port} (${config.environmentLabel})`);
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
