#!/bin/bash
# Give the roles from 01-roles.sql passwords, for the LOCAL DEVELOPMENT container only.
#
# 01-roles.sql deliberately creates every role without a password so that a half-finished
# bootstrap fails closed. That is the right default for a real deployment and useless for
# `docker compose up`, so this script closes the gap for the container and nowhere else.
#
# MANDATE_LOCAL_DEV=1 is required and is set only by infra/docker/compose.yaml. It is not a
# security control -- anyone who can run this can set the variable -- it is a guard against
# the specific accident of a DBA pasting the whole infra/postgres directory into a psql
# session against production and silently installing a known password on the owner role.
#
# The passwords never appear in argv (so never in `ps`) and never in a file. psql's `\getenv`
# reads them from this process's environment and `:'name'` quotes them as SQL literals, which
# is what stops a password containing a quote from becoming a SQL fragment.
set -euo pipefail

if [ "${MANDATE_LOCAL_DEV:-0}" != "1" ]; then
  echo "02-dev-passwords.sh refused to run: MANDATE_LOCAL_DEV is not 1." >&2
  echo "This script installs development passwords. Set production credentials out of band." >&2
  exit 1
fi

# Defaults match .env.example (postgres://mandate:mandate@localhost:55432/mandate) so a fresh
# clone runs with no extra configuration. Override any of them in the compose environment.
export MANDATE_OWNER_PASSWORD="${MANDATE_OWNER_PASSWORD:-mandate_owner}"
export MANDATE_APP_PASSWORD="${MANDATE_APP_PASSWORD:-mandate}"
export MANDATE_WORKER_PASSWORD="${MANDATE_WORKER_PASSWORD:-mandate_worker}"
export MANDATE_METRICS_PASSWORD="${MANDATE_METRICS_PASSWORD:-mandate_metrics}"

psql --set ON_ERROR_STOP=1 --no-psqlrc \
  --username "${POSTGRES_USER:-postgres}" --dbname "${POSTGRES_DB:-postgres}" <<'SQL'
\getenv owner_password MANDATE_OWNER_PASSWORD
\getenv app_password MANDATE_APP_PASSWORD
\getenv worker_password MANDATE_WORKER_PASSWORD
\getenv metrics_password MANDATE_METRICS_PASSWORD

ALTER ROLE mandate_owner   PASSWORD :'owner_password';
ALTER ROLE mandate         PASSWORD :'app_password';
ALTER ROLE mandate_worker  PASSWORD :'worker_password';
ALTER ROLE mandate_metrics PASSWORD :'metrics_password';
SQL

echo "Development passwords installed for mandate_owner, mandate, mandate_worker, mandate_metrics."
