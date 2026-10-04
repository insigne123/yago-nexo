# Yago Nexo · laboratorio local
COMPOSE = docker compose --env-file .env
PROFILES ?= --profile obs --profile legacy

.PHONY: env build up core down clean status logs bootstrap hosts platform deploy-apis

env:
	@test -f .env || cp .env.example .env

build: env
	cd ../.. && pnpm --filter @nexo/demo-backends build
	$(COMPOSE) $(PROFILES) build

## Levanta todo el laboratorio
up: build
	$(COMPOSE) $(PROFILES) up -d
	@$(MAKE) --no-print-directory status

## Solo el núcleo (WSO2, Keycloak, PostgreSQL, RabbitMQ y backends)
core: build
	$(COMPOSE) up -d
	@$(MAKE) --no-print-directory status

down:
	$(COMPOSE) $(PROFILES) down

## Borra también los volúmenes (datos del laboratorio)
clean:
	$(COMPOSE) $(PROFILES) down -v

status:
	@$(COMPOSE) $(PROFILES) ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'

logs:
	$(COMPOSE) $(PROFILES) logs -f --tail=100 $(S)

## Configura WSO2 y Keycloak (Key Manager, APIs de ejemplo, aplicación y suscripción)
bootstrap:
	cd ../.. && pnpm --filter @nexo/lab-bootstrap start

## Aplica la plataforma como código (ambientes, tráfico, aprobaciones y gobierno)
platform:
	cd ../../tools/nexo-ctl && set -a && . ../../deploy/compose/.env && set +a && npx tsx src/cli.ts -c ../../nexo-ctl.config.yaml platform apply -s prod -f ../../wso2/apim/platform.yaml

## Despliega las APIs versionadas en las tres etapas
deploy-apis:
	cd ../../tools/nexo-ctl && set -a && . ../../deploy/compose/.env && set +a && for st in dev qa prod; do npx tsx src/cli.ts -c ../../nexo-ctl.config.yaml api deploy ../../wso2/apim/apis/concesiones -s $$st -m "make deploy-apis"; done

## Agrega los nombres de los servicios a /etc/hosts (solo en el entorno de desarrollo)
hosts:
	@grep -q "nexo-lab" /etc/hosts || echo "127.0.0.1 apim keycloak mi rabbitmq opensearch prometheus grafana jaeger otel-collector dev.nexo.lab qa.nexo.lab operadores.nexo.lab publico.nexo.lab # nexo-lab" | sudo tee -a /etc/hosts >/dev/null
	@echo "listo"
