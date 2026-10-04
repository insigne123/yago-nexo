import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { createPool } from "@nexo/console-db";
import { MiManagementClient, Wso2Client } from "@nexo/wso2-client";
import { AuthGuard } from "./auth/auth.js";
import { AuditService } from "./common/audit.service.js";
import { DB, MI, WSO2 } from "./common/tokens.js";
import { config } from "./config.js";
import { OpenSearchService, PrometheusService, RabbitService, TlsProbeService } from "./integrations/integrations.js";
import { AnomaliesController } from "./modules/anomalies.js";
import { CatalogController, CatalogService } from "./modules/catalog.js";
import { ContinuityController } from "./modules/continuity.js";
import { DeadLettersController } from "./modules/dead-letters.js";
import { DiscoveryController } from "./modules/discovery.js";
import { AlertsController, AuditController, ComplianceController, EnginesController, ExportsController, HealthController, SessionController } from "./modules/platform.js";
import { RolloutsController, TrafficRoutesController } from "./modules/rollouts.js";
import { UsageController, UsageService } from "./modules/usage.js";

@Module({
  controllers: [
    HealthController,
    SessionController,
    CatalogController,
    DiscoveryController,
    AnomaliesController,
    RolloutsController,
    TrafficRoutesController,
    ContinuityController,
    UsageController,
    DeadLettersController,
    AuditController,
    ComplianceController,
    ExportsController,
    AlertsController,
    EnginesController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: DB, useFactory: () => createPool(config.databaseUrl) },
    {
      provide: WSO2,
      useFactory: () =>
        new Wso2Client({
          baseUrl: config.wso2.url,
          auth: { type: "basic", username: config.wso2.user, password: config.wso2.password },
          tls: { rejectUnauthorized: !config.wso2.insecureTls },
        }),
    },
    {
      provide: MI,
      useFactory: () => new MiManagementClient(config.mi.url, config.mi.user, config.mi.password, { rejectUnauthorized: !config.wso2.insecureTls }),
    },
    AuditService,
    CatalogService,
    UsageService,
    OpenSearchService,
    PrometheusService,
    RabbitService,
    TlsProbeService,
  ],
})
export class AppModule {}
