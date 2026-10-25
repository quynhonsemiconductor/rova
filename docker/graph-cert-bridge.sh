#!/bin/sh
# ECS bridge for the Graph Service-app certificate (ONPREM-PLAN §7.3).
#
# The app reads the credential from the FILE at AZURE_CLIENT_CERTIFICATE_PATH.
# On ECS there is no file mount yet: the task definition injects the standalone
# secret (rova-<env>-graph-cert, readable only by the worker's execution role)
# as the MAIL_GRAPH_CERTIFICATE environment value. This bridge materializes
# that value as a worker-only file and points platform-mail at it. When the
# on-prem k3s move mounts the file (or sets the federated token), the bridge
# is a no-op: a preset AZURE_CLIENT_CERTIFICATE_PATH always wins.
#
# Worker image only — the API container is never given the secret, so it never
# runs this script.
set -eu

cert_file="${GRAPH_CERT_FILE:-/tmp/rova-graph-cert.pem}"

if [ -n "${MAIL_GRAPH_CERTIFICATE:-}" ] && [ -z "${AZURE_CLIENT_CERTIFICATE_PATH:-}" ]; then
  (umask 077 && printf '%s\n' "$MAIL_GRAPH_CERTIFICATE" > "$cert_file")
  export AZURE_CLIENT_CERTIFICATE_PATH="$cert_file"
fi

# §7.3: the app reads the FILE; the PEM must not stay in the process env.
unset MAIL_GRAPH_CERTIFICATE || true

exec "$@"
