#!/usr/bin/env bash
# =============================================================================
# ADERA PoC — live verification / demo script
# -----------------------------------------------------------------------------
# Walks the five claims the sandbox exists to demonstrate, checking each against
# the RUNNING stack rather than repeating what the documents assert:
#
#   1. Consensus is live and permissioned
#   2. The registry deployed and governance executed (multisig admission)
#   3. The regulator's oversight is recorded on-chain
#   4. Discovery + the signed handshake completed end to end
#   5. Forged, replayed and mis-declared handshakes are rejected
#
# Usage:
#   docker compose up --build -d      # then, once the gateways settle:
#   ./demo/verify.sh
#
# Exits non-zero if any check fails, so it doubles as a smoke test.
# Requires only docker and curl on the host.
# =============================================================================
set -uo pipefail

CPO_RPC="${CPO_RPC:-http://localhost:8545}"
CPO_HEALTH="${CPO_HEALTH:-http://localhost:9101}"
EMSP_HEALTH="${EMSP_HEALTH:-http://localhost:9102}"

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; B=$'\e[1m'; D=$'\e[2m'; O=$'\e[0m'
failures=0

section() { printf '\n%s=== %s ===%s\n\n' "$B" "$1" "$O"; }
pass()    { printf '  %sPASS%s  %s\n' "$G" "$O" "$1"; }
fail()    { printf '  %sFAIL%s  %s\n' "$R" "$O" "$1"; failures=$((failures + 1)); }
info()    { printf '        %s%s%s\n' "$D" "$1" "$O"; }

rpc() {
  curl -s -X POST "$CPO_RPC" -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"method\":\"$1\",\"params\":$2,\"id\":1}"
}

# --- 1. Consensus -------------------------------------------------------------
section "1. Consensus is live and permissioned"

height_hex=$(rpc eth_blockNumber '[]' | grep -o '"result":"[^"]*"' | cut -d'"' -f4)
if [ -n "${height_hex:-}" ] && [ "$((height_hex))" -gt 0 ]; then
  pass "chain is producing blocks (height $((height_hex)))"
else
  fail "chain height is 0 or unreachable — are both validators up?"
fi

validators=$(rpc ibft_getValidatorsByBlockNumber '["latest"]')
count=$(printf '%s' "$validators" | grep -o '0x[0-9a-f]\{40\}' | wc -l | tr -d ' ')
if [ "$count" -eq 2 ]; then
  pass "IBFT 2.0 validator set has both founders"
  printf '%s' "$validators" | grep -o '0x[0-9a-f]\{40\}' | while read -r v; do info "$v"; done
else
  fail "expected 2 validators, found $count"
fi

peers=$(rpc net_peerCount '[]' | grep -o '"result":"[^"]*"' | cut -d'"' -f4)
if [ "${peers:-0x0}" = "0x1" ]; then
  pass "validators are peered with each other"
else
  fail "peer count is ${peers:-unknown}, expected 0x1"
fi

# --- 2. Registry + governance -------------------------------------------------
section "2. Registry deployed, governance executed"

deployer_log=$(docker compose logs adera-contract-deployer 2>/dev/null)

check_log() { # <pattern> <description>
  if printf '%s' "$deployer_log" | grep -q "$1"; then
    pass "$2"
    info "$(printf '%s' "$deployer_log" | grep -m1 "$1" | sed 's/^[^|]*| //')"
  else
    fail "$2"
  fi
}

check_log 'AderaRegistry deployed at'    "registry contract deployed"
check_log 'executed=true'                "multisig proposal reached threshold and executed"
check_log 'admitted & active = true'     "third party (LK/EVX) admitted by vote, not by signup"

# --- 3. Regulator oversight ---------------------------------------------------
section "3. Regulator oversight recorded on-chain"

check_log 'ComplianceProbe mined'        "regulator's attestation is in a block, permanently"

# --- 4. Discovery + signed handshake ------------------------------------------
section "4. Discovery and the signed handshake"

cpo_log=$(docker compose logs adera-gateway-cpo 2>/dev/null)
emsp_log=$(docker compose logs adera-gateway-emsp 2>/dev/null)

if printf '%s' "$cpo_log" | grep -q 'decrypted peer OCPI endpoint'; then
  pass "peer found on-chain and its encrypted endpoint decrypted"
  info "$(printf '%s' "$cpo_log" | grep -m1 'decrypted peer OCPI endpoint' | sed 's/^[^|]*| //')"
else
  fail "CPO gateway never resolved its peer from the ledger"
fi

if printf '%s' "$emsp_log" | grep -q 'INBOUND verified'; then
  pass "receiver authenticated the sender against its on-chain public key"
  info "$(printf '%s' "$emsp_log" | grep -m1 'INBOUND verified' | sed 's/^[^|]*| //')"
else
  fail "eMSP gateway never verified an inbound handshake"
fi

if printf '%s' "$cpo_log" | grep -q 'roaming session established'; then
  pass "full round trip: discovery, handshake, settlement"
else
  fail "end-to-end roaming session did not complete"
fi

for url in "$CPO_HEALTH" "$EMSP_HEALTH"; do
  body=$(curl -s --max-time 5 "$url/health")
  if printf '%s' "$body" | grep -q '"status":"ok"'; then
    pass "gateway healthy: $url"
    info "$body"
  else
    fail "gateway not healthy: $url"
  fi
done

# --- 5. Attacks ---------------------------------------------------------------
section "5. Impersonation and replay are rejected"

# An outsider holding no key at all — the easy case.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST \
  "$EMSP_HEALTH/party/LK/EMS/ocpi/2.2.1/credentials" \
  -H 'Authorization: Token ADERA-REG-TOKEN-A' \
  -H 'Content-Type: application/json' \
  -H 'X-ADERA-Party: 0xdeadbeef' \
  -H 'X-ADERA-Signature: 0x00' \
  --data '{"token":"forged"}')
if [ "$code" = "401" ] || [ "$code" = "403" ]; then
  pass "unsigned forgery by an outsider rejected ($code)"
else
  fail "unsigned forgery returned $code, expected 401/403"
fi

# The harder case: attacks by a party that IS admitted and DOES hold a valid key.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if docker cp "$script_dir/attack-suite.js" adera-gateway-cpo:/tmp/attack-suite.js >/dev/null 2>&1; then
  if docker exec adera-gateway-cpo node /tmp/attack-suite.js; then
    pass "every handshake attack by an admitted party was rejected"
  else
    fail "one or more handshake attacks were not rejected as expected"
  fi
else
  fail "could not copy the attack suite into adera-gateway-cpo (is it running?)"
fi

# --- Summary ------------------------------------------------------------------
if [ "$failures" -eq 0 ]; then
  printf '\n%sAll checks passed.%s The stack is doing what the documents claim.\n\n' "$G$B" "$O"
  exit 0
else
  printf '\n%s%d check(s) failed.%s See docker compose logs for detail.\n\n' "$R$B" "$failures" "$O"
  exit 1
fi
