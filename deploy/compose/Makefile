# Yago Nexo · laboratorio local
COMPOSE = docker compose --env-file .env
PROFILES ?= --profile obs --profile legacy

.PHONY: env build up core down clean status logs bootstrap hosts

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

## Agrega los nombres de los servicios a /etc/hosts (solo en el entorno de desarrollo)
hosts:
	@grep -q "nexo-lab" /etc/hosts || echo "127.0.0.1 apim keycloak mi rabbitmq opensearch prometheus grafana jaeger # nexo-lab" | sudo tee -a /etc/hosts >/dev/null
	@echo "listo"
