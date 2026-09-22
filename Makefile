SHELL := /bin/bash

.PHONY: doctor setup avds emulators infra dev test smoke benchmark demo fault-demo down deploy

doctor:
	./scripts/doctor.sh

setup:
	pnpm install
	@test -f .env || cp .env.example .env
	@echo "setup complete"

avds:
	./scripts/create-avds.sh

emulators:
	./scripts/start-emulators.sh

infra:
	@if pgrep -x redis-server >/dev/null; then \
		echo "redis-server already running"; \
	elif command -v redis-server >/dev/null; then \
		redis-server --daemonize yes --port 6379 --appendonly yes --dir /tmp/lab-redis 2>/dev/null \
			|| (mkdir -p /tmp/lab-redis && redis-server --daemonize yes --port 6379 --appendonly yes --dir /tmp/lab-redis); \
		echo "redis-server started"; \
	else \
		docker compose up -d redis; \
	fi

dev:
	pnpm dev

test:
	pnpm test

smoke:
	pnpm smoke

benchmark:
	pnpm benchmark

demo:
	pnpm demo

fault-demo:
	./scripts/fault-kill-server.sh

down:
	./scripts/stop-emulators.sh
	@pkill -f "tsx.*apps/server" 2>/dev/null || true
	@echo "app stopped; redis and evidence left running (stop redis manually if desired)"

deploy:
	flyctl deploy -c fly.redis.toml -y
	flyctl deploy -c fly.api.toml --remote-only -y
	flyctl deploy -c fly.web.toml --remote-only -y
