# ADERA

**Automated Decentralized Energy Roaming Architecture**

*A sovereign, tokenless, hubless framework for national EV charging interoperability*

---

**Published by:** Industrial Dynamics
**Version:** 2.0
**Status:** Open specification — free to adopt, implement, and mandate. No licence fee, no vendor dependency.
**Companion documents:** `02-System-Architecture-Security-Design.md` (threat model and controls) · `00-ADERA-Plain-English-Guide.md` (extended commentary) · the reference implementation in this repository.

> **Who this is for.** Regulators and policymakers deciding how a national EV
> charging market should interconnect; charge point operators and mobility
> providers deciding whether to adopt it; and the technical advisors of both.
>
> **No prior knowledge of distributed ledgers is assumed.** Every term is
> defined where it is first used, and §3.2 addresses head-on the question a
> reader with database experience will reasonably ask: *why not just use a
> normal database?*

---

## Executive summary

As electric vehicle adoption grows, a national charging market fragments into
isolated islands. Each charging network builds its own app and its own billing
relationship, and a customer of one network cannot charge on another. The
global answer to this problem is **roaming**, and the message format for it is
already standardised as the **Open Charge Point Interface (OCPI)**.

But OCPI deliberately leaves one question unanswered: **how do two operators
find each other and decide to trust each other's messages in the first place?**
That unanswered question is where national policy gets decided, because it is
answered by architecture.

The default global answer is a **central clearing house** — a "roaming hub": a
single private company through which every operator registers, and often
through which every roaming transaction and settlement flows. For a small
sovereign market this concentrates commercial leverage, market-wide data, and
systemic availability risk in one firm.

**ADERA proposes the opposite topology.** It replaces the hub with a **shared
registry that the market's own participants jointly operate and govern**. The
registry answers exactly one question — *"for this operator's ID, what is the
current, cryptographically verifiable address and public key?"* — and nothing
else. All operational traffic and all financial settlement happen directly
between the two operators concerned, never through any intermediary.

Three properties follow, and they are the reasons to adopt it:

- **No single point of control.** No private company sits between operators, or
  between an operator and its customers. There is no hub to be acquired, to
  raise rents, to go offline, or to be compelled to surrender the market's data.
- **Tokenless and rail-neutral.** ADERA never holds, moves, or represents money.
  It creates no cryptocurrency, no payment instrument, and no monetary-authority
  concern. Settlement clears through whatever banking rails a market already
  trusts.
- **Regulator oversight without regulator dependency.** The regulator holds a
  first-class, read-only role with total visibility and zero ability to distort
  the market — and the network keeps running whether or not the regulator's
  systems are online.

This document specifies the architecture, the governance model, who operates
the infrastructure and at what cost, how money moves, what the design does
*not* protect against, and how a regulator would mandate it. §11 states plainly
which parts of the design exist as working code today and which do not.

---

# Part I — The problem

## 1. Roaming, and the piece the standards do not cover

### 1.1 The three actors

| Actor | What it is |
| --- | --- |
| **CPO** — Charge Point Operator | The company that owns and runs the physical charging stations. A hardware and site business. |
| **eMSP** — e-Mobility Service Provider | The company that sells charging *access* to drivers. It may own no chargers at all — it resells access across many CPOs' networks, bills the driver once, and settles behind the scenes. Think of a mobile virtual network operator, but for charging. |
| **Regulator** | The public authority that licenses market participants and sets the rules they operate under. |

A single company can be both a CPO and an eMSP; the design treats these as two
separate registrations, so that a company operating in both capacities is
accountable separately for each.

**Roaming** is the industry's term, borrowed directly from mobile telephony:
letting a customer of network A use network B's infrastructure. Without it, a
driver whose app is eMSP X can only charge at stations belonging to CPOs that
eMSP X has individually and manually integrated with. A charger sitting
directly in front of that driver is unusable if the commercial paperwork was
never done.

### 1.2 What OCPI solves, and what it leaves open

The industry already has a published standard for a CPO's system and an eMSP's
system to talk automatically: **OCPI**. OCPI defines the *message format* — how
to say "here are my stations," "this driver's token is valid, let them charge,"
and "here is the bill for the session that just ended." That bill is a **CDR
(Charge Detail Record)**, and it is the shared source of truth both sides
reconcile against.

> **A note on a similar acronym.** OCPI is not OCPP (Open Charge Point
> Protocol). OCPP runs between a physical charger and its *own* operator's
> back-end — internal plumbing that never crosses a company boundary. ADERA
> concerns OCPI, the operator-to-operator layer, exclusively.

What OCPI does **not** define is **discovery and trust**: how operator A learns
that operator B exists, what address to reach it at, and how to be certain that
the system answering really is B and not an impostor. Every national market
must fill that gap somehow. How it is filled determines the market's structure
for a decade.

---

# Part II — The choice

## 2. Two ways to build the missing piece

### 2.1 Option A: a central clearing house

Every operator holds a technical and commercial relationship with one hub
company. Discovery, identity, and frequently message-relay and settlement are
all mediated centrally.

```
   CPO-A ─┐                        ┌─ eMSP-X
   CPO-B ─┼──►  [ CENTRAL HUB ]  ◄─┼─ eMSP-Y
   CPO-C ─┘      (single company)  └─ eMSP-Z
                       │
             owns discovery + identity
             sees all roaming metadata
             single point of failure / leverage
```

This works, and it is what most markets have done. Its costs are structural
rather than technical:

- The hub sees which operators interconnect, at what volume — the market's
  competitive map, held by one commercial party.
- The hub is a single point of failure for national charging interoperability.
- The hub sets the price of admission to the market, and can change it.
- In a small market, the hub is frequently foreign-owned, placing national
  infrastructure metadata outside national jurisdiction.

### 2.2 Option B: a shared registry the market jointly runs

Operators publish their identity and address to a shared registry that they
*collectively* govern. Discovery is a lookup against that registry. Every
actual OCPI conversation is a **direct**, mutually authenticated, encrypted
connection between exactly two operators.

```
        ┌─────────────── ADERA shared registry ───────────────────┐
        │  tamper-evident directory: Party ID -> address + key     │
        └──▲───────────▲───────────▲───────────▲───────────▲───────┘
           │ read      │ read      │ read      │ read      │ read
        CPO-A        CPO-B       eMSP-X      eMSP-Y      Regulator (observer)
           └───── direct peer-to-peer OCPI ─────┘
                    (no data touches the registry)
```

Nobody owns the registry. There is no company in the middle to pay, to depend
on, or to be compromised. The registry holds no operational data and no money.

### 2.3 This is a policy decision, not a technical one

Both options deliver working roaming. They differ in **who ends up holding
power over the market**. That makes the choice a matter for the regulator
rather than for the operators' engineering teams, and it is the reason this
document is addressed to policymakers first.

---

# Part III — How the shared registry works

## 3. The registry, without the jargon

### 3.1 What a "permissioned ledger" actually is

ADERA's registry is a **permissioned distributed ledger**. Stripped of the
terminology, that is:

- **A database** — holding one record per licensed operator.
- **Replicated** — every participating organisation holds a complete copy.
  There is no master copy and no host.
- **Append-only** — records are added and superseded, never silently edited or
  deleted. The full history remains readable and tamper-evident.
- **Permissioned** — only vetted, licensed, explicitly approved organisations
  may hold a copy or write to it. This is *not* a public cryptocurrency network.
  There is no mining, no speculation, no anonymous participants, and no
  meaningful energy consumption.
- **Jointly governed** — no single copy-holder can change a record alone. A
  change requires a defined majority to agree.

The software is **Hyperledger Besu**, a mature open-source enterprise ledger,
configured in a mode called **IBFT 2.0**. Two properties of that mode matter to
a regulator:

- **Immediate finality.** When a change is recorded, it is final at once. There
  is no waiting period and no possibility of the history being rewritten later.
- **Known writers.** Records are written only by a defined, vetted set of
  organisations — never by anonymous parties.

The rules governing the registry are written as a **smart contract**: a short,
published program (`AderaRegistry`) that every copy of the ledger runs
identically. Because every participant runs the same rules over the same data,
no participant can apply a different rule to itself. The contract's source is
open and auditable; it is, in effect, the rulebook rendered as executable text.

### 3.2 "Why not just use a normal database?"

This is the right question, and it deserves a direct answer rather than a
deflection.

A conventional shared database would work perfectly well — **provided somebody
hosts it**. And that is the whole problem: whoever hosts it is a hub. They can
change a record, take the service offline, observe every lookup, and set the
terms of access. Section 2.1's objections apply to a hosted database exactly as
they apply to a hub company, because a hosted database *is* one.

The alternatives fail for concrete reasons:

| Approach | Why it does not hold up |
| --- | --- |
| **Hosted by one operator** | A competitor controls the market's directory. Non-starter commercially. |
| **Hosted by the regulator** | Puts a public authority in the operational critical path: if the regulator's system is down, national charging roaming stops. Regulators generally do not want, and should not accept, that liability. |
| **Hosted by a neutral third party** | This is simply Option A with a friendlier owner. The dependency, the leverage and the single point of failure are unchanged. |
| **Each operator keeps its own list** | No shared truth. Revocation does not propagate — a licence is withdrawn and stale entries keep working for months. |

The ledger is the specific technology that provides a shared, consistent,
tamper-evident directory **with no host at all**. That is the one property
being bought, and it is bought precisely because the alternatives all reduce to
"choose whom the market depends on."

It is worth being equally clear about what is *not* being claimed. ADERA uses
no cryptocurrency and no token. It stores no transactions, no money, and no
personal data. The ledger is a directory — deliberately the least interesting
technical component in the system, and intentionally so.

### 3.3 What the registry holds, and what it never holds

For each operator, the registry holds the minimum required to *find and
authenticate* them — and nothing more.

| On the registry (visible to members and the regulator) | Never on the registry — stays between the two operators |
| --- | --- |
| Party ID: a country code plus a three-character operator code | OCPI tokens, module addresses, API credentials |
| The operator's bound governance key (its legal identity) | Charging sessions, station locations, tariffs |
| An **encrypted** address blob | Charge Detail Records (the bills) |
| A public key, used to verify the operator's signature | All personal data and all commercial data |
| Active / revoked status | All bank account details and payment instructions |
| The full history of admissions, revocations and key changes | The operator's real, routable network addresses in the clear |

This division is the architecture's load-bearing wall. Because roaming data
never transits any shared component, the largest privacy and competition risks
of a hub model simply do not arise — there is nowhere for that data to
accumulate.

### 3.4 Why even the address is encrypted

The address of each operator's system is not published in readable form. It is
stored as an encrypted blob, decryptable only with a key held by admitted
members.

The reason is practical. The registry is readable by every member and by the
regulator, and a readable list of every address in the national charging
network would be a ready-made target map for anyone who obtained a copy.
Encrypting it means that even a leaked copy of the registry does not disclose
the network's topology. Members can resolve addresses; the world cannot.

### 3.5 What "zero trust" means here

"Zero trust" is meant literally, and it is worth spelling out because the term
is often used loosely.

A system reading the registry trusts **no intermediary at all** — not the
registry, not the other copy-holders, not the regulator. It reads a record, and
then independently verifies, at the moment it connects, that the system at the
far end actually controls the private key bound to that Party ID.

The registry is therefore **not a source of permission to be trusted**. It is a
source of *facts that can be independently checked*. Nothing in the design
requires a participant to take any other participant's word for anything.

## 4. How trust is actually established

### 4.1 One legal entity, one identity, bound permanently

Each licensed operator is bound 1:1 to a single Party ID in the registry. The
binding is created once, at admission, and cannot subsequently be altered — not
by the operator, not by other members, not by the regulator.

This is what makes identity theft structurally hard rather than merely
discouraged. An attacker cannot register a second claim to an existing Party ID
because the binding already exists and the contract rejects any second claim.
Nor can they create convincing volumes of fake operators, because admission is
a governed vote (§5.1), not a sign-up form.

An operator *can* update its own address and its own signing key at any time —
those rotate routinely, and every rotation is logged. What never changes is
which legal entity the identity belongs to.

### 4.2 Proving control at the moment of connection

Holding a registry entry is not sufficient to be trusted. When two operators
connect, the caller must prove *live control* of the private key the registry
names.

The sequence, in plain terms:

1. The caller signs its request with its private key, covering the message
   body, the current time, and a single-use random number.
2. The receiver recovers which key produced that signature.
3. The receiver checks that key against the registry entry for the Party ID the
   caller claims — **and** checks that the claimed role (CPO or eMSP) matches
   what the registry says.
4. The receiver rejects the request if the timestamp is outside a narrow
   freshness window, or if that single-use number has been seen before.

Steps 1–3 defeat impersonation: a signature can only be produced by whoever
holds the private key. Step 4 defeats replay — an attacker who captures a valid
request cannot resend it later, because it has already been spent and the clock
has moved on.

This matters commercially, not just technically. Impersonating a supplier in
order to redirect its payments is one of the most common frauds in ordinary
business, and a letter on company letterhead is no defence against it. Here,
the counterparty's identity is proven cryptographically against a registry that
no single party can forge an entry in.

### 4.3 Defence in depth

No single control is relied upon. A successful attack must defeat **every**
relevant layer, not one.

| # | Layer | What it blocks |
| - | --- | --- |
| 1 | Network permissioning | Unauthorised computers joining the ledger network at all |
| 2 | Write permissioning | Unknown keys writing to the ledger |
| 3 | Consensus | Unauthorised parties recording blocks |
| 4 | Contract authorisation | Ungoverned changes; misuse of the regulator's role |
| 5 | Identity binding | Party ID spoofing or hijacking |
| 6 | Connection handshake | Impersonation over OCPI |
| 7 | Transport encryption | Eavesdropping and interception |
| 8 | Encrypted addresses | Leaking the network's topology |

The full threat model and the specific mitigations at each layer are in
`02-System-Architecture-Security-Design.md`.

## 5. Governance

### 5.1 Admission is a vote of the market, not an administrator's decision

New participants are not admitted by an administrator. They are admitted by a
vote of the operators already admitted — an **M-of-N multi-signature approval**
encoded in the contract. ("Multi-signature" means an action takes effect only
once a defined number of independent parties have each signed their approval;
it is the digital form of a document requiring several authorised signatures.)

```
 propose admission of a new operator     -> creates a proposal,
                                            automatically counted as the
                                            proposer's own approval

 each further member approves            -> approvals accumulate

 approvals reach the threshold           -> admission takes effect atomically:
                                              * Party ID bound 1:1 to the entity
                                              * address, public key and active
                                                status recorded
                                              * the new operator joins the
                                                governance member set
```

The same mechanism governs revocation, reinstatement, adding and removing
governance members, changing the approval threshold, and transferring the
regulator's auditor role.

**No single key can unilaterally admit, remove, or impersonate a participant —
including the key of whoever deployed the system, and including the
regulator's.** This is the on-chain expression of a consortium: the market
collectively controls its own membership, under rules the regulator sets.

### 5.2 The regulator: total visibility, zero mutation power

The regulator holds a dedicated, first-class, **read-only** role — the *auditor
key*. It is designed against three goals simultaneously:

- **Total visibility.** Every governance action emits an event: admissions,
  revocations, address changes, key rotations, membership and threshold
  changes. The regulator runs its own observer copy and sees the complete,
  tamper-evident history in real time. No operator can conceal an admission or
  a key rotation.
- **No mutation power.** The auditor key cannot admit, revoke, or alter any
  party. Its only state-touching capability is to record a **compliance probe**:
  a timestamped, non-repudiable attestation that the regulator inspected a
  given party. This lets the regulator *prove it exercised oversight* while
  being structurally incapable of distorting the market.
- **No systemic dependency.** Because the auditor only observes, the network's
  liveness does not depend on the regulator being online. If the regulator's
  systems are down, roaming continues and oversight resumes on return.
  Equally, the regulator is never a bottleneck operators must transact through.

Should custody of the auditor key need to change — a hardware migration, or a
suspected compromise — that transfer is itself a governed, logged action,
auditable like everything else.

### 5.3 The lifecycle, end to end

```
 Genesis:    founding operators seeded as parties AND governance members;
             approval threshold set; regulator's auditor key recorded.
     │
     ▼
 Admission:  existing members propose and approve a new operator (M-of-N).
     │       The newcomer is bound to its Party ID and joins the member set.
     ▼
 Operation:  operators self-service rotate their OWN address and signing key
     │       (every rotation logged); the identity binding stays immutable.
     ▼
 Oversight:  regulator observes all events; records compliance attestations.
     │
     ▼
 Revocation: on breach or exit, members vote to revoke — the party goes
             inactive, loses its governance vote, and its systems are dropped
             from the network allowlist.
```

## 6. Who runs the infrastructure, and what it costs

"Who actually runs this?" is the first operational question a regulator asks.
This section answers it.

### 6.1 Holding an identity and running infrastructure are different things

These are two separate mechanisms and conflating them causes most of the
confusion about ledger-based systems:

| | Running a validator | Governance membership |
| --- | --- | --- |
| Decides | Who records blocks | Who votes to admit and revoke |
| Changed by | A vote of existing validators | A multi-signature proposal |
| **Required to participate in roaming?** | **No** | Yes |

Most participants in a mature network will hold an identity and run **no ledger
infrastructure at all**. They are listed, discoverable, and able to vote on
admissions, while someone else runs the machinery. Only organisations that want
independence from other parties' infrastructure need to run a node.

### 6.2 What a validator can and cannot do

This bounds how much the previous question matters. Validators **order
records**. That is the entirety of their power. A colluding majority could
stall the network or refuse to record a change. They **cannot**:

- forge any operator's identity — that requires that operator's private key;
- admit, revoke or alter any party — that requires the governance vote;
- read anything private — they see exactly the public data every member sees.

Validator power is therefore **liveness, not authority**. A thin or partly
self-interested validator set can slow the network; it cannot rewrite who
anyone is, or quietly admit an unlicensed operator.

### 6.3 The recommended model and sizing

The natural arrangement is that **each eMSP runs one validator and one gateway,
co-located**. eMSPs are already software-operating businesses; CPOs are
hardware and site businesses that typically prefer to outsource hosting. Three
properties make the pairing worth keeping together:

- **Outage tolerance.** Each gateway reads the registry from its *own*
  co-located node, so lookups survive an internet outage as long as the local
  machine is up.
- **No dependency on a rival.** No operator must ask a competitor's
  infrastructure to confirm who its counterparties are.
- **Skin in the game.** The parties benefiting from the network keep it alive.

Sizing follows from the consensus algorithm, which needs `3f + 1` validators to
tolerate `f` simultaneous failures:

| Validators | Failures tolerated | Comment |
| --- | --- | --- |
| 2 | **0** | Demonstration only. Both must be up. |
| 4 | 1 | The practical production minimum |
| 7 | 2 | Comfortable for a national network |
| ~20+ | — | Coordination overhead grows quadratically; performance degrades well before this |

Four to seven validators is achievable and correctly sized for a small national
market. **Validators need not be operators at all** — where the operator count
is low, the gap is well filled by neutral parties: the regulator, a bank, an
industry association, or a university.

### 6.4 Indicative cost

One operator running a co-located validator and gateway on mainstream cloud
infrastructure, sized generously:

| Item | Approx. per month |
| --- | --- |
| Compute (2 vCPU, 4 GiB, burstable) | ~$38 |
| Storage (100 GB SSD) | ~$10 |
| Snapshots and backup | ~$5 |
| Data transfer | ~$5 |
| **Total** | **~$58** |

Reserved pricing removes roughly 30–40%. Adding a firewall, load balancer,
managed key storage and monitoring places a production setup in the low
hundreds of dollars a month. **These are indicative figures for scale, not
quotes** — verify against current pricing before budgeting.

The relevant conclusion is that infrastructure cost is not a barrier to entry
at any plausible market size, and is a small fraction of what hub membership
fees typically cost.

---

# Part IV — Money

## 7. Settlement

### 7.1 ADERA clears identity, not money

ADERA draws a hard line between **roaming interoperability** (its concern) and
**financial settlement** (the operators' and their banks' concern). The
registry is tokenless and is never a party to a payment.

Instead, each operator's gateway loads a **payment plugin**, and the rest of
the system is entirely agnostic to which banking rail is used. An operator
settling through a direct-debit style mandate and an operator settling through
a real-time interbank transfer interoperate for *charging* with no coordination
whatsoever about *payment*. The rail is a private implementation detail of each
bilateral relationship.

This is a deliberate regulatory property: because ADERA never holds, moves, or
represents value, it does not constitute a payment instrument, a security, or a
monetary-authority concern in any jurisdiction.

### 7.2 The interface

```
interface PaymentPlugin {
  name: string

  // Called once when two operators complete a handshake: establishes the
  // settlement relationship on the chosen rail.
  openSettlementChannel({ localParty, remoteParty, remoteRole })
      -> { channelId, rail, mandateRef }

  // Called per settled Charge Detail Record.
  settleCdr({ channelId, cdr }) -> { settlementRef, rail, amount, status }
}
```

Supporting a new rail — including a specific commercial bank's own API — means
implementing these two methods against that rail. **No change to OCPI, to
discovery, or to the registry is required**, and no other participant needs to
be consulted.

### 7.3 Who pays whom — identity is not the same as payee

One principle makes the commercial arrangements tractable:

> **The Party ID says who *did the work*. It does not say who *gets paid*.**

The CDR remains attributed to the CPO that actually delivered the energy, in
every model. The *destination of the funds* is a property of the settlement
relationship, not of the registry entry. Three arrangements all work without
any change to the architecture:

| Model | How it works | Suits |
| --- | --- | --- |
| **Direct bilateral** | The eMSP pays the CPO directly | Simplest; money and identity follow the same path. Relationship count grows as N×M |
| **Payout assignment** | The CPO keeps its identity, CDRs and legal claim, but nominates another party to receive the funds | A CPO whose infrastructure is hosted by a partner |
| **Aggregated counterparty** | One netted transfer covers all CPOs fronted by an aggregator, who then distributes | High-volume relationships; minimises transfer fees |

Accountability is unaffected in all three: the record of who delivered the
energy is unchanged and remains attributable to the licensed operator.

### 7.4 Bank details are never on the registry

No account details, in any form, encrypted or otherwise. This is a deliberate
exclusion rather than an omission, and "just encrypt them" is not a fix:

- Every admitted member holds the same decryption key, so "encrypted on the
  registry" would mean **readable by every competitor**.
- The registry is append-only. Details published once could never be truly
  erased — a serious problem for banking data.
- It would pull the registry inside the scope of financial-data regulation for
  no corresponding benefit.

So: the **registry holds identity**, the **payment rail holds the account**, and
the two are linked once, bilaterally, when the relationship is opened.

Where account coordinates do have to cross between two operators, they are sent
down the connection whose identity has *already been cryptographically proven*
(§4.2) — which is materially stronger than the emailed PDF that ordinary
business relies on today. If an operator later changes banks, it pushes the new
details down that same proven channel and every counterparty updates
automatically, with no re-papering and no window for supplier-impersonation
fraud.

### 7.5 Settlement is decoupled and must never block charging

A charging session completes in real time; a bank posting may take seconds,
minutes, or a maintenance window. Settlement is therefore driven by
**fire-and-forget events**:

1. On handshake completion and on each CDR, the payment plugin emits a signed
   event.
2. The event is sent to the operator's **own** bank connector — never to any
   shared endpoint.
3. Delivery is asynchronous and failure-isolated. A slow or offline rail is
   logged and retried, and **never** propagates an error into the charging flow.
   CDRs that cannot yet be settled are held in a durable, order-preserving
   offline queue.

Nor does settlement need to be per-session. Per-CDR, batched, and netted
settlement are all legitimate, and batching is the common default: a single
charging session is a small-value transaction, so a flat interbank fee can
consume several percent of it.

The security boundary this creates is clean: the registry and the OCPI layer
know nothing about bank credentials, and the bank connector knows nothing about
ledger keys. Each side holds only what it needs.

---

# Part V — Operations and limits

## 8. When things break

The design assumes unreliable power and unreliable connectivity rather than
treating them as exceptional.

| Failure | Behaviour |
| --- | --- |
| **A ledger node loses power** | It rejoins and re-synchronises from its peers on restart. Because records are final when made, there is no reconciliation or rollback. Nothing is lost. |
| **An operator's internet drops** | Its gateway keeps reading the registry from its own co-located node, so it retains full knowledge of who its counterparties are. New peer connections cannot be made until connectivity returns; existing knowledge is unaffected. |
| **A bank rail is offline** | Settlement queues; charging is entirely unaffected (§7.5). |
| **A CDR cannot be delivered** | It is held in a disk-persisted, order-preserving queue that halts at the failed item rather than skipping it, so bills are never silently lost or reordered. |
| **The regulator's systems are down** | Nothing happens. Roaming continues; oversight resumes on return. |

## 9. What ADERA does not protect against

A specification that only lists its strengths is not usable for regulatory
decision-making. Two limits deserve explicit statement.

**Quantity manipulation is not solved, and cannot be solved at this layer.**
ADERA and OCPI together close *price* manipulation: a CPO cannot quietly bill a
rate different from the one it published, because the published tariff was
exchanged over a channel tied to its proven identity, so a mismatch is provable
and non-repudiable. What remains open is *how much energy was actually
delivered*. That figure comes from the CPO's own meter reading, and no
signature, identity binding or tariff check was ever designed to verify it. A
dishonest CPO applying the correct published rate to an inflated kWh figure
passes every check in this document.

This is a **metrology and licensing matter**, not an architectural one. The
appropriate controls are legal metrology requirements on charger hardware,
periodic verification, and the regulator's inspection powers — for which §5.2's
compliance-probe attestations provide a tamper-evident audit trail. Any
alternative architecture, including a central hub, has exactly the same gap.

**Validator collusion can affect liveness.** As §6.2 sets out, a colluding
majority of validators could stall the network. They cannot forge identities or
alter membership. Adequate validator count and diversity (§6.3) is the
mitigation, and it is a governance obligation rather than a technical one.

---

# Part VI — Adoption

## 10. Adopting ADERA as a national standard

ADERA is written to be **adopted verbatim as a national technical standard** and
mandated as a licence condition. Because the specification is open and the
reference implementation is free software, adoption imposes no licensing cost
and creates no dependency on any single vendor — the defining characteristic of
a sovereign public standard.

### 10.1 What a mandate references

A licence condition adopting ADERA would specify:

1. **Protocol.** OCPI 2.2.1 for all inter-operator roaming.
2. **Directory.** The `AderaRegistry` contract interface as the sole national
   discovery mechanism. No operator may require a competitor to integrate a
   proprietary hub.
3. **Identity.** Every licensed operator binds one legal entity to one Party ID
   on the registry, with a hardware-protected key.
4. **Governance.** Admission and revocation by consortium multi-signature under
   a regulator-approved threshold and rulebook; the regulator holds the auditor
   key.
5. **Settlement.** Rail-neutral. Operators must support at least one
   regulator-recognised local rail through the payment-plugin interface.
6. **Security baseline.** The network permissioning, transport encryption and
   key-binding requirements of `02-System-Architecture-Security-Design.md`.
7. **Metrology.** Charger measurement accuracy and verification requirements,
   addressing the gap in §9 — noting that this sits outside ADERA itself.

### 10.2 A phased rollout

| Phase | Outcome | Prerequisites |
| --- | --- | --- |
| **1. Establish** | Genesis network stood up with founding operators; regulator's auditor key recorded; rulebook and threshold approved | Regulator-approved governance rulebook; 4+ validator hosts identified |
| **2. Onboard** | Existing licensed operators admitted by vote; identities bound; handshake interoperability proven pairwise | Each operator runs a gateway or contracts a host |
| **3. Interoperate** | Full OCPI module coverage in production; roaming live for drivers | Operators implement the OCPI modules beyond discovery |
| **4. Settle** | Live banking rails replace manual reconciliation | Bank connector integrations; mandate registration |
| **5. Mandate** | ADERA becomes a licence condition for all new entrants | Phases 1–3 demonstrably stable |

The ordering matters: mandating before phase 3 is stable converts a technical
risk into a political one.

## 11. Status of the reference implementation

This repository contains a working reference implementation. Stating precisely
what it does and does not do is part of the specification's credibility.

**Implemented and demonstrable end to end:**

- The registry contract in full — the role model, the 1:1 identity binding, the
  propose/approve/execute multi-signature flow, the auditor's probe-only power,
  and every governance event.
- The signed handshake of §4.2 exactly as described, including the freshness
  window, single-use numbers, and the role check, each failure producing a
  tagged security log line.
- Encrypted addresses, and dynamic address resolution on every handshake with
  no static peer table.
- The order-preserving offline CDR queue of §8.
- The complete governance lifecycle of §5.3, including a third-party admission
  by vote and a regulator compliance attestation.
- Two-tier network and account permissioning.

**Not yet built, and required for production:**

1. **Automatic network allowlist projection.** Production requires a service
   that watches admission and revocation events and updates each node's network
   allowlist automatically. Today that file is maintained by hand, which means
   onboarding a new operator requires every incumbent to edit a file. **This is
   the single largest gap between the reference implementation and a deployable
   system.**
2. **A standing regulator observer.** The auditor role currently exercises one
   transaction rather than running a continuous observer node.
3. **Real payment rails.** The plugins log and emit a mock event rather than
   contacting a bank. The mandate reference is generated randomly; a correct
   integration would *receive* it from the rail as an input, alongside the
   payee, rather than inventing one.
4. **Transport encryption and hardware key storage.** The sandbox runs plain
   HTTP with disposable test keys, not the mutual-TLS and hardware-protected
   keys the specification requires.
5. **The remaining OCPI modules.** Only discovery, version negotiation,
   credentials and a stub CDR receiver exist. Locations, Tariffs, Tokens,
   Sessions and Commands are unimplemented.
6. **Production validator count.** The sandbox runs two validators and
   therefore tolerates zero failures (§6.3).

The reference implementation is a proof of ADERA's **identity, discovery and
governance layer** — the part that is architecturally novel and the part a
regulator must evaluate. It is not a complete OCPI server, and it is not
production-ready as shipped.

---

# Appendix A — Glossary

| Term | Meaning |
| --- | --- |
| **CDR** | Charge Detail Record. The itemised bill for one completed charging session; the shared source of truth both operators reconcile against. |
| **CPO** | Charge Point Operator. Owns and runs physical charging stations. |
| **eMSP** | e-Mobility Service Provider. Sells charging access to drivers, typically across many CPOs' networks. May own no chargers. |
| **Gateway** | The software an operator runs to speak OCPI to its counterparties and to read the registry. |
| **IBFT 2.0** | The consensus mode used here: a defined set of known organisations records changes, and changes are final immediately. |
| **Multi-signature** | An action takes effect only when a defined number of independent parties have each approved it. |
| **OCPI** | Open Charge Point Interface. The standard message format between two *companies* for roaming. |
| **OCPP** | Open Charge Point Protocol. Between a charger and *its own* operator's back-end. Internal; not part of ADERA. |
| **Party ID** | An operator's identifier: a country code plus a three-character code. Bound 1:1 to one legal entity. |
| **Permissioned ledger** | A replicated, append-only, jointly governed database whose copy-holders are all vetted and known. No cryptocurrency involved. |
| **Public / private key** | A paired set of numbers. The private key signs; the public key lets anyone verify that signature without being able to forge one. |
| **Rail** | A banking payment mechanism — direct debit, interbank transfer, a bank's own API. |
| **Roaming** | Letting a customer of one network use another network's infrastructure. |
| **Smart contract** | A short published program every copy of the ledger runs identically, so no participant can apply different rules to itself. |
| **Validator** | An organisation running a node that records changes. Holds ordering power only — no authority over identity or membership. |

# Appendix B — Mapping to the reference implementation

| Concept in this document | Where it lives in the code |
| --- | --- |
| The registry and its rules | `contracts/AderaRegistry.sol` |
| Party ID → address mapping | `Party` struct, `resolveEndpoint()` |
| Identity binding (§4.1) | `entityToParty`, `_registerParty()` |
| Admission by vote (§5.1) | `propose()` / `confirm()`, `proposeAdmitParty()` |
| Regulator auditor role (§5.2) | `auditor`, `auditProbe()`, `ComplianceProbe` event |
| Encrypted addresses (§3.4) | `endpointCipher` + gateway decryption |
| Handshake proof of control (§4.2) | `gateway/lib/crypto.js`, `ocpi.js`, `replayGuard.js` |
| Permissioned network (§4.3, layers 1–3) | `network/genesis.json`, `permissions_config.toml` |
| Payment plugin layer (§7.2) | `gateway/lib/payments.js` |
| Offline CDR queue (§8) | `gateway/lib/offlineQueue.js` |
| Governance lifecycle (§5.3) | `contracts/deployer/deploy.js` |

---

*ADERA is published by **Industrial Dynamics** as an open specification. It may
be adopted, implemented, and mandated without licence fee. The reference
implementation is free software.*

*For the full threat model and control specification, see
`02-System-Architecture-Security-Design.md`. For extended commentary and worked
examples, see `00-ADERA-Plain-English-Guide.md`. For running the reference
implementation, see the repository `README.md`.*
