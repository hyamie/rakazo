#!/usr/bin/env bash
# Deploy Rakazo on this host from the checked-out branch.
#
# Compose takes the project directory from the first -f file (infra/compose), so
# every relative path in both compose files resolves from there. Do not add
# --project-directory: it repoints the prod file's `env_file: ../../.env` at
# /.env and nothing resolves.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "missing $ROOT/.env" >&2
  exit 1
fi

# Stamp the running revision so /health can report what is actually deployed.
GIT_SHA="$(git rev-parse --short HEAD)"
sed -i "s|^GIT_SHA=.*|GIT_SHA=${GIT_SHA}|" .env

COMPOSE=(docker compose
  --env-file "$ROOT/.env"
  -f infra/compose/docker-compose.prod.yml
  -f ops/compose/docker-compose.sandbox.yml)

case "${1:-up}" in
  config)  "${COMPOSE[@]}" config ;;
  # --force-recreate because Compose keys a container's config hash off the
  # rendered service definition, and an edit to .env that only changes an
  # interpolated bind-mount source can leave a running container on the old
  # file. That is not hypothetical: Caddy sat on the upstream Caddyfile through
  # a redeploy and kept retrying a public ACME issuance for app.example.com.
  up)      "${COMPOSE[@]}" up -d --build --force-recreate ;;
  down)    "${COMPOSE[@]}" down ;;
  logs)    shift; "${COMPOSE[@]}" logs -f "$@" ;;
  ps)      "${COMPOSE[@]}" ps ;;
  *)       "${COMPOSE[@]}" "$@" ;;
esac
