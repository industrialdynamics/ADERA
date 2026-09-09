# ADERA — Local PoC Sandbox

**Automated Decentralized Energy Roaming Architecture.** A sovereign,
tokenless, hubless EV-roaming framework: a permissioned Hyperledger Besu (IBFT
2.0) ledger acting as a zero-trust OCPI directory, with direct peer-to-peer OCPI
between operators and pluggable local payment settlement.

> **Docs:** [`docs/01-ADERA-Whitepaper-PUCSL-Governance.md`](docs/01-ADERA-Whitepaper-PUCSL-Governance.md) ·
> [`docs/02-System-Architecture-Security-Design.md`](docs/02-System-Architecture-Security-Design.md)

---

## What this sandbox demonstrates, end to end

1. A **permissioned IBFT 2.0** network of two founding validators (CPO + eMSP)
   reaching consensus, with **node + account permissioning** gatekeeping.
2. A **registry smart contract** deployed and seeded with two founding parties.
3. A **multisig admission** of a third party (`LK/EVX`) — proposed by the CPO
   founder, confirmed by the eMSP founder, auto-executed at threshold.
4. A **regulator auditor** emitting an on-chain `ComplianceProbe` attestation.
5. A gateway performing **on-chain discovery** of a peer, **decrypting** the
   peer's confidential endpoint, and running a **signed OCPI 2.2.1 credentials
   handshake** that is **authenticated against the peer's on-chain public key**.
6. A **pluggable payment settlement** (account-mandate / interbank-transfer mocks) fired
   over a **decoupled webhook**, with a **durable offline CDR queue**.
7. A **multi-tenant gateway** — each `gateway.js` process serves a *table* of
   Party identities (`TENANT_1_*`, `TENANT_2_*`, ...) rather than being
   hardwired to one, so a single process can front several CPOs/eMSPs the
   way an eMSP hosting infrastructure for its fronted CPOs would.

---

## File tree

```
ADERA/
├── docker-compose.yml            # 5 services on an isolated 172.28.0.0/16 bridge
├── .env                          # THROWAWAY test keys (local only)
├── .devcontainer/devcontainer.json
├── docs/
│   ├── 01-ADERA-Whitepaper-PUCSL-Governance.md
│   └── 02-System-Architecture-Security-Design.md
├── network/                      # Besu IBFT 2.0 network material (pre-generated, valid)
│   ├── genesis.json              # extraData encodes both validators (real keys)
│   ├── permissions_config.toml   # node + account allowlists ("permissions.json")
│   ├── static-nodes.json         # enodes @ static IPs
│   ├── entrypoint.sh             # validator launch script
│   └── keys/{cpo,emsp}/{key,key.pub}
├── contracts/
│   ├── AderaRegistry.sol        # multisig directory + regulator auditor role
│   └── deployer/                 # compiles (bare solc) + deploys + seeds scenario
│       ├── Dockerfile
│       ├── package.json
│       └── deploy.js
└── gateway/
    ├── Dockerfile
    ├── package.json
    ├── gateway.js                # discovery + OCPI handshake + settlement
    └── lib/
        ├── registry.js           # on-chain discovery client
        ├── ocpi.js               # OCPI 2.2.1 + signed handshake
        ├── crypto.js             # endpoint AES-GCM + signature/pubkey binding
        ├── payments.js           # pluggable payment layer (mandate rail / interbank transfer)
        └── offlineQueue.js       # durable, ordered CDR queue
```

---

## Prerequisites (test machine)

- **Docker Engine + Docker Compose v2** — that is the *only* host requirement.
  Everything else (Besu, Node.js, solc, ethers) runs **inside containers**;
  nothing is installed on the host.
- Free host ports: `8545`, `8546`, `8547`, `8548`, `9101`, `9102`.
- ~2 GB free disk for images.

> The `network/` crypto material (validator keys + genesis `extraData`) was
> pre-generated **by Besu itself** inside a throwaway container, so the network
> is cryptographically valid and needs no generation step. Just bring it up.

---

## Run it — Option A: plain Docker (simplest)

From the repository root:

```bash
docker compose up --build
```

First run pulls the Besu image and builds the two Node images (a few minutes).
Bring-up order is enforced by `depends_on`: validators → deployer (runs once and
exits 0) → gateways.

**Stop and wipe all state (chain data, queues, deployment manifest):**

```bash
docker compose down -v
```

**Re-run cleanly:** `docker compose down -v && docker compose up --build`

---

## Run it — Option B: fully isolated devcontainer (Docker-in-Docker)

If you prefer to keep even Docker activity off the host, open the folder in a
Dev Container (VS Code: *Dev Containers: Reopen in Container*, or the `devcontainer`
CLI). The stack then runs **inside** the dev container via Docker-in-Docker:

```bash
# inside the devcontainer terminal
docker compose up --build
```

The devcontainer also ships the `aws` and `gcloud` CLIs (sandboxed) for any
future cloud-dependency testing, so those never touch your host either.

---

## Verify it worked

### 1. Watch the logs for the key milestones

```bash
docker compose logs -f adera-contract-deployer
docker compose logs -f adera-gateway-cpo
docker compose logs -f adera-gateway-emsp
```

**Deployer** — expect lines like:

```
[deployer] deploy     | AderaRegistry deployed at 0x....
[deployer] gov        | proposal #0 created and auto-confirmed by CPO founder (1/2)
[deployer] gov        | proposal #0 executed=true confirmations=2/2
[deployer] gov        | LK/EVX admitted & active = true; members now = 3
[deployer] audit      | ComplianceProbe mined in block #...
[deployer] done       | ADERA registry bootstrapped successfully. Gateways may start.
```

**CPO gateway (initiator)** — expect:

```
[gateway:LK/CPO] discover   | decrypted peer OCPI endpoint: http://adera-gateway-emsp:9102/party/LK/EMS/ocpi/versions
[gateway:LK/CPO] handshake  | handshake step 3: POST http://adera-gateway-emsp:9102/party/LK/EMS/ocpi/2.2.1/credentials (signed, ...)
[gateway:LK/CPO] handshake  | OUTBOUND verified: peer returned LK/EMS token=TOKEN_C_...
[gateway:LK/CPO] settle     | settlement channel open: chan_... via mandate-rail
[gateway:LK/CPO] settle     | CDR CDR_... settled: MANDATE-RAIL-STL-... (ACCEPTED)
[gateway:LK/CPO] done       | roaming session established end-to-end ...
```

**eMSP gateway (receiver)** — expect:

```
[gateway:LK/EMS] handshake  | INBOUND verified from 0x...... signer=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
[gateway:LK/EMS] webhook-in | settlement event received: {...}
```

### 2. Query the chain directly (host)

```bash
# Block height climbing (consensus is live)
curl -s -X POST http://localhost:8545 -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

# The two IBFT validators
curl -s -X POST http://localhost:8545 -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"ibft_getValidatorsByBlockNumber","params":["latest"],"id":1}'
# expect: 0x27d5b5ce6678a713db4632551fb2b04d21c0ddb8 and 0xfe8d8e89f67fbca67d48d94dc92edfd508c679ac

# Each validator has exactly one peer
curl -s -X POST http://localhost:8545 -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"net_peerCount","params":[],"id":1}'
# expect: "0x1"
```

### 3. Gateway health

```bash
curl -s http://localhost:9101/health   # {"status":"ok","tenants":[{"party":"LK/CPO","role":"CPO"}]}
curl -s http://localhost:9102/health   # {"status":"ok","tenants":[{"party":"LK/EMS","role":"EMSP"}]}
```

Each gateway process serves a *table* of Party identities rather than being
hardwired to a single one — `/health` lists every identity a given process
hosts. This PoC runs one tenant per process today; adding a second fronted
identity behind the same gateway is a config change (`TENANT_COUNT=2` plus a
`TENANT_2_*` block), not a code change — see `docs/00-ADERA-Plain-English-Guide.md`
§1.8.

### 4. (Optional) Prove the identity-hijack defense

An unsigned / wrongly-signed credentials POST is rejected against the on-chain
public key:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  http://localhost:9102/party/LK/EMS/ocpi/2.2.1/credentials \
  -H 'Authorization: Token ADERA-REG-TOKEN-A' \
  -H 'Content-Type: application/json' \
  -H 'X-ADERA-Party: 0xdeadbeef' \
  -H 'X-ADERA-Signature: 0x00' \
  --data '{"token":"forged"}'
# expect: 401 or 403  (no valid on-chain party / signature mismatch)
```

---

## Ports

| Service                | Container port | Host port | Purpose                     |
| ---------------------- | -------------- | --------- | --------------------------- |
| adera-validator-cpo   | 8545 / 8546    | 8545/8546 | JSON-RPC / WS               |
| adera-validator-emsp  | 8545 / 8546    | 8547/8548 | JSON-RPC / WS               |
| adera-gateway-cpo     | 9101           | 9101      | OCPI receiver (CPO)         |
| adera-gateway-emsp    | 9102           | 9102      | OCPI receiver (eMSP)        |

---

## Troubleshooting

- **A gateway logs `initiator attempt N/30 failed`** then succeeds — normal; the
  initiator retries until the peer gateway's HTTP server is up.
- **`ibft_getValidatorsByBlockNumber` errors / block height stuck at 0** — the
  two validators must both be up and peered (this 2-validator PoC has no fault
  tolerance by design). Check `docker compose logs adera-validator-emsp` and
  confirm `net_peerCount` is `0x1`.
- **Deployer exits non-zero** — read `docker compose logs adera-contract-deployer`;
  it prints solc errors and RPC wait status. The gateways won't start until the
  deployer exits 0 (that's the intended gate).
- **Port already in use** — free the host ports above or edit the mappings in
  `docker-compose.yml`.
- **Clean slate** — `docker compose down -v` removes all named volumes.

---

## Notes & caveats (intentional PoC scope)

- **Throwaway keys.** Every key in `.env` is a well-known public test key. Never
  reuse them anywhere real.
- **2 validators = no fault tolerance.** Both must be live for blocks to
  finalize. Production sizing is ≥4 validators (see architecture doc §6).
- **HTTP, not mTLS/WireGuard, on the data plane.** The signed handshake +
  on-chain verification and the encrypted endpoint are fully implemented; the
  mTLS/WireGuard transport wrapping is documented as the production step and is
  not required for the sandbox (it runs on an isolated Docker bridge).
- **Mock payment rails.** `payments.js` logs and POSTs the exact settlement
  event payloads a real bank/national-rail connector would receive; it does not
  contact any real financial system.

---

## If you hit an error on the test machine

Send back:
1. Which step (`up --build`, or which service).
2. `docker compose ps` output.
3. The failing service's logs: `docker compose logs <service>`.

That's enough to debug remotely without running anything on your primary machine.
