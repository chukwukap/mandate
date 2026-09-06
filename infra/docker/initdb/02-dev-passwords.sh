#!/bin/bash
# Run infra/postgres/02-dev-passwords.sh during first-boot initialisation.
#
# Why a wrapper rather than mounting that file straight into /docker-entrypoint-initdb.d: the
# PostgreSQL entrypoint EXECUTES an init script only when it is executable, and otherwise
# SOURCES it into its own shell. The repository copy is committed 0644, so it would be sourced,
# and its `set -euo pipefail` would then apply to the rest of the entrypoint -- including `-u`,
# which the entrypoint was not written under -- and its `exit 1` guard would end the entrypoint
# rather than the script. This file is committed executable and runs the real one in a child
# process, so the repository file keeps its mode and the entrypoint keeps its shell options.
#
# The real script reads MANDATE_LOCAL_DEV and the MANDATE_*_PASSWORD variables from the
# environment compose sets; nothing is passed in argv, so no password reaches `ps`.
set -euo pipefail

exec bash /opt/mandate/postgres/02-dev-passwords.sh
