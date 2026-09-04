#!/usr/bin/env bash
# Rakazo production backup for the HDS deployment. Installed on the VM as
# /usr/local/sbin/rakazo-backup and run by upstream's infra/systemd units.
#
# This is upstream's infra/compose/backup-prod.sh with one change: the
# application-data archive is taken on the host, not through `compose exec api`.
#
# Why: the api container runs as uid 1000 with cap_drop ALL, and a bot computer
# writes its home as uid 0 (receipts, taught skills, .secrets/linear.token, all
# mode 600). Inside a cap-dropped container neither user can read the other's
# files, so upstream's tar exits 2 on every Docker-computer deployment and the
# archive it leaves behind is missing precisely the bot state. Root on the host
# has CAP_DAC_OVERRIDE and reads all of it. Candidate for an upstream PR.
set -euo pipefail

PROJECT_DIR="/opt/rakazo"
COMPOSE_FILE="${PROJECT_DIR}/infra/compose/docker-compose.prod.yml"
ENV_FILE="${PROJECT_DIR}/.env"
BACKUP_ROOT="/var/backups/rakazo"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT_DIR="${BACKUP_ROOT}/${STAMP}"

install -d -m 700 "${BACKUP_ROOT}" "${SNAPSHOT_DIR}"

compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

"${compose[@]}" exec -T postgres sh -c \
  'pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > "${SNAPSHOT_DIR}/rakazo.dump"

# Ask the running container where /data actually is, rather than rebuilding the
# volume name from a project name. `compose config` reports the file's own
# `name:` key and ignores an operator's -p or COMPOSE_PROJECT_NAME, so
# "<project>_appdata" would inspect the wrong volume on a renamed stack. This
# uses the same compose invocation as the pg_dump above, so both target one
# stack, and it stays correct if /data ever becomes a bind mount.
api="$("${compose[@]}" ps -q api)"
[[ -n "${api}" ]] || { echo "the api service is not running; cannot locate /data" >&2; exit 1; }
appdata="$(docker inspect "${api}" \
  --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')"
[[ -n "${appdata}" ]] || { echo "the api container has no /data mount" >&2; exit 1; }
# Bots write while this runs. GNU tar exits 1 for "file changed as we read it",
# which is expected on a live system and still yields a usable archive; only a
# fatal error (2) fails the backup.
rc=0
tar -czf "${SNAPSHOT_DIR}/appdata.tgz" --numeric-owner -C "${appdata}" . || rc=$?
if [[ "${rc}" -gt 1 ]]; then
  echo "appdata archive failed with tar exit ${rc}" >&2
  exit "${rc}"
fi

"${compose[@]}" exec -T postgres pg_restore --list \
  < "${SNAPSHOT_DIR}/rakazo.dump" >/dev/null
tar -tzf "${SNAPSHOT_DIR}/appdata.tgz" >/dev/null

sha256sum "${SNAPSHOT_DIR}/rakazo.dump" "${SNAPSHOT_DIR}/appdata.tgz" \
  > "${SNAPSHOT_DIR}/SHA256SUMS"
chmod 600 "${SNAPSHOT_DIR}"/*

# Keep seven daily snapshots. BACKUP_ROOT is intentionally fixed above so this
# cleanup can never expand to an environment-controlled or broad path.
find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -mtime +6 -exec rm -rf -- {} +

echo "Verified Rakazo backup written to ${SNAPSHOT_DIR}"
