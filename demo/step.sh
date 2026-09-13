#!/usr/bin/env bash
# =============================================================================
# ADERA PoC — STEP-BY-STEP bring-up
# -----------------------------------------------------------------------------
# `docker compose up` starts all five containers at once and the logs interleave,
# which makes it hard to see what each one actually contributes. This script
# starts them ONE AT A TIME, pausing between each, and shows the observable
# state change that container caused.
#
# Usage:
#   ./demo/step.sh              # interactive: press ENTER between steps
#   ./demo/step.sh --auto       # no pauses (CI / smoke run)
#   ./demo/step.sh --keep       # do NOT wipe existing state before starting
#
# Anything already running is torn down first (unless --keep), so the walkthrough
# always starts from an empty chain.
# =============================================================================
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

AUTO=0; KEEP=0
for a in "$@"; do
  case "$a" in
    --auto) AUTO=1 ;;
    --keep) KEEP=1 ;;
    *) echo "unknown flag: $a (use --auto and/or --keep)"; exit 2 ;;
  esac
done

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; B=$'\e[1m'; D=$'\e[2m'; O=$'\e[0m'

step()  { printf '\n%s%s══ STEP %s ══%s\n' "$B" "$C" "$1" "$O"; }
say()   { printf '%s  %s%s\n' "$D" "$1" "$O"; }
ok()    { printf '  %s✔%s %s\n' "$G" "$O" "$1"; }
bad()   { printf '  %s✘%s %s\n' "$R" "$O" "$1"; }
run()   { printf '\n%s  $ %s%s\n' "$Y" "$1" "$O"; }

pause() {
  [ "$AUTO" = "1" ] && return 0
  printf '\n%s  [ENTER to continue]%s ' "$B" "$O"
  read -r _ </dev/tty || true
}

# RPC helper against the CPO validator on the host.
rpc() {
  curl -s --max-time 5 -X POST http://localhost:8545 \
    -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"method\":\"$1\",\"params\":${2:-[]},\"id\":1}"
}
result() { grep -o '"result":"[^"]*"' | cut -d'"' -f4; }

# -----------------------------------------------------------------------------
step "0 — clean slate"
# -----------------------------------------------------------------------------
say "Every container is stopped and every named volume (chain data, the shared"
say "deployment manifest, the gateway CDR queues) is deleted, so the walkthrough"
say "starts from genesis with nothing carried over from a previous run."
if [ "$KEEP" = "1" ]; then
  say "--keep given: skipping teardown."
else
  run "docker compose down -v"
  docker compose down -v
fi
say "Nothing is running now:"
run "docker compose ps"
docker compose ps
pause

# -----------------------------------------------------------------------------
step "1 — the FIRST validator alone (adera-validator-cpo)"
# -----------------------------------------------------------------------------
say "Starting ONE Besu node. --no-deps means compose starts only this service"
say "and ignores the depends_on graph, so nothing else comes up with it."
run "docker compose up -d --no-deps adera-validator-cpo"
docker compose up -d --no-deps adera-validator-cpo

say "Waiting for its JSON-RPC port to answer..."
for i in $(seq 1 60); do
  [ -n "$(rpc web3_clientVersion | result)" ] && break
  sleep 1
done

say ""
say "The node is up and answering RPC — but watch the block height."
run "curl -X POST localhost:8545 -d '{...eth_blockNumber...}'   # x3, 4s apart"
h1=$(rpc eth_blockNumber | result); printf '        height = %s\n' "${h1:-?}"
sleep 4
h2=$(rpc eth_blockNumber | result); printf '        height = %s\n' "${h2:-?}"
sleep 4
h3=$(rpc eth_blockNumber | result); printf '        height = %s\n' "${h3:-?}"

if [ "${h1:-}" = "${h3:-}" ]; then
  ok "height is STUCK at $((${h3:-0x0})) — and that is the correct behaviour."
else
  bad "height moved ($h1 -> $h3); expected it to be stuck with one validator."
fi
say ""
say "THIS IS THE POINT OF STEP 1. QBFT needs a supermajority of the"
say "validator set to finalise a block. The set has two members (both are"
say "written into genesis.json's extraData), so one node on its own can"
say "propose but can never finalise. A permissioned chain does not 'just run'"
say "because a node is running — it runs because a quorum agrees."
run "curl ... net_peerCount"
p=$(rpc net_peerCount | result); printf '        peers = %s  (nobody to agree with)\n' "${p:-?}"
pause

# -----------------------------------------------------------------------------
step "2 — the SECOND validator (adera-validator-emsp) → quorum"
# -----------------------------------------------------------------------------
say "The eMSP founder's node. It finds the CPO node through static-nodes.json"
say "(fixed enode @ 172.28.0.12 / .11 — P2P discovery is disabled on purpose),"
say "and both nodes check each other against permissions_config.toml before"
say "accepting the connection."
run "docker compose up -d --no-deps adera-validator-emsp"
docker compose up -d --no-deps adera-validator-emsp

say "Waiting for the two to peer and start finalising..."
for i in $(seq 1 60); do
  [ "$(rpc net_peerCount | result)" = "0x1" ] && break
  sleep 1
done
sleep 6

p=$(rpc net_peerCount | result)
[ "${p:-0x0}" = "0x1" ] && ok "net_peerCount = 0x1 — the validators found each other" \
                        || bad "net_peerCount = ${p:-?}, expected 0x1"

hA=$(rpc eth_blockNumber | result); sleep 5; hB=$(rpc eth_blockNumber | result)
if [ "$((${hB:-0x0}))" -gt "$((${hA:-0x0}))" ]; then
  ok "height is now CLIMBING: $((${hA:-0x0})) -> $((${hB:-0x0})). Quorum reached."
else
  bad "height still stuck at $((${hB:-0x0}))"
fi

say ""
say "And the chain will name its validator set:"
run "curl ... qbft_getValidatorsByBlockNumber [\"latest\"]"
rpc qbft_getValidatorsByBlockNumber '["latest"]' | grep -o '0x[0-9a-f]\{40\}' \
  | while read -r v; do printf '        %s\n' "$v"; done
say ""
say "Nothing has been deployed yet. There is a chain, and that is all."
pause

# -----------------------------------------------------------------------------
step "3 — the deployer (adera-contract-deployer) — runs once, then exits"
# -----------------------------------------------------------------------------
say "This is the container people find confusing, because it is NOT a service:"
say "it is a one-shot job (restart: \"no\") that is SUPPOSED to exit 0 and stay"
say "exited. Run in the foreground so its whole story streams past:"
say ""
say "  compiles AderaRegistry.sol with bare solc"
say "  deploys it, seeding the two founding parties"
say "  CPO founder PROPOSES admitting a third party (LK/EVX)"
say "  eMSP founder CONFIRMS -> 2/2 threshold -> auto-executes"
say "  the regulator's auditor key emits an on-chain ComplianceProbe"
say "  writes /shared/deployment.json"
run "docker compose up --no-deps adera-contract-deployer"
pause
docker compose up --no-deps adera-contract-deployer

rc=$(docker inspect -f '{{.State.ExitCode}}' adera-contract-deployer 2>/dev/null)
[ "${rc:-1}" = "0" ] && ok "deployer exited 0 — this is success, not a crash" \
                     || bad "deployer exited ${rc:-?}"
say ""
say "THIS IS THE LINK BETWEEN THE CONTAINERS. The deployer's only lasting"
say "output is one file on the 'adera-shared' named volume. The gateways mount"
say "that same volume READ-ONLY. It is how they learn the registry's address"
say "and ABI without anyone hardcoding them:"
run "docker run --rm -v adera-shared:/s alpine cat /s/deployment.json"
docker run --rm -v adera-shared:/s alpine \
  sh -c 'head -c 400 /s/deployment.json; echo; echo "        ...(ABI continues)"' 2>/dev/null \
  | sed 's/^/        /'
say ""
say "That is also why compose gates the gateways on"
say "'condition: service_completed_successfully' — no manifest, no gateway."
pause

# -----------------------------------------------------------------------------
step "4 — the RECEIVER gateway (adera-gateway-emsp)"
# -----------------------------------------------------------------------------
say "Started first, deliberately. This tenant (LK/EMS) has no PEER configured,"
say "so it never initiates anything — it boots, reads the manifest, connects to"
say "its OWN validator (the eMSP node, not the CPO's), serves OCPI 2.2.1 at"
say "/party/LK/EMS/... and then waits."
run "docker compose up -d --no-deps adera-gateway-emsp"
docker compose up -d --no-deps adera-gateway-emsp

for i in $(seq 1 45); do
  curl -s --max-time 3 http://localhost:9102/health | grep -q '"status":"ok"' && break
  sleep 1
done
run "docker compose logs adera-gateway-emsp"
docker compose logs --no-log-prefix adera-gateway-emsp 2>/dev/null | sed 's/^/        /'
say ""
curl -s --max-time 5 http://localhost:9102/health | grep -q '"status":"ok"' \
  && ok "receiver is listening and idle — 'awaiting inbound handshakes'" \
  || bad "receiver did not come up healthy"
say ""
say "Note there is no traffic at all yet. Nothing pushed it a peer list; it"
say "does not know or care who will call."
pause

# -----------------------------------------------------------------------------
step "5 — the INITIATOR gateway (adera-gateway-cpo) — the actual demo"
# -----------------------------------------------------------------------------
say "LK/CPO has TENANT_1_PEER_ID=EMS and TENANT_1_INITIATE=true, so on boot it"
say "drives the whole roaming flow. Watch for these five moves:"
say ""
say "  discover   looks LK/EMS up ON-CHAIN — not in a config file, not via a hub"
say "  discover   AES-GCM-DECRYPTS the peer's endpoint (it is confidential on-chain)"
say "  handshake  OCPI 2.2.1 versions -> version detail -> credentials POST,"
say "             SIGNED with its messaging key"
say "  settle     opens a settlement channel on the mock 'mandate-rail' plugin"
say "  settle     pushes a CDR through the durable offline queue and settles it"
say ""
say "Meanwhile the eMSP side verifies the signature against the pubKey it reads"
say "from the LEDGER. Started in this order there are no 'attempt N/30 failed'"
say "retries — those only appear when the initiator beats the receiver up."
run "docker compose up -d --no-deps adera-gateway-cpo"
pause
docker compose up -d --no-deps adera-gateway-cpo

say "Following the initiator until the round trip completes..."
for i in $(seq 1 60); do
  docker compose logs adera-gateway-cpo 2>/dev/null | grep -q 'roaming session established' && break
  sleep 1
done
say ""
printf '%s        ── adera-gateway-cpo (initiator) ──%s\n' "$B" "$O"
docker compose logs --no-log-prefix adera-gateway-cpo 2>/dev/null | sed 's/^/        /'
say ""
printf '%s        ── adera-gateway-emsp (receiver), the other side of the same call ──%s\n' "$B" "$O"
docker compose logs --no-log-prefix adera-gateway-emsp 2>/dev/null \
  | grep -E 'INBOUND|webhook-in|settle' | sed 's/^/        /'
say ""
docker compose logs adera-gateway-cpo 2>/dev/null | grep -q 'roaming session established' \
  && ok "end-to-end roaming session established" \
  || bad "round trip did not complete — see the logs above"
docker compose logs adera-gateway-emsp 2>/dev/null | grep -q 'INBOUND verified' \
  && ok "receiver authenticated the caller against its on-chain public key" \
  || bad "receiver never verified an inbound handshake"
pause

# -----------------------------------------------------------------------------
step "6 — all five containers, and what talks to what"
# -----------------------------------------------------------------------------
run "docker compose ps -a"
docker compose ps -a
say ""
cat <<'DIAGRAM'
        host :8545 :8547            host :9101      host :9102
             │       │                   │               │
        ┌────┴───────┴────┐         ┌────┴────┐     ┌────┴────┐
        │   validator-cpo │◄──P2P──►│         │     │         │
        │   172.28.0.11   │  QBFT   │ gateway │     │ gateway │
        │        ▲        │ 2 of 2  │  -cpo   │────►│  -emsp  │
        │        │        │         │ LK/CPO  │OCPI │ LK/EMS  │
        │   validator-emsp│         │         │HTTP │         │
        │   172.28.0.12   │◄────────┤         │     │         │
        └────┬────────────┘  JSON   └────┬────┘     └────┬────┘
             │  JSON-RPC        RPC      │               │
             │                           │ reads         │ reads
        ┌────┴──────────────┐            ▼               ▼
        │ contract-deployer │      ┌─────────────────────────┐
        │  (ran once, gone) │─────►│ volume: adera-shared    │
        └───────────────────┘ wrote│   /shared/deployment.json│
                                   └─────────────────────────┘

        Three things — and ONLY these three — connect the containers:
          1. the adera-net bridge  → they resolve each other by container name
          2. the adera-shared volume → deployer writes the manifest, gateways read it
          3. depends_on in compose  → validators, then deployer (must exit 0), then gateways

        The CPO gateway never talks to the eMSP gateway through the chain. It
        uses the chain to FIND and AUTHENTICATE it, then calls it directly.
        That is the "hubless" claim, working.
DIAGRAM
pause

# -----------------------------------------------------------------------------
step "7 — now break it on purpose"
# -----------------------------------------------------------------------------
say "An outsider with no key POSTs a forged credentials handshake:"
run "curl -X POST localhost:9102/party/LK/EMS/ocpi/2.2.1/credentials  (garbage signature)"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST \
  "http://localhost:9102/party/LK/EMS/ocpi/2.2.1/credentials" \
  -H 'Authorization: Token ADERA-REG-TOKEN-A' \
  -H 'Content-Type: application/json' \
  -H 'X-ADERA-Party: 0xdeadbeef' \
  -H 'X-ADERA-Signature: 0x00' \
  --data '{"token":"forged"}')
{ [ "$code" = "401" ] || [ "$code" = "403" ]; } \
  && ok "rejected with HTTP $code" || bad "got HTTP $code, expected 401/403"

say ""
say "The easy case. The interesting one is an attacker who IS admitted to the"
say "consortium and DOES hold a valid key — replay, stale timestamp, and"
say "declaring itself to be a different party:"
run "docker cp demo/attack-suite.js adera-gateway-cpo:/tmp/ && docker exec adera-gateway-cpo node /tmp/attack-suite.js"
pause
docker cp demo/attack-suite.js adera-gateway-cpo:/tmp/attack-suite.js >/dev/null 2>&1 \
  && docker exec adera-gateway-cpo node /tmp/attack-suite.js

say ""
printf '%s        ── the receiver logging each rejection ──%s\n' "$B" "$O"
docker compose logs --no-log-prefix adera-gateway-emsp 2>/dev/null \
  | grep -i 'SECURITY' | sed 's/^/        /' | tail -20
pause

# -----------------------------------------------------------------------------
step "8 — full check"
# -----------------------------------------------------------------------------
say "demo/verify.sh re-checks all five claims against the running stack."
run "./demo/verify.sh"
pause
./demo/verify.sh
rc=$?

printf '\n%s%s══ walkthrough complete ══%s\n\n' "$B" "$C" "$O"
say "The stack is left RUNNING. Useful next commands:"
say "  docker compose logs -f adera-gateway-cpo    # follow one container"
say "  docker compose restart adera-gateway-cpo    # replay the handshake alone"
say "  docker compose down -v                      # wipe everything"
printf '\n'
exit $rc
