# ADERA Whitepaper & Governance Framework

**Automated Decentralized Energy Roaming Architecture (ADERA)**
A sovereign, tokenless, hubless framework for national EV charging interoperability.

*Version 1.0 — Regulatory Reference Specification for a National Utilities Regulator*

---

## 0. Executive Summary

A national EV charging market is fragmenting into isolated islands. Each Charge
Point Operator (CPO) builds its own app and its own billing relationship, and an
e-Mobility Service Provider (eMSP) customer of one network cannot charge on
another. The global answer to this problem is **roaming**, standardised by the
**Open Charge Point Interface (OCPI)**. The open question for a national
regulator is *how the roaming parties find and trust each other*.

The default global answer is a **central clearing house** (a "Roaming Hub"): a
single corporate intermediary through which every operator registers, and often
through which every roaming transaction and settlement flows. For a small
sovereign market this creates an unacceptable concentration of commercial,
data, and systemic-availability risk in a single private company.

**ADERA proposes the opposite topology.** It replaces the central hub with a
**permissioned distributed ledger that acts strictly as a zero-trust directory**.
The ledger answers exactly one question — *"for Party ID `XX`/`XXX`, what is the
current, cryptographically-attested, secure endpoint and public key?"* — and
nothing else. All operational OCPI traffic (tokens, sessions, CDRs, tariffs) and
all financial settlement happen **peer-to-peer and off-chain**. ADERA is
**tokenless**: it never holds, moves, or represents money on-chain, so it does
not create a payment instrument, a security, or a monetary-authority concern.

This document specifies why this architecture is the correct national mandate,
how governance and regulator oversight work, and how financial clearing plugs
into a market's existing rails (an account-mandate rail, a real-time
interbank-transfer rail, and direct bank host-to-host APIs). Part 2 details
the security design; Part 3 is a complete, runnable reference implementation.

---

## 1. The Core Thesis: Central Clearing House vs. Decentralized Ledger Registry

### 1.1 The two topologies

**Centralized clearing house.** Every operator holds a bilateral
technical and commercial relationship with one hub operator. Discovery, identity,
and frequently message-relay and settlement are all mediated centrally.

```
   CPO-A ─┐                        ┌─ eMSP-X
   CPO-B ─┼──►  [ CENTRAL HUB ]  ◄─┼─ eMSP-Y
   CPO-C ─┘      (single company)  └─ eMSP-Z
                       │
             owns discovery + identity
             sees all roaming metadata
             single point of failure / leverage
```

**Decentralized ledger registry (ADERA).** Operators publish their identity and
endpoint to a shared permissioned ledger they *collectively* govern. Discovery is
a read against the ledger. Every actual OCPI conversation is a **direct**,
mutually-authenticated, encrypted tunnel between exactly two operators.

```
        ┌─────────────── ADERA permissioned ledger ───────────────┐
        │  immutable zero-trust directory: PartyID -> endpoint/key  │
        └──▲───────────▲───────────▲───────────▲───────────▲────────┘
           │ read      │ read      │ read      │ read      │ read
        CPO-A        CPO-B       eMSP-X      eMSP-Y      Regulator (observer)
           └───── direct P2P OCPI (mTLS) ─────┘
                       (no data touches the ledger)
```

### 1.2 What the ledger stores — and what it deliberately does not

The ADERA ledger is an **immutable, zero-trust directory**. For each party it
stores the minimum required to *discover and authenticate* a counterparty:

| On-chain (public, minimal)                    | Off-chain (private, peer-to-peer)          |
| --------------------------------------------- | ------------------------------------------ |
| OCPI Party ID = ISO-3166 country code + 3-char PartyID| OCPI tokens, versions, module endpoints |
| Bound legal-entity governance key (`entity`)  | Charge sessions, locations, tariffs        |
| **Encrypted** endpoint blob (`endpointCipher`)| Charge Detail Records (CDRs)               |
| Messaging public key (`pubKey`)               | All PII and commercial data                |
| Active / revoked status                       | All financial settlement instructions      |
| Admission / revocation / audit event log      | Real routable network addresses (in clear) |

"Zero-trust" is literal: a reader trusts **no** intermediary. It reads a record,
and independently verifies, at the moment of connection, that the far end
controls the private key bound to that Party ID (see §Part 2). The ledger is not
a source of *permission to be trusted*; it is a source of *cryptographic facts to
be verified*.

Critically, even the endpoint is **not** published in clear. It is stored as an
opaque `endpointCipher` (AES-256-GCM ciphertext under a consortium data-plane
key held only by admitted members). The ledger is public to its members and to
the regulator, but the routable topology of the national charging network is not leaked
to the world. Operational data and P2P communication paths remain **strictly
off-chain**.

### 1.3 Why this is the right choice for a national market

- **Sovereignty & no single point of control.** No private company sits between
  operators or between operators and their customers. The registry is a shared
  public utility governed by its participants under the regulator's rules.
- **No single point of failure.** The hub cannot go down, be acquired, raise
  rents, or be compelled to hand over the entire market's data, because there is
  no hub. Consensus continues as long as a quorum of validators is live.
- **Data minimisation by construction.** Because roaming data never transits a
  central party, the largest privacy and competition risks simply do not exist.
- **Auditable by design.** Admissions, revocations, and key rotations are an
  append-only, tamper-evident log the regulator reads directly.
- **Tokenless & rail-neutral.** ADERA introduces no cryptocurrency and mandates
  no payment processor. It clears through the rails a market already trusts.

---

## 2. The Pluggable Payment Abstraction Layer

### 2.1 Principle: ADERA clears identity, not money

ADERA draws a hard line between **roaming interoperability** (its concern) and
**financial settlement** (the operators' and banks' concern). The ledger is
tokenless and never a party to a payment. Instead, each operator's gateway loads
a **payment plugin** implementing a narrow, stable interface, and the rest of the
system is entirely agnostic to which rail is used.

This means an operator settling via an **account-mandate** rail and an
operator settling via a **real-time interbank-transfer** rail, or via a direct
**bank host-to-host API**, interoperate for *charging* without any coordination
about *payment*. The payment rail is a private implementation detail of each
bilateral relationship.

### 2.2 The interface

```
interface PaymentPlugin {
  name: string

  // Called once when two parties complete an OCPI handshake: establishes the
  // settlement relationship / mandate on the chosen rail.
  openSettlementChannel({ localParty, remoteParty, remoteRole })
      -> { channelId, rail, mandateRef }

  // Called per settled Charge Detail Record.
  settleCdr({ channelId, cdr }) -> { settlementRef, rail, amount, status }
}
```

Reference plugins in Part 3:

| Plugin                 | Rail                                   | Model                          |
| ---------------------- | -------------------------------------- | ------------------------------ |
| `mandate-rail`         | Account-mandate rail                   | Account-mandate debit          |
| `interbank-transfer`   | Interbank-transfer rail                | Real-time interbank credit     |
| `null`                 | Out-of-band / manual reconciliation    | No automated settlement        |

A commercial bank host-to-host integration is added by implementing the same
three methods against that bank's API — no change to OCPI, discovery, or the
ledger is required.

### 2.3 Decoupled, secure event webhooks

Settlement must never block or throttle the OCPI data plane. A charging session
completes in real time; a bank posting may take seconds, minutes, or a
maintenance window. ADERA therefore drives settlement through **decoupled,
fire-and-forget event webhooks**:

1. On handshake completion and on each CDR, the gateway's payment plugin emits a
   signed event (`settlement.channel.opened`, `settlement.cdr.posted`).
2. The event is POSTed to the operator's **own** bank/national-rail connector
   sidecar (`PAYMENT_WEBHOOK_URL`) — not to any shared endpoint.
3. Webhook delivery is asynchronous and failure-isolated: a slow or offline rail
   is logged and retried, and **never** propagates an error into the charging or
   roaming flow. CDRs that cannot yet be settled are held in a durable,
   order-preserving offline queue (see Part 2, "Disconnected states").

Because the event is decoupled, the security boundary is clean: the ledger and
OCPI plane know nothing about bank credentials, and the bank connector knows
nothing about validator keys. Each side holds only what it needs.

---

## 3. Consensus & Regulatory Oversight

### 3.1 Enterprise EVM network

ADERA runs on **Hyperledger Besu** configured as a **permissioned IBFT 2.0**
network (an enterprise, proof-of-authority EVM). Properties that matter to a
regulator:

- **Immediate finality.** IBFT 2.0 blocks are final when produced; there are no
  reorganisations, so an admission or revocation is settled the instant it is
  mined.
- **Known validators.** Blocks are produced only by a defined validator set
  (the founding operators at genesis, extended by governance), not by anonymous
  miners. There is no proof-of-work and no energy cost.
- **Permissioned membership.** Nodes must be explicitly allow-listed to peer at
  all (Part 2). The network is not open to the public internet.

### 3.2 Multisig admission — operators vote in operators

New market participants are not admitted by an administrator; they are admitted
by an **M-of-N multi-signature vote of the existing admitted operators**, encoded
in the `AderaRegistry` smart contract:

```
proposeAdmitParty(countryCode, partyId, role, entity, endpointCipher, pubKey)
   -> creates a proposal, auto-confirmed by the proposer

confirm(proposalId)
   -> each additional member confirms

   when confirmations >= threshold  ->  party is admitted atomically:
        * Party ID is bound 1:1 to the entity key
        * endpoint + public key + active status recorded
        * the new operator joins the governance member set
```

The same multisig governs `RevokeParty`, `ReinstateParty`, `AddMember`,
`RemoveMember`, `SetThreshold`, and `TransferAuditor`. No single key — not even
the deployer's, not even the regulator's — can unilaterally admit, remove, or impersonate
a participant. This is the on-chain expression of a **consortium**: the market
collectively controls its own membership under rules the regulator sets.

### 3.3 The Regulator as read-only Auditor / Observer

The regulator holds a dedicated, first-class, **read-only** role: the
**auditor key**. Its design goals are total visibility with zero mutation
power and zero systemic dependency:

- **Total visibility.** All registry state is transparent, and every governance
  action emits an event (`PartyAdmitted`, `PartyRevoked`, `EndpointRotated`,
  `PubKeyRotated`, `MemberAdded`, `ThresholdChanged`, …). The regulator runs its
  own observer node (or a light indexer) and sees the complete, tamper-evident
  history in real time — no operator can hide an admission or a key rotation.
- **No mutation power.** The auditor key cannot admit, revoke, or alter any
  party. Its *only* state-touching capability is `auditProbe(partyKey, note)`,
  which emits an immutable `ComplianceProbe` attestation — an on-chain,
  timestamped, non-repudiable record that the regulator inspected a party. This
  lets the regulator *prove it exercised oversight* without ever being able to
  distort the market.
- **No point of failure.** Because the auditor is an observer, the network's
  liveness and correctness do not depend on the regulator being online. If the
  regulator's node is down, roaming continues; oversight resumes when it returns.
  Conversely, the regulator is never a bottleneck operators must transact through.

Should the regulator rotate custody of the auditor key (e.g. HSM migration, key
compromise), the change itself is a governed, logged `TransferAuditor` action —
auditable like everything else.

### 3.4 Governance lifecycle at a glance

```
 Genesis:   founding CPO + founding eMSP seeded as parties AND members;
            threshold = 2; regulator's auditor key set.
     │
     ▼
 Admission: existing members propose + confirm a new operator (M-of-N).
     │      New operator is bound to its Party ID and joins the member set.
     ▼
 Operation: operators self-service rotate their OWN endpoint / messaging key
     │      (logged); identity binding stays immutable.
     ▼
 Oversight: Regulator observes all events; emits ComplianceProbe attestations.
     │
     ▼
 Revocation: on breach / exit, members vote to revoke — party goes inactive,
            loses governance vote; node is dropped from the P2P allowlist.
```

---

## 4. Standardisation & the National Mandate

ADERA is written to be **adopted verbatim as a national technical standard** and
mandated as a licence condition for market participants. Concretely, a mandate
would reference:

1. **Protocol:** OCPI 2.2.1 for all inter-operator roaming.
2. **Directory:** the `AderaRegistry` contract interface (Part 3) as the sole
   national discovery mechanism; no operator may require a competitor to
   integrate a proprietary hub.
3. **Identity:** every licensed operator binds one legal entity to one OCPI
   Party ID (`XX`/`XXX`) on the registry, with a hardware-protected key.
4. **Governance:** admission/revocation by consortium multisig under a
   regulator-approved threshold and rulebook; the regulator holds the auditor key.
5. **Settlement:** rail-neutral; operators must support at least one
   regulator-recognised local rail via the payment-plugin interface.
6. **Security baseline:** the node-permissioning, mTLS/WireGuard, and
   key-binding requirements of Part 2.

Because the specification is open and the reference implementation is free
software, adoption imposes no licensing cost and no dependency on any single
vendor — the defining characteristic of a sovereign public standard.

---

## 5. Mapping to the Reference Implementation (Part 3)

| Whitepaper concept                     | Artifact in Part 3                                  |
| -------------------------------------- | --------------------------------------------------- |
| Zero-trust directory                   | `contracts/AderaRegistry.sol`                      |
| Immutable Party-ID → endpoint mapping  | `Party` struct, `resolveEndpoint()`                 |
| Identity binding (1 entity : 1 party)  | `entityToParty`, `_registerParty()`                 |
| Multisig admission                     | `propose()/confirm()`, `proposeAdmitParty()`        |
| Regulator auditor / observer           | `auditor`, `auditProbe()`, `ComplianceProbe` event  |
| Encrypted endpoints                    | `endpointCipher` + gateway AES-256-GCM decrypt      |
| Permissioned IBFT 2.0 network          | `network/genesis.json`, `permissions_config.toml`   |
| Pluggable payment layer                | `gateway/lib/payments.js`                           |
| Decoupled settlement webhooks          | `openSettlementChannel()` / `settleCdr()` events    |
| Off-chain P2P OCPI                     | `gateway/lib/ocpi.js`, `gateway.js`                 |
| Disconnected-state integrity           | `gateway/lib/offlineQueue.js`                       |

See `docs/02-System-Architecture-Security-Design.md` for the full threat model
and mitigations, and the root `README.md` for the run guide.
