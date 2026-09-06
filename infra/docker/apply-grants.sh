#!/bin/bash
# Apply the post-migration grants to the local development database.
#
#   docker compose -f infra/docker/compose.yaml up -d
#   bun run db:migrate            # as mandate_owner; creates mandate_v2 and the tables
#   infra/docker/apply-grants.sh  # then this
#
# These two files cannot live in /docker-entrypoint-initdb.d. They grant on tables that only
# exist after `bun run db:migrate`, and 03-grants.sql deliberately RAISEs when one is missing --
# during first-boot init that would abort the entrypoint and leave a half-built data directory
# that never runs the init files again. They are also not a one-time bootstrap step: 03 is
# authoritative rather than additive (it revokes before it grants) and a new table arrives with
# no privileges at all, so re-run this after every migration.
#
# psql runs inside the container as the `postgres` OS user over the unix socket, which is peer
# authentication -- no password is passed, prompted for, or written down here.
set -euo pipefail

cd "$(dirname "$0")"

for file in 03-grants.sql 04-metrics.sql; do
  echo "Applying ${file}"
  docker compose -f compose.yaml exec -T postgres \
    psql -v ON_ERROR_STOP=1 --no-psqlrc \
      --username "${POSTGRES_USER:-postgres}" \
      --dbname "${POSTGRES_DB:-mandate}" \
      -f "/opt/mandate/postgres/${file}"
done

echo "Grants applied. Re-run this after every migration."
