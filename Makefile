# Euron Video System: developer entry points. `make` lists every target.
SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

COMPOSE_DIR   := deploy/compose
FLOCI         := docker compose -f $(COMPOSE_DIR)/compose.yaml -f $(COMPOSE_DIR)/compose.floci.yaml
AWS           := docker compose -f $(COMPOSE_DIR)/compose.yaml -f $(COMPOSE_DIR)/compose.aws.yaml
TF_IMAGE      := hashicorp/terraform:1.16.6
TF_ENVS       := local-floci aws-dev aws-prod
# Use a local terraform when installed, otherwise the pinned container.
TF            := $(shell command -v terraform >/dev/null 2>&1 && echo terraform || echo docker run --rm -v $(CURDIR)/infra/terraform:/infra -w /infra $(TF_IMAGE))
TF_ROOT       := $(shell command -v terraform >/dev/null 2>&1 && echo infra/terraform || echo /infra)

.PHONY: help env up up-aws down logs ps migrate key demo e2e test test-integration lint typecheck build tf-fmt tf-validate sanitize clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage: make \033[36m<target>\033[0m\n\n"} /^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

env: ## Generate deploy/compose/.env with random local-only secrets
	@scripts/demo/gen-local-env.sh

up: env ## Start the full stack on emulated AWS (Floci); provisions it with Terraform
	$(FLOCI) up -d --build
	@echo "console http://localhost:3000   api http://localhost:8080   floci http://localhost:4566"

up-aws: env ## Start the stack against real AWS (needs deploy/compose/.env.aws)
	@test -f $(COMPOSE_DIR)/.env.aws || { echo "copy $(COMPOSE_DIR)/.env.aws.example to .env.aws first"; exit 1; }
	$(AWS) up -d --build

down: ## Stop the stack and delete its volumes
	-$(FLOCI) down -v --remove-orphans
	-$(AWS) down -v --remove-orphans 2>/dev/null

logs: ## Tail logs (SERVICE=api|worker|orchestrator|...)
	$(FLOCI) logs -f --tail 100 $(SERVICE)

ps: ## Show stack status
	$(FLOCI) ps

migrate: ## Apply database migrations
	$(FLOCI) run --rm migrate pnpm db:migrate

key: ## Create a root API key (printed once)
	$(FLOCI) run --rm -T migrate pnpm --silent evs keys:create --name root --scopes '*'

demo: up ## Bring the stack up, create a key, and push a sample video through the pipeline
	@scripts/demo/seed.sh

e2e: env ## Full end-to-end test on Floci (EVS_E2E_KEEP=1 keeps the stack up)
	$(FLOCI) up -d --build
	scripts/demo/e2e.sh

test: ## Unit tests
	pnpm test

test-integration: env ## Integration tests (needs Postgres; starts one if TEST_DATABASE_URL is unset)
	@if [ -z "$$TEST_DATABASE_URL" ]; then \
	  docker compose -f $(COMPOSE_DIR)/compose.yaml up -d postgres && \
	  docker compose -f $(COMPOSE_DIR)/compose.yaml exec -T postgres sh -c 'until pg_isready -U evs; do sleep 1; done; psql -U evs -d evs -tc "SELECT 1 FROM pg_database WHERE datname='"'"'evs_test'"'"'" | grep -q 1 || psql -U evs -d evs -c "CREATE DATABASE evs_test"' && \
	  TEST_DATABASE_URL=postgres://evs:evs@localhost:$${EVS_PG_PORT:-5432}/evs_test pnpm test:integration; \
	else pnpm test:integration; fi

lint: ## Lint all packages
	pnpm lint

typecheck: ## Typecheck all packages
	pnpm typecheck

build: ## Build all packages
	pnpm build

tf-fmt: ## Format all Terraform
	$(TF) fmt -recursive $(TF_ROOT)

tf-validate: ## terraform validate every environment (no backend, no credentials)
	@for env in $(TF_ENVS); do \
	  echo "== $$env"; \
	  $(TF) -chdir=$(TF_ROOT)/envs/$$env init -backend=false -input=false -no-color >/dev/null && \
	  $(TF) -chdir=$(TF_ROOT)/envs/$$env validate -no-color || exit 1; \
	done

sanitize: ## Scan the tree for secrets and cloud identifiers that must never be committed
	@scripts/check-sanitization.sh

clean: ## Remove build output and local demo artifacts
	rm -rf apps/*/dist packages/*/dist .turbo samples .demo
	find infra/terraform -name .terraform -type d -prune -exec rm -rf {} +
