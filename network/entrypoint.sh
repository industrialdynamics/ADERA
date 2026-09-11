#!/bin/sh
# =============================================================================
# ADERA validator entrypoint
# -----------------------------------------------------------------------------
# Runs a Hyperledger Besu validator for the permissioned IBFT 2.0 ADERA
# network. Each validator is configured entirely from read-only mounts under
# /config; the only writable location is the data path on a named volume.
#
# Required environment variables (set per-service in docker-compose.yml):
#   ADERA_ROLE     human label, e.g. "cpo" or "emsp"
#   ADERA_P2P_HOST the static IP this node advertises to peers (must match the
#                   enode entry in static-nodes.json / permissions_config.toml)
# =============================================================================
set -eu

DATA_PATH="/opt/besu/data"
NODE_KEY_SRC="/config/keys/${ADERA_ROLE}/key"
STATIC_NODES_SRC="/config/static-nodes.json"
PERMISSIONS_SRC="/config/permissions_config.toml"
PERMISSIONS_RUNTIME="${DATA_PATH}/permissions_config.toml"

echo "[adera-validator-${ADERA_ROLE}] preparing data path at ${DATA_PATH}"
mkdir -p "${DATA_PATH}"

# Besu auto-loads <data-path>/static-nodes.json. The source is a read-only
# mount, so copy it into the writable data path.
cp "${STATIC_NODES_SRC}" "${DATA_PATH}/static-nodes.json"

# Besu REWRITES its permissions config in place (that is how the perm_* RPC
# methods persist allowlist changes). Pointing it at the repo copy would mean
# every run mutates a version-controlled file — and with two validators writing
# the same bind-mounted file, they can interleave and corrupt it outright. Copy
# it into the writable data path and let Besu own that copy instead, so the
# repo's checked-in allowlist stays the pristine source of truth and
# `docker compose down -v` genuinely returns a clean slate.
cp "${PERMISSIONS_SRC}" "${PERMISSIONS_RUNTIME}"

echo "[adera-validator-${ADERA_ROLE}] advertising p2p host ${ADERA_P2P_HOST}"
echo "[adera-validator-${ADERA_ROLE}] starting Besu (IBFT 2.0, permissioned)"

exec besu \
  --data-path="${DATA_PATH}" \
  --genesis-file=/config/genesis.json \
  --node-private-key-file="${NODE_KEY_SRC}" \
  --min-gas-price=0 \
  --host-allowlist="*" \
  --rpc-http-enabled=true \
  --rpc-http-host=0.0.0.0 \
  --rpc-http-port=8545 \
  --rpc-http-cors-origins="all" \
  --rpc-http-api=ETH,NET,WEB3,ADMIN,TXPOOL,IBFT,PERM \
  --rpc-ws-enabled=true \
  --rpc-ws-host=0.0.0.0 \
  --rpc-ws-port=8546 \
  --p2p-enabled=true \
  --p2p-host="${ADERA_P2P_HOST}" \
  --p2p-port=30303 \
  --discovery-enabled=false \
  --nat-method=NONE \
  --permissions-nodes-config-file-enabled=true \
  --permissions-accounts-config-file-enabled=true \
  --permissions-nodes-config-file="${PERMISSIONS_RUNTIME}" \
  --permissions-accounts-config-file="${PERMISSIONS_RUNTIME}"
