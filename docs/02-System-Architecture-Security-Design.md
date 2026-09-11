# ADERA — Detailed System Architecture & Security Design

*Companion to the Whitepaper (`01-ADERA-Whitepaper.md`).
This document is the threat model and the defense-in-depth specification.*

---

## 1. Reference Topology

```
                 ┌───────────────────────── ADERA permissioned network ─────────────────────────┐
                 │                                                                                │
                 │   ┌───────────────────────┐  IBFT 2.0 / RLPx  ┌───────────────────────┐        │
 Regulator       │   │  adera-validator-cpo  │◄────────────────►│ adera-validator-emsp │        │
 observer    ───►│   │  Besu, validator,      │   (permissioned  │  Besu, validator,     │        │
 node (RO)       │   │  172.28.0.11           │    P2P allowlist) │  172.28.0.12          │        │
                 │   └──────────▲─────────────┘                   └──────────▲────────────┘        │
                 │              │ JSON-RPC (read/write)                      │ JSON-RPC             │
                 └──────────────┼────────────────────────────────────────────┼─────────────────────┘
                                │                                            │
                     ┌──────────┴──────────┐                     ┌───────────┴─────────┐
                     │  adera-gateway-cpo  │  direct P2P OCPI    │ adera-gateway-emsp │
                     │  internal platform   │◄══════════════════►│ internal platform   │
                     │  engine (OCPI+router)│   mTLS / WireGuard   │ engine (OCPI+router)│
                     └──────────┬──────────┘   (NO ledger relay)  └───────────┬─────────┘
                                │                                            │
                        payment plugin                               payment plugin
                        (mandate-rail webhook)                       (interbank-transfer webhook)
                                │                                            │
                        bank / national-rail                         bank / national-rail
                        connector sidecar                            connector sidecar
```

Two planes, strictly separated:

- **Control plane (on-chain):** identity, discovery, governance, audit. Low
  volume, high assurance, fully permissioned.
- **Data plane (off-chain):** OCPI messages, CDRs, settlement events. High
  volume, direct peer-to-peer, encrypted, never relayed through the ledger.

---

## 2. Defense-in-Depth Layers

| # | Layer                    | Control                                                        | Blocks                                   |
| - | ------------------------ | ------------------------------------------------------------- | ---------------------------------------- |
| 1 | TCP / devp2p             | Besu node permissioning (`permissions_config.toml`, bootnodes)| Unauthorised nodes joining the ledger    |
| 2 | Transaction pool         | Besu account permissioning (allowlist)                        | Unknown keys writing to the ledger       |
| 3 | Consensus                | IBFT 2.0 validator set                                         | Unauthorised block production            |
| 4 | Contract authorisation   | `onlyMember` / `onlyAuditor` / entity binding                 | Ungoverned state changes, role misuse    |
| 5 | Identity binding         | `entityToParty` 1:1 mapping in `AderaRegistry`               | Party-ID spoofing / hijacking            |
| 6 | Application handshake     | Signature verified vs on-chain `pubKey`                       | Impersonation over OCPI                   |
| 7 | Transport                | mTLS + WireGuard for the OCPI tunnel                          | Eavesdropping, MITM, endpoint disclosure |
| 8 | Confidential discovery   | AES-256-GCM `endpointCipher`                                  | Topology leakage to non-members          |

A successful attack must defeat **every** relevant layer, not one.

---

## 3. Network Permissioning & Gatekeeping (Layers 1–3)

### 3.1 Blocking bad actors at the TCP layer

A rogue node cannot participate merely by knowing the chain ID and a bootnode
address. Besu is started with file-based node permissioning:

```
--permissions-nodes-config-file-enabled=true
--permissions-nodes-config-file=/config/permissions_config.toml
--discovery-enabled=false            # no promiscuous peer discovery
--p2p-host=<static IP>               # deterministic enode identity
```

`permissions_config.toml` carries the authoritative `nodes-allowlist` of enodes
(public key + IP + port). During the RLPx (devp2p) handshake — i.e. at the TCP
layer, before any block or state data is exchanged — Besu checks the peer's
enode against this list and **drops the connection** if it is not present. An
attacker who spins up a Besu node with the correct genesis still cannot peer: it
is not in the allowlist, so the handshake is refused.

Because `discovery-enabled=false`, nodes connect only via the explicit
`static-nodes.json` set. There is no DHT to crawl and no way for an unknown node
to advertise itself into the mesh.

### 3.2 Two-tier allowlist, projected from the chain

- **Genesis snapshot.** The founding two validators are listed in
  `static-nodes.json` and `permissions_config.toml` at genesis (their real
  enodes, derived from the keys generated by Besu itself).
- **Dynamic projection.** In production, the file is not hand-edited. Each
  operator runs a small **node-permissioning sidecar** that subscribes to
  `PartyAdmitted` / `PartyRevoked` events on `AderaRegistry` and rewrites the
  local allowlist (Besu hot-reloads the file). Thus the *on-chain governance
  decision* is the single source of truth for *who may peer at the TCP layer* —
  admission and network access are one atomic act, not two systems to keep in
  sync.

### 3.3 Account permissioning (Layer 2)

`accounts-allowlist` restricts which externally-owned accounts may submit
transactions at all. Even a permitted node cannot relay a transaction from an
unknown key: it is rejected at the transaction-pool boundary. Only governance
keys and the regulator's auditor key can originate state changes.

---

## 4. Identity Hijacking & Sybil Resistance (Layers 4–6)

### 4.1 The attack

A rogue operator "Mallory" wants to (a) register as a legitimate operator she is
not, (b) point Party ID `LK`/`CPO` at *her* endpoint to steal sessions or CDRs,
or (c) flood the registry with fake identities (Sybil) to gain governance weight.

### 4.2 The binding that stops it

`AderaRegistry` enforces a **strict 1:1 binding between a validated legal
entity's key and its unique OCPI Party ID**:

```
mapping(bytes32 => Party)   parties;        // partyKey -> record (unique)
mapping(address => bytes32) entityToParty;  // entity  -> partyKey (unique)

_registerParty(...) requires:
    !parties[key].exists                 // Party ID not already taken
    entityToParty[entity] == 0           // entity not already bound elsewhere
```

Consequences:

- **No duplicate Party IDs.** `keccak256("LK" ++ "CPO")` can be registered once,
  ever. A second attempt reverts.
- **No key reuse across identities.** One entity key maps to exactly one party.
- **No third-party mutation.** Endpoint and key rotation are gated by
  `msg.sender == party.entity`. Mallory cannot change `LK`/`CPO`'s endpoint or
  public key because she does not hold `LK`/`CPO`'s entity key. The binding is
  immutable while active and can only be dissolved by a multisig `RevokeParty`.

### 4.3 Sybil resistance = admission is a governed act, not a signup

There is no open registration. A new Party ID enters only through an **M-of-N
multisig vote of existing operators** (`proposeAdmitParty` → `confirm` →
threshold). Creating N fake identities would require the honest quorum to
approve each one. The economic/legal identity (a regulator-licensed entity) is
established *off-chain by the regulator*, and the on-chain binding merely anchors
that established identity. Sybil attacks reduce to "convince the regulator and a
majority of your competitors to license a shell company," which is a
governance/legal control, not a technical gap.

### 4.4 Application-layer proof of control (Layer 6)

On-chain binding says *which key owns a Party ID*. The OCPI handshake proves *the
far end actually holds that key, right now*:

```
Initiator (CPO):
   body      = JSON(credentials)
   timestamp = now()                              # ISO-8601
   nonce     = random(16 bytes)                   # single use
   signature = sign(messagingKey,                 # EIP-191
                    timestamp || nonce || body)   # freshness is SIGNED, not just sent
   POST /ocpi/2.2.1/credentials
        Authorization: Token <TOKEN_A>
        X-ADERA-Party: <senderPartyKey>
        X-ADERA-Signature: <signature>
        X-ADERA-Timestamp: <timestamp>
        X-ADERA-Nonce: <nonce>

Receiver (eMSP):
   require |now() - timestamp| <= 5 min                          # freshness
   require nonce not seen before                                 # single use
   (pubKey, role, active) = registry.resolveEndpoint(senderPartyKey)
   require active
   recovered = ecrecover(timestamp || nonce || body, signature)
   require recovered == addressFromPubKey(pubKey)                # key-control check
   require partyKey(body.roles[0]) == senderPartyKey             # payload-identity check
   require body.roles[0].role == role                            # payload-role check
   -> otherwise 401/403, logged as a SECURITY rejection
```

The last two checks matter as much as the signature. The signature proves *the
sender controls LK/CPO's key*; it says nothing about **who the payload claims to
be**. Without binding the two, an admitted party could sign correctly as itself
while declaring a different party in `roles[]` — and it is the payload, not the
party key, that names the counterparty on the settlement channel the receiver
then opens. The check makes the ledger, not the sender's assertion, the source
of truth for who is on the other end of the money.

This replaces vanilla OCPI's weakest link — a pre-shared `TOKEN_A` that, if
leaked, lets anyone impersonate a party — with a **cryptographic check against
the ledger**. A stolen token is useless without the messaging private key, and
the messaging key's authority is exactly the on-chain binding. (Reference:
`gateway.js` credentials route + `gateway/lib/crypto.js`.)

---

## 5. OCPI Data Isolation & Dynamic Routing (Layers 7–8)

### 5.1 Confidential discovery

The routable endpoint is never in clear on-chain. `resolveEndpoint()` returns an
`endpointCipher` — AES-256-GCM ciphertext (`iv ‖ tag ‖ ciphertext`) of the OCPI
`versions` URL, encrypted under the **consortium data-plane key** held only by
admitted members. A member decrypts it to learn where to connect; a non-member
(or a leaked ledger snapshot) sees only opaque bytes. The national charging
topology is thus not disclosed by the directory itself.

### 5.2 Dynamic routing from live on-chain lookups

The gateway holds **no static peer table**. For every roaming interaction it:

1. Computes `partyKey = computePartyKey("LK","EMS")`.
2. Calls `registry.resolveEndpoint(partyKey)` — a live read of current truth.
3. Rejects immediately if `active == false` (a revoked peer is unreachable the
   instant the revocation is mined — no stale cache to exploit).
4. Decrypts `endpointCipher` → peer OCPI URL.
5. Runs the signed handshake, then routes OCPI module traffic to the discovered,
   authenticated endpoint.

Because routing is recomputed from the chain, governance actions take effect
network-wide without redeploying or reconfiguring any gateway. This is the
"internal platform gateway dynamically routes based on real-time on-chain
registry lookups" requirement, implemented in `gateway.js::runInitiator`.

### 5.3 Transport: mTLS + WireGuard

The direct P2P OCPI channel is protected by two independent transport controls:

- **WireGuard** establishes a private, authenticated network tunnel between the
  two operator gateways, so OCPI never traverses the public internet in the
  clear and the endpoints are not exposed to untrusted networks.
- **mTLS** on top pins each side's certificate. The certificate's key is the
  same messaging identity bound on-chain, so the TLS layer and the application
  layer verify the *same* identity — a peer that passes mTLS is already the
  on-chain party, defeating MITM.

> PoC scope: the reference implementation in Part 3 runs the OCPI handshake over
> plain HTTP on an isolated Docker bridge network (`172.28.0.0/16`) so it starts
> with zero certificate provisioning. The signed-handshake + on-chain
> verification (Layer 6) and the encrypted endpoint (Layer 8) are fully
> implemented; WireGuard/mTLS (Layer 7) are the documented production wrapping of
> that same channel. The signing identity is already in place, so enabling mTLS
> is a deployment step, not a code change.

---

## 6. Handling Disconnected States

Deployment sites in many markets face grid instability, load-shedding, and intermittent
backhaul. ADERA is engineered so that none of these compromise transactional
integrity.

### 6.1 Local grid instability / node restart

- **Immediate finality + persistent data path.** IBFT 2.0 has no reorgs, and
  each validator persists its chain to a Docker volume (`besu-*-data`). After a
  power loss a validator restarts, reloads `static-nodes.json`, re-peers, and
  resumes from its last final block. No state is rewritten or lost.
- **Quorum, not unanimity.** Consensus needs a validator quorum, not every node.
  The production topology uses ≥4 validators so the loss of one site does not
  halt the control plane. *(PoC note: the 2-validator sandbox has no fault
  tolerance by design — both must be up. This is a demonstration sizing, not a
  production sizing; the whitepaper mandates ≥4.)*

### 6.2 Temporary internet dropout

- **Discovery is cache-tolerant.** A gateway that already holds a peer's
  resolved, verified endpoint can continue an established session; it re-reads
  the chain to *start* new relationships or to detect a revocation. A dropout
  degrades new-peer discovery, not in-flight charging.
- **Local RPC.** Each gateway talks to its **own** co-located validator over the
  internal network, so gateway↔ledger reads survive an internet outage as long
  as the local node is up.

### 6.3 Off-line queueing of CDRs — no lost transactions

Charge Detail Records are the billable truth and must never be dropped. ADERA
gateways use a **durable, order-preserving offline queue**
(`gateway/lib/offlineQueue.js`):

```
enqueue(cdr)  -> append to disk-backed queue (survives restart)
flush(handler):
    while queue not empty:
        item = head
        try   handler(item)         # settle via payment plugin / peer
              dequeue; persist       # only on success
        catch stop (keep head)       # preserve order + at-least-once delivery
```

Guarantees:

- **Durability.** The queue is persisted to the gateway's data volume on every
  change, so a crash or power loss mid-settlement loses nothing.
- **Ordering & at-least-once.** A failed item stays at the head; nothing behind
  it is settled out of order, and nothing is silently discarded.
- **Idempotency hook.** Each CDR carries a stable `cdr_id`; the settlement
  reference returned by the rail lets the bank connector de-duplicate a retry,
  giving effectively-once settlement over an at-least-once transport.
- **Backpressure isolation.** Because settlement is a decoupled webhook (Part 1,
  §2.3), a queued backlog never stalls charging or the OCPI handshake.

When connectivity and the rail return, `flush()` drains the backlog in FIFO
order and the ledgers reconcile — the disconnected period is invisible to the
final financial outcome.

---

## 7. Consolidated Threat Model

| Threat                                   | Primary control                              | Reference                              |
| ---------------------------------------- | -------------------------------------------- | -------------------------------------- |
| Rogue node joins ledger                  | Node permissioning at RLPx handshake         | `permissions_config.toml`, entrypoint  |
| Unknown key writes to ledger             | Account permissioning                        | `permissions_config.toml`              |
| Unauthorised block production            | IBFT 2.0 fixed validator set                 | `genesis.json` extraData               |
| Duplicate / spoofed Party ID             | 1:1 Party↔entity binding, uniqueness         | `AderaRegistry._registerParty`        |
| Hijack another party's endpoint/key      | `msg.sender == entity` on rotation           | `rotateEndpoint`, `rotatePubKey`       |
| Sybil identities for governance capture  | Multisig admission by existing operators     | `propose`/`confirm`, `proposeAdmitParty`|
| Impersonation over OCPI                  | Signature verified vs on-chain pubKey        | `gateway.js` credentials route         |
| Endpoint / topology disclosure           | AES-256-GCM `endpointCipher`                  | `crypto.js`, `deploy.js` encrypt       |
| Eavesdropping / MITM on data plane       | WireGuard + mTLS (prod wrapping)             | §5.3                                    |
| Stale routing to a revoked peer          | Live `active` check on every discovery       | `resolveEndpoint`, `runInitiator`      |
| Regulator becomes a bottleneck / SPOF    | Read-only observer auditor role              | `auditor`, `auditProbe`                |
| Regulator tampering with the market      | Auditor has no mutation power                | `onlyAuditor` (probe-only)             |
| Grid loss / restart corrupts state       | Immediate finality + persistent data path    | IBFT 2.0, Docker volumes               |
| Internet dropout loses CDRs              | Durable, ordered offline queue               | `offlineQueue.js`                      |
| Slow bank stalls charging                | Decoupled fire-and-forget settlement webhook | `payments.js`                          |

---

## 8. Cryptographic & Identity Summary

| Identity                | Key type          | Where it lives                        | Proves                              |
| ----------------------- | ----------------- | ------------------------------------- | ----------------------------------- |
| Validator (node) key    | secp256k1         | `network/keys/{cpo,emsp}/key`         | Right to peer + produce IBFT blocks |
| Legal-entity governance | secp256k1 (cold)  | operator HSM (test key in `.env`)     | Right to vote in governance         |
| Messaging (hot) key     | secp256k1         | gateway env / KMS                     | Right to speak *as* a Party ID      |
| Consortium data-plane   | AES-256 symmetric | admitted members only                 | Membership → can resolve endpoints  |
| Regulator auditor key   | secp256k1         | Regulator HSM (test key in `.env`)    | Right to attest, never to mutate    |

Separation of the cold governance key from the hot messaging key means a
compromised gateway can be re-keyed (`rotatePubKey`, self-service, logged)
without touching the entity's governance authority, and a governance decision
never requires exposing the hot key. Each key does one job.
