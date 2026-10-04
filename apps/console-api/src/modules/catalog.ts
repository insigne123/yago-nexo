import { Body, Controller, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { withTx, type Db } from "@nexo/console-db";
import type { MiManagementClient, Subscription, Wso2Client } from "@nexo/wso2-client";
import { CurrentUser, RequirePermission, type AuthUser } from "../auth/auth.js";
import { AuditService } from "../common/audit.service.js";
import { DB, MI, WSO2 } from "../common/tokens.js";
import { parse } from "../common/validation.js";
import { completeness, flowDependencies, hostOf, impactOf, pathOf, type GraphEdge, type GraphNode, type Row } from "./catalog-graph.js";

export function toApiAsset(r: Row) {
  const c = completeness(r);
  return {
    id: r.id,
    wso2ApiId: r.wso2_api_id,
    name: r.name,
    version: r.version,
    context: r.context,
    type: r.type,
    purpose: r.purpose ?? undefined,
    ownerTeam: r.owner_team ?? undefined,
    ownerContact: r.owner_contact ?? undefined,
    audience: r.audience ?? "interna",
    state: r.state,
    authType: r.auth_type ?? undefined,
    contractRef: r.contract_ref ?? undefined,
    classification: r.classification ?? undefined,
    consumersCount: r.consumers_count,
    dependenciesCount: r.dependencies_count,
    completeness: c.pct,
    updatedAt: r.updated_at,
    _missing: c.missing,
  };
}

const PatchSchema = z
  .object({
    purpose: z.string().max(1000),
    ownerTeam: z.string().max(200),
    ownerContact: z.string().max(200),
    audience: z.enum(["interna", "operadores", "publica"]),
    classification: z.enum(["publica", "interna", "reservada", "datos_personales"]),
    contractRef: z.string().max(300),
  })
  .partial();

const COLUMN: Record<string, string> = {
  purpose: "purpose",
  ownerTeam: "owner_team",
  ownerContact: "owner_contact",
  audience: "audience",
  classification: "classification",
  contractRef: "contract_ref",
};

/** Recurso de la Publisher API con la definición de cada tipo de API. */
const DEFINITION: Record<string, string> = { HTTP: "swagger", SOAP: "swagger", GRAPHQL: "graphql-schema", WS: "asyncapi", WEBSUB: "asyncapi", SSE: "asyncapi" };

interface WsoApiDetail {
  name: string;
  version: string;
  context: string;
  type?: string;
  description?: string;
  lifeCycleStatus?: string;
  additionalProperties?: Array<{ name: string; value: string }>;
  businessInformation?: Record<string, string>;
  securityScheme?: string[];
  endpointConfig?: { production_endpoints?: { url?: string } };
}

@Injectable()
export class CatalogService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WSO2) private readonly wso2: Wso2Client,
    @Inject(MI) private readonly mi: MiManagementClient,
  ) {}

  /** Sincroniza APIs, consumidores y suscripciones desde WSO2, y deriva dependencias de los endpoints y flujos MI. */
  async sync(): Promise<{ apis: number; consumers: number; subscriptions: number; retiradas: number; durationMs: number }> {
    const t0 = Date.now();
    // 1) Lectura completa (fuera de la transacción): WSO2 y el Integrador.
    const summaries = (await this.wso2.publisher.listApis(undefined, 500)).list;
    const apis: Array<{ id: string; detail: WsoApiDetail; subs: Subscription[] }> = [];
    for (const summary of summaries) {
      const detail = (await this.wso2.publisher.getApi(summary.id)) as unknown as WsoApiDetail;
      const subs = await this.wso2.publisher.listSubscriptions(summary.id).catch(() => ({ count: 0, list: [] as Subscription[] }));
      apis.push({ id: summary.id, detail, subs: subs.list });
    }
    const miApis = await this.mi.apis().catch(() => ({ list: [] as Array<{ name: string; url: string }> }));
    // La Management API del Integrador entrega la URL de cada API; su ruta identifica el flujo que la atiende.
    const miPaths = miApis.list.map((m) => ({ name: m.name, path: pathOf(m.url) })).filter((m) => m.path && m.path !== "/");
    const flows = new Map<string, string>();
    for (const m of miPaths) flows.set(m.name, (await this.mi.api(m.name).catch(() => undefined))?.configuration ?? "");
    const addresses = new Map<string, string>();
    for (const ep of (await this.mi.endpoints().catch(() => ({ list: [] as Array<{ name: string }> }))).list) {
      const d = await this.mi.endpoint(ep.name).catch(() => undefined);
      const uri = d?.address ?? d?.configuration?.match(/uri(?:-template)?="([^"]+)"/)?.[1];
      if (uri) addresses.set(ep.name, uri);
    }

    // 2) Escritura atómica: el grafo nunca queda a medio armar.
    return withTx(this.db, async (tx) => {
      const node = (id: string, type: string, label: string, meta: Record<string, unknown> = {}) =>
        tx.query(
          `INSERT INTO nexo.graph_node (id, type, label, meta) VALUES ($1,$2,$3,$4)
           ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, meta = nexo.graph_node.meta || EXCLUDED.meta`,
          [id, type, label, JSON.stringify(meta)],
        );
      const edge = (from: string, to: string, relation: string, source: "configuracion" | "analizador_mi") =>
        tx.query(`INSERT INTO nexo.graph_edge (from_id, to_id, relation, source) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [from, to, relation, source]);

      // Lo derivado se recalcula entero; lo cargado a mano o desde OpenMetadata se conserva.
      await tx.query(`DELETE FROM nexo.graph_edge WHERE source IN ('configuracion', 'analizador_mi')`);
      let subscriptions = 0;
      const consumers = new Set<string>();
      for (const { id: wso2Id, detail: a, subs } of apis) {
        const props = new Map((a.additionalProperties ?? []).map((p) => [p.name, p.value]));
        const id = `api:${wso2Id}`;
        const auth = (a.securityScheme ?? []).filter((s) => !s.includes("mandatory")).join(", ") || null;
        await tx.query(
          `INSERT INTO nexo.api_asset (id, wso2_api_id, name, version, context, type, purpose, owner_team, owner_contact, audience, state, auth_type, classification, contract_ref, synced_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), now())
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version, context = EXCLUDED.context,
             type = EXCLUDED.type, state = EXCLUDED.state, auth_type = EXCLUDED.auth_type,
             purpose = COALESCE(nexo.api_asset.purpose, EXCLUDED.purpose),
             owner_team = COALESCE(nexo.api_asset.owner_team, EXCLUDED.owner_team),
             owner_contact = COALESCE(nexo.api_asset.owner_contact, EXCLUDED.owner_contact),
             audience = COALESCE(nexo.api_asset.audience, EXCLUDED.audience),
             classification = COALESCE(nexo.api_asset.classification, EXCLUDED.classification),
             contract_ref = COALESCE(nexo.api_asset.contract_ref, EXCLUDED.contract_ref),
             synced_at = now()`,
          [
            id,
            wso2Id,
            a.name,
            a.version,
            a.context,
            a.type ?? "HTTP",
            props.get("proposito") ?? a.description ?? null,
            a.businessInformation?.businessOwner ?? null,
            a.businessInformation?.businessOwnerEmail ?? null,
            ["interna", "operadores", "publica"].includes(props.get("audiencia") ?? "") ? props.get("audiencia") : null,
            a.lifeCycleStatus ?? "CREATED",
            auth,
            ["publica", "interna", "reservada", "datos_personales"].includes(props.get("clasificacion") ?? "") ? props.get("clasificacion") : null,
            // Contrato versionado (lo registra nexo-ctl); si no, la definición publicada en el gateway.
            props.get("contrato") ?? `wso2:/apis/${wso2Id}/${DEFINITION[a.type ?? "HTTP"] ?? "swagger"}`,
          ],
        );
        await node(id, "api", `${a.name} ${a.version}`, { context: a.context, tipo: a.type });

        // Dependencia API → flujo del Integrador o sistema de destino, según el endpoint de producción.
        const url = a.endpointConfig?.production_endpoints?.url;
        const host = url ? hostOf(url) : undefined;
        if (url && host) {
          const endpointPath = pathOf(url);
          const miApi = miPaths.find((m) => endpointPath?.startsWith(m.path!) && /(^|\.)mi(:|$)/.test(host));
          if (miApi) {
            await node(`flujo:${miApi.name}`, "flujo", miApi.name, { integrador: host });
            await edge(id, `flujo:${miApi.name}`, "llama", "analizador_mi");
            for (const dep of flowDependencies(flows.get(miApi.name) ?? "", addresses)) {
              await node(dep.id, "sistema", dep.label, dep.meta);
              await edge(`flujo:${miApi.name}`, dep.id, dep.relation, "analizador_mi");
            }
          } else {
            await node(`sistema:${host}`, "sistema", host, { url });
            await edge(id, `sistema:${host}`, "llama", "configuracion");
          }
        }

        // Consumidores y suscripciones vigentes (las revocadas en WSO2 desaparecen).
        await tx.query("DELETE FROM nexo.subscription WHERE api_id = $1", [id]);
        for (const s of subs) {
          const appId = s.applicationInfo?.applicationId ?? s.applicationId;
          if (!appId) continue;
          consumers.add(appId);
          await tx.query(
            `INSERT INTO nexo.consumer (id, name, organization, updated_at) VALUES ($1,$2,$3, now())
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
            [appId, s.applicationInfo?.name ?? appId, s.applicationInfo?.subscriber ?? null],
          );
          await tx.query(
            `INSERT INTO nexo.subscription (consumer_id, api_id, plan, status) VALUES ($1,$2,$3,$4)
             ON CONFLICT (consumer_id, api_id) DO UPDATE SET plan = EXCLUDED.plan, status = EXCLUDED.status`,
            [appId, id, s.throttlingPolicy ?? null, s.status ?? null],
          );
          await node(`consumidor:${appId}`, "consumidor", s.applicationInfo?.name ?? appId);
          await edge(`consumidor:${appId}`, id, "consume", "configuracion");
          subscriptions++;
        }
      }

      // APIs que ya no existen en WSO2: quedan en el catálogo como retiradas, con su historia.
      const gone = await tx.query(
        `UPDATE nexo.api_asset SET state = 'RETIRED', updated_at = now()
         WHERE NOT (wso2_api_id = ANY($1::text[])) AND state <> 'RETIRED' RETURNING id`,
        [apis.map((x) => x.id)],
      );
      for (const r of gone.rows) {
        await tx.query(`INSERT INTO nexo.api_history (api_id, actor, action, detail) VALUES ($1, 'nexo-sync', 'api.retirada', 'La API ya no existe en el gateway')`, [r.id]);
      }
      await tx.query("DELETE FROM nexo.subscription WHERE NOT (api_id = ANY($1::text[]))", [apis.map((x) => `api:${x.id}`)]);
      // Nodos derivados que quedaron sin aristas (sistemas, flujos o consumidores que ya no participan).
      await tx.query(`DELETE FROM nexo.graph_node n WHERE n.type IN ('sistema', 'flujo', 'consumidor')
        AND NOT coalesce((n.meta->>'manual')::boolean, false)
        AND NOT EXISTS (SELECT 1 FROM nexo.graph_edge e WHERE e.from_id = n.id OR e.to_id = n.id)`);
      await tx.query(`UPDATE nexo.api_asset a SET
        consumers_count = (SELECT count(*) FROM nexo.subscription s WHERE s.api_id = a.id),
        dependencies_count = (SELECT count(*) FROM nexo.graph_edge e WHERE e.from_id = a.id)`);
      return { apis: apis.length, consumers: consumers.size, subscriptions, retiradas: gone.rowCount ?? 0, durationMs: Date.now() - t0 };
    });
  }

  async list(q?: string, audience?: string, state?: string) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q) where.push(`(name ILIKE $${params.push(`%${q}%`)} OR context ILIKE $${params.length} OR purpose ILIKE $${params.length})`);
    if (audience) where.push(`audience = $${params.push(audience)}`);
    if (state) where.push(`state = $${params.push(state)}`);
    const res = await this.db.query(`SELECT * FROM nexo.api_asset ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY name`, params);
    return res.rows.map((r) => {
      const { _missing, ...rest } = toApiAsset(r);
      void _missing;
      return rest;
    });
  }

  async get(id: string) {
    const res = await this.db.query("SELECT * FROM nexo.api_asset WHERE id = $1 OR wso2_api_id = $1", [id]);
    const row = res.rows[0];
    if (!row) throw new NotFoundException({ statusCode: 404, message: "La API no existe en el catálogo" });
    const { _missing, ...asset } = toApiAsset(row);
    const consumers = await this.db.query(
      `SELECT c.id, c.name, c.organization, s.plan, s.status FROM nexo.subscription s JOIN nexo.consumer c ON c.id = s.consumer_id WHERE s.api_id = $1 ORDER BY c.name`,
      [row.id],
    );
    const deps = await this.db.query(`SELECT from_id AS "from", to_id AS "to", relation, source FROM nexo.graph_edge WHERE from_id = $1 OR to_id = $1`, [row.id]);
    const history = await this.db.query(`SELECT ts, actor, action, detail FROM nexo.api_history WHERE api_id = $1 ORDER BY ts DESC LIMIT 50`, [row.id]);
    return { ...asset, consumers: consumers.rows, dependencies: deps.rows, missingFields: _missing, history: history.rows };
  }

  async patch(id: string, body: unknown, user: AuthUser) {
    const data = parse(PatchSchema, body);
    const current = await this.get(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      sets.push(`${COLUMN[k]} = $${params.push(v)}`);
    }
    if (sets.length) {
      params.push(current.id);
      await this.db.query(`UPDATE nexo.api_asset SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
      await this.db.query(`INSERT INTO nexo.api_history (api_id, actor, action, detail) VALUES ($1,$2,'metadatos.actualizados',$3)`, [
        current.id,
        user.username,
        Object.keys(data).join(", "),
      ]);
    }
    return this.get(String(current.id));
  }

  async graph() {
    const nodes = await this.db.query(`SELECT id, type, label, meta FROM nexo.graph_node ORDER BY type, label`);
    const edges = await this.db.query(`SELECT from_id AS "from", to_id AS "to", relation, source FROM nexo.graph_edge`);
    return { nodes: nodes.rows, edges: edges.rows };
  }

  /**
   * Análisis de impacto (BT-024): todo lo que depende, directa o indirectamente, del nodo que cambia.
   * Las aristas van de quien depende hacia lo que usa, así que se recorren al revés.
   */
  async impact(nodeId: string, kind: string, detail?: string) {
    const { nodes, edges } = await this.graph();
    if (!nodes.some((n) => n.id === nodeId)) throw new NotFoundException({ statusCode: 404, message: "El nodo no existe en el grafo" });
    return { nodeId, change: { kind, detail }, ...impactOf(nodes as GraphNode[], edges as GraphEdge[], nodeId, kind) };
  }
}

const ImpactSchema = z.object({
  nodeId: z.string().min(1),
  change: z.object({ kind: z.enum(["contrato", "campo", "fuente", "retiro"]), detail: z.string().max(500).optional() }),
});

@Controller()
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly audit: AuditService,
  ) {}

  @Get("apis")
  @RequirePermission("catalog:read")
  list(@Query("q") q?: string, @Query("audience") audience?: string, @Query("state") state?: string) {
    return this.catalog.list(q, audience, state);
  }

  @Get("apis/:id")
  @RequirePermission("catalog:read")
  get(@Param("id") id: string) {
    return this.catalog.get(id);
  }

  @Patch("apis/:id")
  @RequirePermission("catalog:write")
  async patch(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const res = await this.catalog.patch(id, body, user);
    await this.audit.record(user, "catalogo.actualizar", `api/${res.id}`, "exito", { campos: Object.keys(body as object) });
    return res;
  }

  @Post("catalog/sync")
  @HttpCode(200)
  @RequirePermission("catalog:write")
  async sync(@CurrentUser() user: AuthUser) {
    const res = await this.catalog.sync();
    await this.audit.record(user, "catalogo.sincronizar", "wso2", "exito", res);
    return res;
  }

  @Get("graph")
  @RequirePermission("catalog:read")
  graph() {
    return this.catalog.graph();
  }

  @Post("impact/simulate")
  @HttpCode(200)
  @RequirePermission("impact:simulate")
  async impact(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    const req = parse(ImpactSchema, body);
    const res = await this.catalog.impact(req.nodeId, req.change.kind, req.change.detail);
    await this.audit.record(user, "impacto.simular", req.nodeId, "exito", { tipo: req.change.kind, severidad: res.severity });
    return res;
  }
}
