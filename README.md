# ADERA — Local PoC Sandbox

**Automated Decentralized Energy Roaming Architecture.** A sovereign,
tokenless, hubless EV-roaming framework: a permissioned Hyperledger Besu (QBFT)
ledger acting as a zero-trust OCPI directory, with direct peer-to-peer OCPI
between operators and pluggable local payment settlement.

> **Docs:** [`docs/01-ADERA-Whitepaper.md`](docs/01-ADERA-Whitepaper.md) ·
> [`docs/02-System-Architecture-Security-Design.md`](docs/02-System-Architecture-Security-Design.md) ·
> [`docs/00-ADERA-Expanded-Technical-Guide.md`](docs/00-ADERA-Expanded-Technical-Guide.md)

---

## Publishing the whitepaper

The whitepaper is published as a web page and a print-ready PDF, both built
from the single Markdown source in `docs/01-ADERA-Whitepaper.md` so they cannot
drift apart.

`.github/workflows/docs.yml` rebuilds and republishes both on every push to
`main` that touches the whitepaper or its build tooling. **One-time setup:**
in **Settings → Pages → Build and deployment**, set **Source** to
**GitHub Actions**. The site then publishes to
`https://industrialdynamics.github.io/ADERA/`, with the PDF alongside it at
`/ADERA-Whitepaper.pdf`.

To build locally:

```bash
cd tools/docs
npm install
npm run build          # -> _site/index.html and _site/ADERA-Whitepaper.pdf
npm run html           # HTML only, skips Chromium
npm run serve          # build, then serve _site on :8080
```

Puppeteer ships no Linux/arm64 Chromium, so on an Apple Silicon machine install
the distro build and point at it:

```bash
sudo apt-get install -y chromium
PUPPETEER_EXECUTABLE_PATH=$(which chromium) npm run build
```

Styling for both outputs lives in one file, `tools/docs/style.css`; its
`@media print` block controls pagination, and each `# Part N` heading starts a
new page in the PDF.

---

## What this sandbox demonstrates, end to end

1. A **permissioned QBFT** network of two founding validators (CPO + eMSP)
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
├── demo/
│   ├── step.sh                   # step-by-step bring-up, one container at a time
│   ├── verify.sh                 # one-command live demo / smoke test
│   └── attack-suite.js           # forged, replayed & mis-declared handshakes
├── docs/
│   ├── 00-ADERA-Expanded-Technical-Guide.md   # start here; §7 = implemented vs. described
│   ├── 01-ADERA-Whitepaper.md
│   └── 02-System-Architecture-Security-Design.md
├── network/                      # Besu QBFT network material (pre-generated, valid)
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
│       ├── package-lock.json     # pinned tree; images build via `npm ci`
│       └── deploy.js
└── gateway/
    ├── Dockerfile
    ├── package.json
    ├── package-lock.json         # pinned tree; images build via `npm ci`
    ├── gateway.js                # discovery + OCPI handshake + settlement
    └── lib/
        ├── registry.js           # on-chain discovery client
        ├── ocpi.js               # OCPI 2.2.1 + signed handshake
        ├── crypto.js             # endpoint AES-GCM + signature/pubkey binding
        ├── replayGuard.js        # handshake freshness + single-use nonce
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

### 0. Understand it first: bring the containers up one at a time

If `docker compose up` feels like a wall of interleaved logs, run this instead:

```bash
./demo/step.sh
```

It starts the five containers **one per step**, pausing between each, and shows
the observable state change that container caused — so you can see what each one
actually contributes rather than inferring it from a merged log. Add `--auto`
to run it without the pauses.

The sequence is built to make the dependencies visible:

| Step | Container | What it proves |
| ---- | --------- | -------------- |
| 1 | `adera-validator-cpo` alone | RPC answers but **block height stays at 0** — one node cannot finalise, because QBFT needs a quorum of the two-member validator set |
| 2 | `adera-validator-emsp` | `net_peerCount` → `0x1` and the height starts climbing. Consensus, not just uptime |
| 3 | `adera-contract-deployer` | Deploy → multisig admission → regulator probe → writes `/shared/deployment.json`, then **exits 0 and stays exited** (it is a job, not a service) |
| 4 | `adera-gateway-emsp` | Boots, reads the manifest, serves OCPI, and *waits*. No traffic yet |
| 5 | `adera-gateway-cpo` | On-chain discovery → decrypt endpoint → signed handshake → settlement, with the receiver's side shown alongside |
| 6 | — | `docker compose ps -a` plus a diagram of what talks to what |
| 7 | — | Forged, replayed and mis-declared handshakes, and the `SECURITY` rejections they produce |
| 8 | — | Runs `demo/verify.sh` for the full check |

Starting one service at a time is just `--no-deps`, which tells compose to ignore
the `depends_on` graph:

```bash
docker compose up -d --no-deps adera-validator-cpo    # long-running service
docker compose up    --no-deps adera-contract-deployer # one-shot job, attached
```

**The containers are connected by exactly three things:**

1. **The `adera-net` bridge** (`172.28.0.0/16`) — every container resolves the
   others by container name, so `http://adera-gateway-emsp:9102` just works. The
   two validators additionally sit on *fixed* IPs (`.11`, `.12`) because those
   addresses are baked into `static-nodes.json` and `permissions_config.toml`.
2. **The `adera-shared` volume** — the deployer's only lasting output is
   `/shared/deployment.json` (registry address + ABI). Both gateways mount that
   volume **read-only**. Nothing hardcodes the contract address anywhere.
3. **`depends_on` in `docker-compose.yml`** — validators → deployer
   (`service_completed_successfully`, i.e. it must exit 0) → gateways.

Note what is *not* in that list: the CPO gateway never reaches the eMSP gateway
*through* the chain. It uses the chain to **find** and **authenticate** the peer,
then calls it **directly** over HTTP. That is the "hubless" claim in action.

### 1. The fastest path: one script

```bash
./demo/verify.sh
```

Checks the five claims the sandbox exists to demonstrate — consensus,
governance, regulator oversight, the signed handshake, and rejection of forged /
replayed / mis-declared handshakes — against the **running stack**, printing
PASS/FAIL per claim and exiting non-zero if anything is wrong. Needs only
`docker` and `curl`. Use this to demo; use the manual steps below to explain.

The interesting half is section 5: the attacks are run **by a legitimately
admitted party holding a valid key** (`demo/attack-suite.js`), not by an
outsider, because that is the threat model the on-chain binding actually exists
to defeat.

### 2. Watch the logs for the key milestones

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
[gateway:LK/CPO] handshake  | handshake step 3: POST http://adera-gateway-emsp:9102/party/LK/EMS/ocpi/2.2.1/credentials (signed, party=0x..., nonce=...)
[gateway:LK/CPO] handshake  | OUTBOUND verified: peer returned LK/EMS token=TOKEN_C_...
[gateway:LK/CPO] settle     | settlement channel open: chan_... via mandate-rail
[gateway:LK/CPO] settle     | CDR CDR_... settled: MANDATE-RAIL-STL-... (ACCEPTED)
[gateway:LK/CPO] done       | roaming session established end-to-end ...
```

**eMSP gateway (receiver)** — expect:

```
[gateway:LK/EMS] handshake  | INBOUND verified from LK/CPO (0x...) signer=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
[gateway:LK/EMS] webhook-in | settlement event received: {...}
```

(The signer shown is the **CPO's** messaging identity — the eMSP is verifying
who called it, not itself.)

### 3. Query the chain directly (host)

```bash
# Block height climbing (consensus is live)
curl -s -X POST http://localhost:8545 -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

# The two QBFT validators
curl -s -X POST http://localhost:8545 -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"qbft_getValidatorsByBlockNumber","params":["latest"],"id":1}'
# expect: 0x27d5b5ce6678a713db4632551fb2b04d21c0ddb8 and 0xfe8d8e89f67fbca67d48d94dc92edfd508c679ac

# Each validator has exactly one peer
curl -s -X POST http://localhost:8545 -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"net_peerCount","params":[],"id":1}'
# expect: "0x1"
```

### 4. Gateway health

```bash
curl -s http://localhost:9101/health   # {"status":"ok","tenants":[{"party":"LK/CPO","role":"CPO"}]}
curl -s http://localhost:9102/health   # {"status":"ok","tenants":[{"party":"LK/EMS","role":"EMSP"}]}
```

Each gateway process serves a *table* of Party identities rather than being
hardwired to a single one — `/health` lists every identity a given process
hosts. This PoC runs one tenant per process today; adding a second fronted
identity behind the same gateway is a config change (`TENANT_COUNT=2` plus a
`TENANT_2_*` block), not a code change — see `docs/00-ADERA-Expanded-Technical-Guide.md`
§1.8.

### 5. (Optional) Prove the identity-hijack defense

The receiver enforces four independent checks on every inbound handshake, each
logged as a `SECURITY` rejection when it trips:

| Check | Rejects | Status |
| ----- | ------- | ------ |
| Freshness — signed timestamp within ±5 min | a captured handshake replayed later | 401 |
| Single-use nonce | the same signed request sent twice | 401 |
| Signature vs. on-chain `pubKey` | anyone without the party's messaging key | 401 |
| Payload identity + role vs. ledger | an admitted party declaring itself to be a *different* party | 403 |

The timestamp and nonce are covered *by the signature*, so an attacker cannot
refresh a captured request by swapping in a new timestamp and nonce — that
invalidates the signature. The last check matters because it is the credentials
payload, not the party key, that names the counterparty on the settlement
channel the receiver then opens.

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
- **`qbft_getValidatorsByBlockNumber` errors / block height stuck at 0** — the
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
