# ADERA, Explained in Plain English

*Unofficial companion — not an official governance document, not part of the
formal spec. It describes the general pattern in jurisdiction-neutral terms;
the reference deployment covered by the other two documents targets a
specific country's regulator and payment rails.
Diagrams are [Mermaid](https://mermaid.js.org/) code blocks, which render
automatically on GitHub and in most modern Markdown viewers (VS Code needs
the "Markdown Preview Mermaid Support" extension).*

Companion to:
- `01-ADERA-Whitepaper-PUCSL-Governance.md` — the formal thesis and governance spec
- `02-System-Architecture-Security-Design.md` — the threat model and defense-in-depth spec

This document follows the same structure as those two.

---

## 0. The problem

Any market with growing EV adoption ends up with multiple companies
installing and running EV chargers. Call
each one a **CPO — Charge Point Operator** (the company that owns/operates the
physical charging stations). Each CPO usually has its own app.

Separately, some companies just sell charging *access* to drivers without
owning any chargers themselves — they resell access across multiple CPOs'
networks, bill the driver once, and settle behind the scenes. Call this an
**eMSP — e-Mobility Service Provider** ("e-mobility service provider" — think
of it like a virtual network operator, but for EV charging instead of mobile
phones).

Today, a driver who is a customer of eMSP "X" can only charge at stations
belonging to CPOs that eMSP X has *individually, manually* integrated with.
If eMSP X hasn't done a deal with CPO "B", the driver is locked out of CPO
B's chargers even if one is sitting right in front of them. This is called
**roaming** in this industry (borrowed directly from the mobile-phone
industry meaning: "let a customer of network A use network B's
infrastructure"), and the *lack* of it is the problem ADERA exists to solve.

The industry already has a published, standard way for a CPO's system and an
eMSP's system to talk to each other automatically — it's called **OCPI (Open
Charge Point Interface)**. OCPI defines the *message format*: how to say "here
is a list of my charging stations," "this driver's token is valid, let them
charge," "here is the bill for the session that just finished" (that bill is
called a **CDR — Charge Detail Record**). OCPI does **not** define how two
companies are supposed to *find* each other and decide to trust each other's
messages in the first place. That missing piece — discovery and trust — is
what the rest of this document is about.

> **Note on a similar-looking acronym:** OCPI is not the same as **OCPP**
> (Open Charge Point Protocol), which is the *separate* protocol used between
> a physical charger and its own CPO's back-end (i.e., "the charger says a car
> plugged in"). ADERA and this whitepaper are entirely about OCPI —
> operator-to-operator roaming — not about the charger hardware itself.

---

## 1. Two ways to solve "how do operators find and trust each other"

### 1.1 Option A (the usual answer elsewhere): a central clearing house / "Roaming Hub"

Globally, the common solution is: one company builds a "hub." Every CPO and
every eMSP signs a contract with *that one company*, integrates with *its*
API, and all roaming traffic between operators is relayed through it.

```mermaid
flowchart LR
    CPOA["CPO A"] --> HUB
    CPOB["CPO B"] --> HUB
    CPOC["CPO C"] --> HUB
    HUB[("Central Hub<br/>(single private company)")]
    HUB --> EMSPX["eMSP X"]
    HUB --> EMSPY["eMSP Y"]
    HUB --> EMSPZ["eMSP Z"]
```

The whitepaper's objection to this, in plain terms: that one company now sits
in the middle of *every* transaction in the national EV market. It can see
who charges where, it can raise its fees once everyone depends on it, it can
be acquired by a foreign or competing entity, and if its servers go down, the
entire country's EV roaming goes down with it. For a small national market,
that's a lot of concentrated risk sitting inside a single private balance
sheet.

### 1.2 Option B (ADERA's answer): a shared, jointly-run directory instead of a company

Instead of a company in the middle, ADERA proposes a **ledger** — meaning,
plainly, a database of records that is (a) shared by all the operators
jointly instead of owned by one of them, (b) append-only / tamper-evident (you
can add new facts, but you can't secretly rewrite old ones), and (c) each
operator runs their own copy and they all agree on its contents through a
technical process called **consensus** (explained in §3).

Crucially, the ledger is used for exactly one narrow job: answering "for
Party ID `XX/XXX`, what is the current, verified address and public key to
contact them at?" It is **not** used to carry the actual OCPI traffic
(session data, tariffs, CDRs) or any money. Once two operators have looked
each other up, they talk to each other **directly** — a normal encrypted
connection between their two servers, nobody in the middle.

```mermaid
flowchart TB
    LEDGER[("ADERA permissioned ledger<br/>(shared directory: PartyID → endpoint + public key)")]
    CPOA["CPO A"] -- "read" --> LEDGER
    CPOB["CPO B"] -- "read" --> LEDGER
    EMSPX["eMSP X"] -- "read" --> LEDGER
    EMSPY["eMSP Y"] -- "read" --> LEDGER
    REGULATOR["Regulator<br/>(read-only observer)"] -- "read" --> LEDGER
    CPOA <-. "direct P2P OCPI, encrypted (mTLS)<br/>— no data touches the ledger" .-> EMSPX
```

**"Permissioned"** means: unlike Bitcoin or Ethereum's public networks, where
literally anyone in the world can join and read/write, this ledger's
membership is a closed, vetted list — only licensed operators (and
the regulator itself) can even connect to it. **"P2P" (peer-to-peer)** just means two
parties talking directly to each other with no intermediary relaying the
conversation.

### 1.3 What actually goes on the ledger, and what deliberately never does

| Goes on the ledger (public to members + the regulator) | Never touches the ledger (stays private, direct between the two operators) |
| --- | --- |
| Party ID (a country code + a 3-letter operator code, e.g. `XX/CPO`) | The actual OCPI messages — tokens, session data, module endpoints |
| The legal entity's *governance key* bound to that Party ID (explained in §3.5) | Charge sessions, station locations, tariffs (prices) |
| An **encrypted** blob containing the operator's real network address | CDRs — the actual bills for completed charging sessions |
| The operator's *messaging* public key (explained in §4) | Any personal data about drivers |
| Whether the party is currently active or has been revoked | Any money-movement instruction |
| A log of every admission / revocation / key-rotation event | The real, un-encrypted network address (see next paragraph) |

Even the network address (basically: "connect to me at this URL") is not
written in plain text. It's stored **encrypted** — more on what that means
and why in §1.4. So even though every member can technically read the whole
ledger, nobody outside the consortium can map out "here is the entire
national EV charging network's topology" just by looking at it.

### 1.4 What "zero-trust" means here

**Zero-trust** does *not* mean "we don't trust anyone, so nothing works." It
means: nobody is trusted *just because* they're listed somewhere, or *just
because* a message claims to be from them. Instead, every time two parties
connect, the receiving side independently checks a cryptographic proof — "does
this connection actually control the private key that the ledger says belongs
to this Party ID?" — at that exact moment. The ledger's job is to be a
trustworthy *source of facts to check against*, not a trustworthy *middleman
that vouches for people*.

This relies on a very standard idea from cryptography called a
**public/private key pair**: you generate two mathematically linked numbers.
One (the *public* key) you can hand out to anyone — it's used to verify
things. The other (the *private* key) you never share with anyone — it's used
to *prove* things, by producing a **digital signature** that only that private
key could have produced, which anyone holding the matching public key can
check. If a message is signed with a given private key, and the ledger says
that private key's matching public key belongs to Party ID `XX/CPO`, then the
message really did come from whoever controls `XX/CPO` — *assuming* their
private key hasn't leaked. That check is what "zero trust" is actually doing
under the hood; see the full worked example in §4.4.

### 1.5 Why encrypt the endpoint at all?

An "**endpoint**" here just means "the URL/address to connect to this
operator's server." Publishing that in clear text on a ledger that's readable
by every member (and, depending on setup, possibly the wider world) would let
anyone map the entire country's charging-network topology — which companies
exist, roughly how big they are, where their infrastructure lives. That's
commercially and security-sensitive information with no operational reason to
be public. So it's stored as `endpointCipher`: ciphertext produced by
**AES-256-GCM**, a standard, fast **symmetric encryption** algorithm (meaning:
the same secret key both locks and unlocks it, unlike the public/private pair
described above which uses two *different* keys). That shared secret key is
held only by admitted consortium members, so only they can decrypt an
endpoint back into a usable address.

### 1.6 Why this is the pitch for a national regulator

- **No single company in the middle.** Nobody can raise rents, get acquired,
  or unilaterally cut an operator off.
- **No single point of failure.** As long as enough of the jointly-run ledger
  nodes are online (a **quorum** — more on this in §3.2), the whole directory
  keeps working even if some operators' nodes are down.
- **Less data to leak.** Because roaming data never passes through a central
  party, there's no single database of "every EV charging session in the
  country" for a hacker (or a curious competitor) to go after.
- **The regulator can audit it directly**, without needing anyone's
  permission or cooperation (§3.4).
- **No cryptocurrency, no new payment system.** ADERA never moves or
  represents money on-chain — it only stores identity/discovery records.
  Money still moves through the country's existing banking rails (§2).

### 1.7 One company, two registrations — every combination the system must support

The diagram in §1.2 draws `CPO-A`, `CPO-B`, `eMSP-X`, `eMSP-Y` as if they're
four different companies, for clarity. The system has to work identically no
matter which real-world shape a participant actually takes — vertically
integrated (both roles under one brand), CPO-only, eMSP-only, or anything in
between — because it can't assume any one shape is dominant.

If anything, the more likely default leans the *other* way from "every
operator builds its own app": CPOs are, generally, hardware and physical
infrastructure businesses, not software companies. Building and maintaining
a consumer-facing app is a real, ongoing software-product commitment that
plenty of CPOs are poorly positioned to take on well — so a CPO with a
commercial relationship to one or more third-party eMSPs (rather than its
own app) is arguably the more likely norm, not the exception. ADERA doesn't
get to assume either way; it has to be indifferent to which shape a given
participant chooses.

The registry, however, doesn't have a concept of "a company." It only has
**Party IDs**, and looking at the actual contract
(`contracts/AderaRegistry.sol`), two rules force a strict split:

- Every `Party` record carries exactly **one** `role` — `CPO`, `EMSP`, or
  `HUB` — never more than one.
- `entityToParty` binds exactly **one** entity key to exactly **one** Party
  ID (`require(entityToParty[entity] == bytes32(0), ...)`) — a key can't be
  bound to two Party IDs at once.

So a vertically-integrated operator has to register on the ledger **twice** —
once as `XX/ALP` with role `CPO`, and again as a *separate* Party ID (say
`XX/ALQ`) with role `EMSP`, each under its **own** entity key. This isn't a
theoretical reading of the contract — it's literally how the reference
deployment is wired: `docker-compose.yml` runs two entirely separate gateway
services for a single demo participant, one with `ADERA_ROLE=cpo` and one
with `ADERA_ROLE=emsp`.

Nothing forces the pairing, though. Registration per role is fully
independent, which is what makes two other very normal business shapes
possible:

- A **CPO-only** operator that never builds a consumer app at all — it just
  registers the `CPO` role and lets other companies' eMSPs bring it drivers.
- An **eMSP-only aggregator** that owns no chargers whatsoever — it just
  registers the `EMSP` role and roams its own driver base onto everyone
  else's stations.

```mermaid
flowchart TB
    subgraph AlphaCo["Company Alpha — vertically integrated"]
        AlphaCPO["Party XX/ALP — role: CPO<br/>(entity key #1)"]
        AlphaEMS["Party XX/ALQ — role: EMSP<br/>(entity key #2, a DIFFERENT key)"]
    end
    subgraph BetaCo["Beta Charging Co. — CPO only"]
        BetaCPO["Party XX/BET — role: CPO<br/>(entity key #3)<br/>never registers an EMSP identity"]
    end
    subgraph RoamApp["RoamEV — pure aggregator app"]
        RoamEMS["Party XX/ROM — role: EMSP<br/>(entity key #4)<br/>owns no chargers, no CPO identity"]
    end

    AlphaEMS -- "roams Alpha's own drivers<br/>onto Beta's chargers" --> BetaCPO
    RoamEMS -- "roams RoamEV's drivers<br/>onto Beta's chargers" --> BetaCPO
    RoamEMS -- "roams RoamEV's drivers<br/>onto Alpha's chargers" --> AlphaCPO
```

Notice every arrow points from an `EMSP`-role party to a `CPO`-role party —
never eMSP-to-eMSP, never CPO-to-CPO. That's the general rule: **the
roaming conversation is always eMSP-role → CPO-role**, because the eMSP side
is the one vouching for a driver's identity, and the CPO side is the one
that actually hosts the physical hardware. Two vertically-integrated
companies with a full mutual-roaming deal end up running this conversation
in *both* directions (A's eMSP → B's CPO, and separately B's eMSP → A's
CPO) — it just looks like "the two companies talk to each other" from the
outside because both role-pairs live under the same brand.

### 1.8 Fronted CPOs: keep identity distinct, outsource the infrastructure

A natural question once you see how many CPOs will realistically lean on an
eMSP relationship (§1.7): if an eMSP is already fronting a CPO commercially,
does that CPO really need its *own* registration on the ledger — or could the
fronting eMSP just represent it under the eMSP's own Party ID?

**It has to stay distinct, for reasons that trace straight back to §1.1's
core thesis.** If eMSP-X signs and settles on behalf of 200 physical CPOs
under its own single identity:

- **Non-repudiation collapses to a single point of trust.** A CDR's evidentiary
  value (§4.4, §6.1 — "an unambiguous, non-repudiable piece of evidence
  against the CPO") only works because it's cryptographically tied to
  *whichever specific entity's key* produced it. Blend 200 CPOs behind one
  identity and every CDR is attributed to eMSP-X, not to whichever physical
  site's meter actually generated it — the accountability trail this whole
  design exists to create is gone.
- **It quietly recreates the hub-and-spoke risk §1.1 argues against.**
  eMSP-X becomes a mini centralized clearing house for everyone behind it —
  concentrated leverage, and a single point of failure — one layer down from
  the exact pattern ADERA was built to eliminate at the national level.
- **Revocation loses its granularity.** §3.5 and §4.3's whole point is that a
  single bad actor can be individually cut off. Blended behind one Party ID,
  a fraudulent site can only be policed by revoking *all* of eMSP-X's fronted
  CPOs at once (collateral damage to the honest ones) or by handling it
  off-chain, invisibly to the regulator — breaking §3.4's "the regulator sees
  every admission and revocation directly."

Worth being precise about what's *already* fine, though: a Party ID is
already scoped per **licensed business**, not per physical charger — one CPO's
single registration already covers arbitrarily many `Locations`. So the real
question isn't "does every charging station need its own registration" (it
doesn't, and never did) — it's "does every *licensed operator* need its own
identity," and collapsing that is what causes the problems above.

**The actual fix: separate identity from infrastructure**, the same way a
payment platform like Stripe Connect still gives every sub-merchant its own
distinct account ID even though Stripe runs all the shared infrastructure
behind them.

```mermaid
flowchart TB
    subgraph Identity["On-chain identity — stays with each CPO, cheap"]
        CPO1["CPO 1 — Party XX/AAA<br/>own entity key"]
        CPO2["CPO 2 — Party XX/BBB<br/>own entity key"]
        CPO3["CPO 3 — Party XX/CCC<br/>own entity key"]
    end
    subgraph Infra["Hosted infrastructure — operated by the eMSP"]
        Node["Shared ledger node (+ HA pair)"]
        GW["Shared OCPI gateway app,<br/>keyed per CPO"]
    end
    CPO1 -- "signs with its own key" --> GW
    CPO2 -- "signs with its own key" --> GW
    CPO3 -- "signs with its own key" --> GW
    GW --> Node
```

- **Identity stays distinct and cheap.** Each CPO keeps its own Party ID and
  entity key — a registry entry, not infrastructure. This preserves
  individual accountability and revocability at essentially no cost.
- **Hosting gets outsourced.** The eMSP runs the actual ledger node and OCPI
  gateway application, keyed to sign correctly on behalf of whichever CPO an
  interaction is for. One shared node (or HA pair) can serve many fronted
  CPOs, because on-chain traffic per CPO is negligible (§1.3 — only
  identity/governance events ever touch the chain).

  Concretely, this means one running process serves a **table of identities**
  rather than being hardwired to a single one. The reference gateway
  (`gateway.js`) currently reads one fixed `PARTY_ID` and one fixed
  `MESSAGING_KEY` from its environment at boot — one container, one identity.
  A shared eMSP-hosted deployment replaces that fixed config with a small
  keystore (`{BET: key-BET, GAM: key-GAM, DEL: key-DEL, ...}`) and adds one
  step at the front of every request: read which Party ID the request is
  *for* (e.g. from the URL path, `/party/XX-BET/ocpi/2.2.1/credentials`),
  look up that party's key, and hand it to the exact same signing/verifying
  logic that already exists. Everything downstream of that lookup —
  `signBody`, `recoverSigner`, `resolveEndpoint`, `openSettlementChannel` — is
  unchanged; it never assumed there was only one identity to begin with, it
  was just only ever given one. The per-party URL this produces (e.g.
  `.../party/XX-BET/...`) is also exactly what gets AES-256-GCM encrypted and
  published as *that* CPO's `endpointCipher` on the ledger (§1.5), so a
  roaming partner resolving it lands on the right path with no idea it's
  sharing a process with other fronted CPOs behind the scenes.
- **Sponsorship gets outsourced too.** Nothing requires a CPO to independently
  navigate the M-of-N admission process (§3.3) — an already-admitted eMSP can
  be the one calling `proposeAdmitParty` for a CPO it's onboarding
  commercially, effectively vouching for it, without merging their identities.
- **One thing should stay CPO-controlled regardless: the entity (governance)
  key itself.** §3.4/§8's cold/hot key separation exists partly for this
  reason. As long as the CPO — not the hosting eMSP — retains custody of its
  own governance key, it can prove its identity independently, rotate its
  endpoint without the host's cooperation, and switch hosting providers
  without being re-admitted from scratch. Outsourcing *operations* is a
  convenience; handing over the *key* turns it into a dependency that's hard
  to walk back.

**What this actually costs the eMSP,** beyond the bare ledger-node and
gateway compute already covered in §2's cost estimate: a WAF (**Web
Application Firewall** — filters generic web-layer attacks before they reach
the gateway's public OCPI endpoint), a load balancer for HA failover,
TLS/mTLS certificate management, monitoring/logging, and backups. The
heaviest single line item is key custody: a dedicated HSM (§3.4) runs into
four figures a month per device, which is why most real deployments reserve
a true HSM only for the rarely-touched cold governance key and use a much
cheaper **KMS** (**Key Management Service** — a software- or shared-hardware
-backed key store, roughly a dollar per key per month) for the hot,
frequently-used operational key. All-in, a lean-but-not-reckless setup lands
in the low hundreds of dollars a month — and critically, **the marginal cost
of fronting one more CPO on infrastructure that already exists is close to
zero**, since it's mostly one more registry entry and a bit of key-management
config, not new compute. That near-flat marginal cost is what makes this a
genuine value-add for the eMSP to offer rather than a burden that grows every
time it onboards another CPO.

---

## 2. How money actually moves: the payment plugin layer

### 2.1 The core idea: ADERA never touches money

A common assumption when people hear "blockchain" is "there's a cryptocurrency
or token involved." ADERA deliberately has **none**. It is **tokenless**: the
ledger only ever stores identity/discovery facts, never a balance, a coin, or
a transfer instruction. This matters to a regulator because a system that
never holds or moves money doesn't need to be licensed as a payment system or
worry about being classified as a security.

Instead, ADERA draws a hard line: *finding and trusting a roaming partner*
(the ledger's job) is completely separate from *actually paying them*
(the operators' own business, using whichever bank rail they already use).

### 2.2 What do these payment rails actually look like?

ADERA doesn't mandate a specific rail — it's built to plug into whichever
ones the local operators and banks already trust. A few common categories
show up in almost every country's financial infrastructure, under different
local brand names:

- **A national payment switch / clearing house** — many countries have one:
  a shared utility (often jointly owned by the central bank and the licensed
  commercial banks) that operates the country's standardized interbank
  payment rails.
- **Account-to-account mandate** — the customer authorizes a merchant to pull
  money directly from their bank account (similar in spirit to a direct
  debit) rather than paying by card each time.
- **Real-time interbank transfer** — moving money from an account at one bank
  to an account at a different bank, settling almost immediately (comparable
  to Faster Payments in the UK, RTP/FedNow in the US, UPI in India, or PIX
  in Brazil).
- **Direct bank host-to-host API** — no shared national rail at all; just a
  private, bilateral technical integration straight into one specific bank's
  own systems.

### 2.3 The `PaymentPlugin` interface, decoded

The whitepaper defines a small, fixed set of functions every operator's
payment integration must implement, regardless of which rail is underneath.
Reading it plainly:

```
interface PaymentPlugin {
  name: string
  openSettlementChannel({ localParty, remoteParty, remoteRole })
      -> { channelId, rail, mandateRef }
  settleCdr({ channelId, cdr }) -> { settlementRef, rail, amount, status }
}
```

- `openSettlementChannel` — "**Run this once**, the first time two operators
  start roaming with each other, to set up however money will move between
  them on whichever rail they've chosen (e.g., register an account mandate)."
  It hands back a `channelId` (an internal reference to that relationship)
  and a `mandateRef` (the rail's own reference number for the arrangement).
- `settleCdr` — "**Run this once per finished charging session** (per CDR), to
  actually trigger payment for that specific session's bill." It hands back a
  `settlementRef` (proof/receipt from the rail) and a `status`.

Because every plugin exposes exactly these two functions no matter what's
underneath, an operator on an account-mandate rail and an operator on a
real-time interbank-transfer rail (or a raw bank API) never need to agree on
anything about payments in order to roam with each other — each side's
gateway just calls its *own* plugin.

| Reference plugin | Rail | What kind of payment | 
| --- | --- | --- |
| `mandate-rail` | Account-mandate rail | Pull payment via account mandate |
| `interbank-transfer` | Real-time interbank transfer rail | Real-time push transfer between banks |
| `null` | None — manual reconciliation | No automation; someone settles it by hand later |

### 2.4 Why settlement is decoupled via webhooks, and what that means

A **webhook** is a very standard web-development pattern: instead of Service A
constantly asking Service B "is it done yet? is it done yet?" (called
**polling**), Service B just sends A a message the moment something happens.
It's an HTTP request B fires at a URL A gave it in advance.

Here, the reasoning is: a charging session finishes in real time (seconds),
but a bank might take anywhere from seconds to an entire scheduled maintenance
window to actually post a payment. If the charging/roaming system had to
*wait* for the bank before considering a session "done," a slow bank would
stall EV charging nationwide. So instead:

```mermaid
sequenceDiagram
    participant CPO as CPO Gateway
    participant EMSP as eMSP Gateway
    participant Plugin as Payment Plugin (in CPO gateway)
    participant Bank as Own Bank / national-rail connector sidecar

    Note over CPO,EMSP: Handshake completes (once, per new roaming relationship)
    CPO->>Plugin: openSettlementChannel(...)
    Plugin->>Bank: signed event: settlement.channel.opened
    Note over CPO,EMSP: ... later: charging session finishes, CDR produced ...
    CPO->>Plugin: settleCdr(channelId, cdr)
    Plugin-)Bank: fire-and-forget webhook: settlement.cdr.posted
    Note over Plugin,Bank: If the bank/webhook is slow or offline:<br/>logged + retried, held in a durable queue.<br/>NEVER blocks the OCPI/charging flow (§6).
    Bank--)Plugin: (async, whenever ready) settlementRef, status
```

A **"sidecar"** in this diagram just means a small, separate helper process
that sits next to the main gateway and handles one specific job (here:
talking to a specific bank or payment rail) — a common pattern so the main
system doesn't need to know bank-specific details directly.

This decoupling also draws a clean security boundary: the ledger and the OCPI
roaming logic never see any bank credentials at all, and the bank-connector
sidecar never sees any of the ledger's cryptographic keys. Each component only
holds the secrets it strictly needs.

### 2.5 Who actually pays whom, and how reconciliation works

This follows directly from §1.7's role split. When a driver charges on a
third-party eMSP's app at a CPO-only operator's station, **two separate
payments** happen, in opposite directions, on completely separate rails:

1. **Driver → eMSP.** The eMSP owns the customer billing relationship, so it
   charges the driver directly, on whatever terms it wants (its own card/wallet
   flow, possibly with a markup over the CPO's wholesale price). This leg has
   nothing to do with ADERA, OCPI, or any national rail — it's just the
   eMSP's own consumer payments product.
2. **eMSP → CPO.** Separately, the eMSP owes the CPO for *hosting* that
   session — typically at the CPO's own published tariff. This is the
   "interoperator settlement" leg, and it's the one §2.1–§2.4 (the
   `PaymentPlugin` interface) actually covers.

```mermaid
sequenceDiagram
    participant Driver
    participant EMSPApp as eMSP's own app (billing relationship)
    participant Station as CPO's charging station
    participant CPOGW as CPO Gateway
    participant EMSPGW as eMSP Gateway
    participant Rail as National rail (account-mandate / interbank transfer / bank API)

    Driver->>Station: charges, authenticated via the eMSP's token
    Station->>CPOGW: session data
    CPOGW->>EMSPGW: CDR (signed, direct OCPI, off-chain) — the shared source of truth
    Note over Driver,EMSPApp: Leg 1 — retail: eMSP bills the driver on its own<br/>terms. Entirely outside ADERA's scope.
    EMSPApp->>Driver: charge driver's card/wallet on file
    Note over CPOGW,EMSPGW: Leg 2 — wholesale: eMSP owes CPO for hosting,<br/>usually at the CPO's published tariff
    EMSPGW->>EMSPGW: payment plugin: settleCdr(channelId, cdr)
    EMSPGW-)Rail: signed settlement instruction, tagged with this CDR's cdr_id
    Rail--)CPOGW: funds + settlementRef
```

**What actually governs the reconciliation:**

- **The CDR is the shared source of truth.** Because it arrived over the
  cryptographically signed, on-chain-identity-verified OCPI channel (§4.4),
  both sides are looking at the *same* record, and neither can plausibly claim
  it came from someone else or was tampered with in transit.
- **`cdr_id` is the reconciliation key.** Each CDR's stable ID is what ties a
  specific settlement instruction (and the `settlementRef` the rail hands
  back) to a specific charging session — that pairing, kept by each
  operator's own bookkeeping, *is* the reconciliation record.
- **The ledger has zero visibility into any of this.** No amounts, no
  invoices, no dispute log — this is a direct consequence of §2.1's principle
  that payment is "a private implementation detail of each bilateral
  relationship." The regulator's auditor role doesn't extend here either: its
  only power is `auditProbe` over *identity/registry* oversight (§3.4), not
  financial disputes.
- **So what happens if a CPO claims it was never paid?** That's resolved the
  same way any commercial dispute between two counterparties is — through
  their own bilateral contract, their own bank statements, and the
  `settlementRef`/`cdr_id` pairing as evidence. ADERA deliberately doesn't
  arbitrate this; it only guarantees that the CDR both sides are arguing
  about is authentic and came from a verified counterparty.
- **Timing and markup are both left open.** Nothing in the spec forces
  per-CDR settlement over periodic net/batch settlement, and nothing
  standardizes the markup an eMSP applies over a CPO's wholesale tariff —
  both are bilateral business terms, not protocol rules.

---

## 3. How the ledger itself is kept trustworthy: consensus & governance

### 3.1 What "Hyperledger Besu" and "EVM" mean

**Hyperledger Besu** is an open-source piece of software — an Ethereum
client — used here to run the shared ledger. **EVM (Ethereum Virtual
Machine)** is the standardized computing environment Ethereum-family software
uses to run small programs called **smart contracts**: code that lives on the
ledger and whose rules (e.g., "only admit a new operator if enough existing
members vote yes") are enforced automatically by every node, rather than by
any one party's discretion. ADERA's registry logic (§3.5) is one such smart
contract, called `AderaRegistry`.

Using "enterprise EVM" software like Besu, rather than the public Ethereum
network, is what makes this **permissioned**: a private, invite-only version
of the same technology, not connected to or dependent on the public
cryptocurrency network at all.

### 3.2 What "IBFT 2.0" and "proof-of-authority" mean, and why it matters to a regulator

Public blockchains like Bitcoin use **proof-of-work**: anonymous participants
("miners") compete by burning huge amounts of electricity to earn the right
to add the next block of transactions. ADERA does none of that.

**IBFT 2.0 (Istanbul Byzantine Fault Tolerant 2.0)** is a **proof-of-authority**
consensus algorithm: a fixed, known set of **validators** (here, the founding
and later-admitted operators themselves) take turns proposing blocks, and a
**quorum** (a large-enough majority of them) must sign off before a block is
accepted. Two properties fall out of this that matter a lot to a regulator:

- **Immediate finality.** In proof-of-work systems, a block can technically
  get "reorganized" (undone and replaced) for a while after it's produced,
  which is why exchanges make you wait for several confirmations. IBFT 2.0
  blocks are final the instant they're produced — no reorganizations, ever.
  So the moment an admission or revocation is recorded, it's permanently
  settled.
- **No anonymous block producers, no energy cost.** Only the known,
  vetted validator set can produce blocks — there's no possibility of an
  anonymous outside miner taking over, and no proof-of-work electricity bill.

### 3.3 What a smart contract "multisig" vote actually looks like

**Multisig ("multi-signature") admission** means no single person or company
can unilaterally add or remove a market participant — it requires an
**M-of-N vote**: M signatures/confirmations out of N total existing members,
where the threshold M is itself set by governance.

```mermaid
sequenceDiagram
    participant Proposer as Existing Member (proposer)
    participant M2 as Existing Member #2
    participant M3 as Existing Member #3
    participant Reg as AderaRegistry (smart contract)
    participant New as New Operator

    Proposer->>Reg: proposeAdmitParty(XX, XXX, role, entity, endpointCipher, pubKey)
    Reg-->>Proposer: proposalId created (auto-confirmed by the proposer)
    M2->>Reg: confirm(proposalId)
    M3->>Reg: confirm(proposalId)
    Note over Reg: confirmations reached threshold (e.g. 2-of-3)
    Reg->>Reg: bind Party ID 1:1 to entity key;<br/>record endpoint + pubKey; mark active
    Reg-->>New: PartyAdmitted event — now admitted AND a governance member
```

The exact same M-of-N mechanism (not a separate system) also governs
revoking a party, reinstating one, adding/removing a governance member,
changing the threshold itself, and transferring the regulator's key
(explained next). "**No single key can unilaterally admit, remove, or
impersonate a participant**" is the point — this is what turns "a company
runs the directory" into "the market collectively runs the directory, under
rules the regulator has approved."

### 3.4 The regulator's role: read-only auditor

ADERA gives the national regulator — whichever authority licenses and
oversees charging operators in a given market — a dedicated cryptographic
key, the **auditor key**, with a very specific, deliberately narrow power:

- The regulator can **read absolutely everything** on the ledger, and every
  governance action (a new admission, a revocation, a key rotation, a
  membership change) fires an **event** — a structured, timestamped log entry
  any observer can subscribe to in real time. It can run its own copy of the
  ledger node (an **"observer node"**) specifically to watch this feed
  independently, without needing to ask any operator's permission.
- It **cannot change anything**. The auditor key has exactly one
  state-changing action available to it: `auditProbe(partyKey, note)`, which
  writes an immutable, timestamped note to the ledger saying "the regulator
  looked at this party on this date" — a way to *prove oversight was
  exercised* without ever being able to *distort the market* by admitting,
  blocking, or altering any operator itself.
- Because the regulator is only ever reading, the network's normal operation
  never depends on its node being online. If the regulator's server has an
  outage, roaming keeps working; its oversight just resumes once it's back.

If the regulator ever needs to move the auditor key to new hardware (say,
migrating to a new **HSM** — a **Hardware Security Module**, a
tamper-resistant physical device purpose-built to store cryptographic keys so
they can never be extracted, even by whoever has physical access to the
machine — or responding to a suspected compromise), that handover is itself a
logged, governed `TransferAuditor` action — visible in the same audit trail as
everything else.

### 3.5 The lifecycle, end to end

```mermaid
stateDiagram-v2
    [*] --> Genesis
    Genesis: Genesis — founding CPO + founding eMSP seeded as parties AND governance members; threshold set (e.g. 2-of-N); the regulator's auditor key installed
    Genesis --> Admission
    Admission: Admission — existing members propose + confirm a new operator (M-of-N vote); new Party ID bound 1:1 to its entity
    Admission --> Operation
    Operation: Operation — operators self-service rotate their OWN endpoint / messaging key (logged); the identity binding itself stays fixed
    Operation --> Oversight
    Oversight: Oversight — the regulator observes all events continuously; may emit ComplianceProbe attestations
    Oversight --> Operation
    Oversight --> Revocation
    Revocation: Revocation — on breach or exit, members vote to revoke; party becomes inactive, loses its governance vote, is dropped from the network allowlist
    Revocation --> [*]
```

"**Identity binding (1 entity : 1 Party ID)**" means: once `XX/CPO` is bound
to a specific company's governance key, that pairing can never be
reassigned to a different key while active — the only way to break the link
is a full governed revocation, never a quiet edit.

---

## 4. How impersonation is actually prevented

*Corresponds to Part 2 of `02-System-Architecture-Security-Design.md`.*

### 4.1 Defense in depth

**Defense in depth** is a security-engineering principle: instead of relying
on one strong wall, you build several *independent* barriers, so that a flaw
or breach in any single one still leaves the attacker facing the others. Here
are ADERA's eight layers, in the order a connection attempt or a malicious
message would actually hit them:

```mermaid
flowchart TB
    L1["Layer 1 — TCP / devp2p node permissioning<br/>Blocks: unauthorised nodes even joining the ledger's network"]
    L2["Layer 2 — Transaction-pool account permissioning<br/>Blocks: unknown keys submitting writes to the ledger"]
    L3["Layer 3 — IBFT 2.0 consensus, known validator set<br/>Blocks: unauthorised block production"]
    L4["Layer 4 — Smart-contract role checks (onlyMember / onlyAuditor)<br/>Blocks: ungoverned state changes, role misuse"]
    L5["Layer 5 — Identity binding (1 entity : 1 Party ID)<br/>Blocks: Party-ID spoofing or hijacking"]
    L6["Layer 6 — Application-layer signature check vs on-chain public key<br/>Blocks: impersonation over an actual OCPI conversation"]
    L7["Layer 7 — Transport encryption: mTLS + WireGuard<br/>Blocks: eavesdropping, man-in-the-middle, endpoint exposure"]
    L8["Layer 8 — Confidential discovery: AES-256-GCM endpointCipher<br/>Blocks: leaking the network's topology to non-members"]
    L1 --> L2 --> L3 --> L4 --> L5 --> L6 --> L7 --> L8
```

An attacker has to defeat **every** layer relevant to what they're trying to
do — not just one.

### 4.2 Layers 1–3: keeping unauthorized computers off the network at all

A node here means "a computer running the Besu ledger software." Layers 1–3
stop a stranger's computer from even participating in the network's
low-level conversations:

- **Layer 1 (node permissioning).** Ledger nodes find and talk to each other
  using a peer-to-peer networking protocol stack called **devp2p**, over the
  network transport **RLPx**. Each node has a unique network identity called
  an **enode** (essentially: its public key plus its IP address and port). A
  file (`permissions_config.toml`) contains the *authoritative allowlist* of
  enodes permitted to connect at all — an unlisted node's connection attempt
  is dropped during the initial handshake, before any real data is even
  exchanged. Ordinarily, peer-to-peer networks let nodes discover each other
  automatically via a **DHT** (Distributed Hash Table — think of it as a
  shared address book nodes build collaboratively); here that automatic
  discovery is turned off entirely (`discovery-enabled=false`), so there's
  no way for an unknown node to advertise itself into the network at all —
  connections only happen via the explicit allowlist.
- **Dynamic projection.** In production, that allowlist file isn't edited by
  hand. A small helper program (again, a "sidecar") on each operator's
  infrastructure watches the ledger's `PartyAdmitted` / `PartyRevoked` events
  and automatically rewrites the local allowlist to match — so a governance
  vote to admit or revoke someone *is* the same act as granting or removing
  their network access, with no separate manual step to fall out of sync.
- **Layer 2 (account permissioning).** Even a computer that *is* allowed to
  connect can't submit a ledger-writing transaction unless its cryptographic
  key is also on a separate allowlist. Only governance keys and the
  regulator's auditor key can originate any state change at all.
- **Layer 3 (consensus).** Covered in §3.2 — only the known validator set can
  actually produce blocks.

### 4.3 Layers 4–6: stopping identity theft and fake operators

Imagine an attacker — call her "Mallory" (a standard placeholder name in
security writing for an active attacker) — who wants to either register as an
operator she isn't, hijack an existing Party ID to steal that operator's
sessions/bills, or flood the registry with fake identities to gain outsized
voting power (called a **Sybil attack**, named after a case study about a
person with multiple personalities — in security, it means "one attacker
creating many fake identities to overwhelm a system that assumes one identity
= one real participant").

The smart contract enforces a strict **1:1 binding**: one legal entity's key
maps to exactly one Party ID, permanently, unless formally revoked.

```
mapping(bytes32 => Party)   parties;        // partyKey -> record (must be unique)
mapping(address => bytes32) entityToParty;  // entity   -> partyKey (must be unique)
```

(A **mapping** here is just a lookup table — like a dictionary or hash map in
any programming language: give it a key, get back the associated record.)
Two rules fall out of this:

- **No duplicate Party IDs.** Once `XX/CPO` is registered, a second attempt to
  register the same ID is simply rejected by the contract's own logic.
- **No unauthorized changes.** Rotating an operator's endpoint or public key
  is only allowed if the request is signed by *that exact operator's own
  entity key* (`msg.sender == party.entity` — `msg.sender` is blockchain
  terminology for "whichever key actually signed and submitted this
  transaction"). Mallory cannot redirect `XX/CPO`'s traffic to her own
  servers because she doesn't hold `XX/CPO`'s key, full stop.

As for Sybil attacks: there is no open self-signup. A new Party ID only enters
via the M-of-N governance vote from §3.3, and each of those governance
members is itself a **licensed legal entity** — that licensing is
established *off-chain*, by the regulator, through normal legal/business
vetting. So creating fake identities on-chain would first require creating
fake *licensed companies* and then convincing a majority of real competitors
to vote them in — which the whitepaper correctly frames as a legal/governance
barrier, not a technical one the software alone can solve.

### 4.4 Layer 6 in full: proving "I actually hold this key, right now"

The binding in §4.3 proves *which key is allowed to speak for* a Party ID.
Separately, every time two operators actually start talking, the receiving
side must confirm *the other end genuinely controls that key at this exact
moment* (not, say, replaying an old stolen message).

```mermaid
sequenceDiagram
    participant CPO as CPO Gateway (initiator)
    participant Reg as AderaRegistry (on-chain)
    participant EMSP as eMSP Gateway (receiver)

    CPO->>CPO: sign(credentials body) using own messaging private key
    CPO->>EMSP: POST /ocpi/2.2.1/credentials<br/>Authorization: Token TOKEN_A<br/>X-ADERA-Party: senderPartyKey<br/>X-ADERA-Signature: signature
    EMSP->>Reg: resolveEndpoint(senderPartyKey)
    Reg-->>EMSP: pubKey, active = true
    EMSP->>EMSP: ecrecover(body, signature) == addressFromPubKey(pubKey) ?
    alt signature checks out
        EMSP-->>CPO: 200 OK — credentials accepted
    else signature doesn't match, or party inactive
        EMSP-->>CPO: 401 Unauthorized — logged as a SECURITY rejection
    end
```

A few terms worth unpacking:

- **`ecrecover`** is a standard cryptographic operation (originally from
  Ethereum) that takes a message and a digital signature and mathematically
  *recovers* the public key/address that must have produced that signature —
  without the signer ever having to reveal their private key. It's the
  verification half of the sign/verify pair described in §1.4.
- **EIP-191** is simply a standardized, specific *format* for what exactly
  gets signed (so that a signature produced for one purpose can't accidentally
  be replayed as valid for a different purpose) — an "Ethereum Improvement
  Proposal," essentially a numbered, agreed-upon convention.
- **`TOKEN_A`** is a detail carried over from plain OCPI: normally OCPI's
  *only* protection is a shared secret token — if that token ever leaks
  (e.g., in a log file, or over an insecure channel), anyone who has it can
  impersonate that operator completely. ADERA doesn't remove the token (for
  compatibility) but makes it insufficient on its own: even with a stolen
  token, an attacker still can't produce a valid signature without also
  possessing the private key — and *that* key's authority traces directly
  back to the on-chain binding from §4.3.

### 4.5 Layers 7–8: protecting the actual conversation and hiding the map

- **Layer 8 — confidential discovery.** As covered in §1.5: `resolveEndpoint()`
  never returns a plain-text address, only the AES-256-GCM-encrypted
  `endpointCipher`. Only members holding the shared consortium decryption key
  can turn it back into a usable address.
- **Dynamic routing.** A gateway keeps **no static list of who to talk to** —
  every single time it needs to reach a peer, it re-reads the ledger live:
  computes the peer's Party ID, calls `resolveEndpoint`, checks `active`
  (instantly refusing to talk to a peer the instant it's been revoked — no
  stale cached address to exploit), decrypts the address, and only then runs
  the signed handshake from §4.4. The practical benefit: a governance
  decision (like a revocation) takes effect network-wide immediately, with no
  need to redeploy or manually reconfigure any operator's software.
- **Layer 7 — transport encryption.** Two independent protections wrap the
  actual data connection between two operators' gateways:
  - **WireGuard** — a modern VPN (Virtual Private Network) protocol. It builds
    a private, authenticated tunnel between the two gateways so their traffic
    never crosses the open internet in a form anyone else could read, and
    neither gateway's raw address needs to be exposed to the public internet.
  - **mTLS (mutual TLS)** — ordinary HTTPS (**TLS**) only proves the *server's*
    identity to the client (the padlock in your browser). **Mutual** TLS
    additionally has the client present its own certificate, so *both* sides
    prove who they are before any data flows. Here, the certificate's
    underlying key is the *same* messaging identity that's bound on the
    ledger — so passing the mTLS check and passing the on-chain identity
    check are, by construction, the same fact, closing the gap a
    man-in-the-middle attacker would otherwise try to exploit.

> The reference implementation currently runs this channel over plain HTTP on
> an isolated internal Docker network, specifically so it can be run and
> demonstrated with zero certificate setup. The signature check (§4.4) and
> the encrypted endpoint (§4.5) are fully implemented already; WireGuard/mTLS
> are documented as how this same channel gets wrapped for a real production
> deployment — the identity/signing groundwork is already there, so enabling
> it is a deployment configuration step, not new code.

---

## 5. What happens when the power or the internet drops

Real-world grid instability and intermittent connectivity are common in many
markets, so this is treated as a first-class design concern, not an edge
case.

### 5.1 A ledger node loses power and restarts

Because IBFT 2.0 gives **immediate finality** (§3.2), there's no "in-progress,
not-yet-final" state that could be corrupted by a crash. Each validator saves
its copy of the ledger to persistent storage continuously, so after a restart
it simply reloads, reconnects to its allowed peers, and picks up exactly
where it left off — nothing is rewritten or lost. And because consensus only
needs a **quorum** (a large-enough majority), not literally every single
validator, the loss of any one site doesn't halt the whole network — the
whitepaper specifies a minimum of four validators in production for exactly
this reason (a small two-validator test setup has zero fault tolerance by
design, since losing either one leaves no majority).

### 5.2 The internet drops for a while

An already-established, already-verified connection between two operators can
keep going — the ledger only needs to be re-consulted to *start* a brand-new
relationship, or to notice a revocation. So a temporary dropout delays
*discovering new peers*, but doesn't interrupt an *existing* charging session
already in progress. Each gateway also talks to its **own**, co-located
ledger node over a local/internal network rather than the public internet, so
gateway-to-ledger reads keep working even during a wider internet outage, as
long as that local node itself is up.

### 5.3 No CDR (bill) is ever silently lost

A CDR is the record of what a driver owes for a specific charging session —
losing one means an operator simply doesn't get paid for a real session that
happened. So every gateway keeps a **durable, order-preserving offline
queue** — "durable" meaning it's saved to disk, not just kept in memory, so a
crash doesn't wipe it out; "order-preserving" meaning items are processed in
the order they arrived, never reshuffled.

```mermaid
flowchart LR
    CDR["New CDR produced"] --> ENQ["enqueue():<br/>append to disk-backed queue"]
    ENQ --> TRY{"attempt handler(item)<br/>e.g. settle via payment plugin"}
    TRY -- "success" --> DEQ["dequeue + persist<br/>(only now is it removed)"]
    TRY -- "failure (offline, rail down, etc.)" --> HOLD["stop here — item stays at<br/>the head of the queue"]
    HOLD -. "connectivity/rail returns, retry" .-> TRY
    DEQ --> NEXT["move on to the next item"]
```

A couple of standard reliability terms worth defining here:

- **At-least-once delivery** means the system guarantees a message will be
  delivered *eventually*, possibly by retrying — which also means a receiver
  might, in principle, see the same message more than once if a retry happens
  right after a success that wasn't acknowledged in time.
- **Idempotency** is the fix for that: each CDR carries a stable, unique
  `cdr_id`, so if the bank connector ever receives what's technically a
  duplicate retry, it can recognize it and avoid charging twice — turning
  "at-least-once delivery" into "effectively-once settlement" from the
  driver's and operator's point of view.
- **Backpressure** describes what happens when a downstream system (here, a
  bank) can't keep up with the rate work arrives. Because settlement runs
  through the decoupled webhook pattern from §2.4, a backlog piling up in this
  queue never "backs up" into and stalls the actual charging/roaming system —
  the two are isolated from each other by design.

---

## 6. Putting it all together: one full charging session, start to finish

This composite walkthrough traces a single real-world event — a driver who is
a customer of eMSP "X" charges at a station belonging to a different company,
CPO "B," whom eMSP X has never dealt with before — through every layer
covered above.

```mermaid
sequenceDiagram
    participant Driver
    participant Charger as CPO-B's charging station
    participant CPOGW as CPO-B Gateway
    participant Ledger as ADERA Ledger (shared, both sides read it)
    participant EMSPGW as eMSP-X Gateway
    participant Bank as CPO-B's Bank / national-rail connector

    Note over CPOGW,Ledger: First contact ever between CPO-B and eMSP-X
    CPOGW->>Ledger: resolveEndpoint(eMSP-X's Party ID)
    Ledger-->>CPOGW: encrypted endpoint + public key (active = true)
    CPOGW->>CPOGW: decrypt endpoint with consortium key
    CPOGW->>EMSPGW: signed OCPI credentials handshake (§4.4)
    EMSPGW->>Ledger: resolveEndpoint(CPO-B's Party ID) — verifies the signature back
    EMSPGW-->>CPOGW: 200 OK — roaming relationship established
    CPOGW->>CPOGW: payment plugin: openSettlementChannel(...) (§2.3)

    Note over Driver,Charger: Driver plugs in and authenticates via the eMSP-X app
    Driver->>Charger: start charging (authenticated via eMSP-X token)
    Charger->>CPOGW: session data
    CPOGW->>EMSPGW: OCPI session updates (direct, encrypted, off-chain — NOT via the ledger)
    Note over Driver,Charger: ... charging happens, driver unplugs ...
    Charger->>CPOGW: session ends
    CPOGW->>EMSPGW: final CDR (the bill for this session), off-chain
    CPOGW->>CPOGW: payment plugin: settleCdr(channelId, cdr)
    CPOGW-)Bank: fire-and-forget settlement webhook (§2.4)
    Bank--)CPOGW: settlementRef (whenever the bank actually posts it)
    Note over CPOGW,Bank: If the bank is slow/offline, the CDR sits safely<br/>in the durable offline queue (§5.3) — driver's<br/>charging experience was never blocked by this.
```

Notice what the ledger was actually used for in this entire story: **exactly
two read operations**, both purely to look up an address and a public key.
Everything else — the actual charging, the bill, the payment — happened
directly between the two companies and their own bank, off-chain, exactly as
the whitepaper's core thesis in §1 describes.

### 6.1 What protocol handles each step — and where a CPO could still cheat

It's tempting to think tariff transparency closes the loop entirely: the
eMSP receives the CPO's published rates over OCPI, shows them to the driver,
the driver approves, and everything downstream settles against a bill
computed at that already-agreed rate. That reasoning is half right — it
closes exactly one gap, **price manipulation**. A CPO can't quietly charge a
different rate than what it published, because the rate was exchanged in
advance over a channel cryptographically tied to its identity (§4.4): if a
final CDR's price-per-unit doesn't match the tariff the same CPO published
earlier, that mismatch is provable and non-repudiable.

What it does **not** close is **quantity manipulation** — how much energy was
actually delivered, and for how long. That number never comes from OCPI, the
ledger, or any cryptography. It comes from the CPO's own backend, reading its
own meter, after the session ends, with nothing downstream independently
observing the physical event. A dishonest CPO can apply the correct,
publicly-published rate to an inflated kWh or duration figure, and every
check described in this document — the signature, the identity binding, the
tariff match — passes cleanly, because none of them were ever designed to
verify *quantity*, only *identity* and *published price*.

```mermaid
sequenceDiagram
    participant Driver
    participant EMSPApp as eMSP App<br/>(proprietary — not a shared protocol)
    participant EMSPGW as eMSP Gateway
    participant Ledger as ADERA Ledger
    participant CPOGW as CPO Gateway
    participant Charger as Charger hardware
    participant Rail as Bank / National Rail

    rect rgb(232,240,255)
    Note over CPOGW,Ledger: ADERA — identity & discovery ONLY
    CPOGW->>Ledger: resolveEndpoint(eMSP's Party ID)
    Ledger-->>CPOGW: encrypted endpoint + public key
    end

    rect rgb(230,247,230)
    Note over CPOGW,EMSPGW: OCPI — roaming data exchange
    CPOGW->>EMSPGW: signed Credentials handshake (§4.4)
    CPOGW->>EMSPGW: Tariffs (published price per kWh / per minute)
    CPOGW->>EMSPGW: Locations (stations, connectors, live status)
    EMSPGW->>CPOGW: Tokens (which of eMSP's drivers are valid)
    end

    Note over Driver,EMSPApp: eMSP's own app — proprietary, not a shared protocol
    Driver->>EMSPApp: browses map, sees the advertised tariff, picks a station
    EMSPApp-->>Driver: shows an estimated price, driver approves

    rect rgb(255,243,224)
    Note over Charger,CPOGW: OCPP — charger hardware to CPO backend
    Driver->>Charger: plugs in, presents token
    Charger->>CPOGW: Authorize(token)
    CPOGW->>EMSPGW: token recognized as valid (already synced via OCPI Tokens)
    CPOGW-->>Charger: authorized, start session
    Charger->>Charger: physical meter increments (kWh, elapsed time)
    Charger->>CPOGW: MeterValues, then StopTransaction (session ends)
    end

    rect rgb(255,225,225)
    Note over CPOGW: TRUST BOUNDARY — the CPO's own backend computes the CDR<br/>from ITS OWN meter reading + ITS OWN tariff table.<br/>No protocol here independently verifies the reported quantity.
    CPOGW->>CPOGW: CDR = published tariff × self-reported usage
    end

    rect rgb(230,247,230)
    Note over CPOGW,EMSPGW: OCPI — CDR (authentic and non-repudiable, NOT independently verified)
    CPOGW->>EMSPGW: signed CDR (kWh, duration, total cost)
    end

    rect rgb(232,240,255)
    Note over EMSPGW,Rail: Payment plugin + national rail — wholesale settlement (§2)
    EMSPGW->>EMSPGW: settleCdr(channelId, cdr)
    EMSPGW->>Rail: signed settlement instruction
    Rail-->>CPOGW: funds + settlementRef
    end

    Note over EMSPApp,Driver: eMSP's own app — proprietary, not a shared protocol
    EMSPApp->>Driver: charges driver's card/wallet, per the CDR it received
```

**So, can a CPO actually cheat?** Not on *price* — that's pinned down by the
cryptographically-signed tariff exchange and would be a provable, immediate
breach. But yes, on *quantity* — a CPO's backend could report more energy or
time than a session actually used, at the correct rate, and nothing in OCPI,
ADERA, or the payment layer would catch it, because none of them ever
observe the physical charging event directly. This isn't a gap specific to
ADERA's design — **no roaming protocol, blockchain-based or not, solves
this**, because it's fundamentally a metering-integrity problem (is the
charger's own meter honest and tamper-evident?), which is a legal-metrology
and hardware-certification question, not a software or cryptography one. The
practical mitigations are outside this stack entirely: certified,
tamper-evident meters, physical/regulatory audits of charging hardware, and
the commercial/legal consequence of a licensed operator getting caught —
backed by the fact that a fabricated CDR is, thanks to §4.4's signing, an
unambiguous, non-repudiable piece of evidence against the CPO if it ever gets
disputed.

---

## 7. What's actually implemented vs. described

Everything above describes the *design* — what the whitepaper and
architecture doc specify. It's worth being precise about which parts of that
design actually exist as working code in this repo, and which are described
as the production target but aren't built yet. Verified directly against the
source, not assumed from the docs.

**Matches closely, verified line-by-line:**

- `contracts/AderaRegistry.sol` mirrors the whitepaper almost exactly — the
  `Role` enum, the 1:1 `entityToParty` binding, the propose/confirm/execute
  multisig flow, the auditor's `auditProbe`-only power, every event name.
- The signed handshake (`gateway/lib/crypto.js` + `ocpi.js` + the
  `/credentials` route in `gateway.js`) implements §4.4 precisely: EIP-191
  signing, the recovered signer checked against the on-chain `pubKey`, a 401
  and a `SECURITY`-tagged log line on mismatch — same header names
  (`X-ADERA-Party`, `X-ADERA-Signature`) the docs describe.
- The encrypted endpoint (`iv‖tag‖ciphertext` AES-256-GCM) matches
  §1.5/§4.5 exactly.
- Dynamic routing (`registry.js`: no static peer table, live `resolveEndpoint`
  on every handshake) matches §4.5/§5.2.
- The offline queue (`offlineQueue.js`: disk-persisted FIFO, halts at the
  failed item) matches §5.3 exactly.
- `contracts/deployer/deploy.js` is the script that produces the exact
  governance lifecycle in §3.5 — genesis founders, third-party admission by
  multisig, a `ComplianceProbe` attestation.
- `network/permissions_config.toml` implements the two-tier node/account
  allowlist from §4.2 correctly.

**Honestly disclosed gaps** (the README's own "Notes & caveats" section flags
these): plain HTTP instead of mTLS/WireGuard, throwaway `.env` test keys
instead of real HSMs, 2 validators with zero fault tolerance, and payment
rails that log/webhook a mock event rather than touching a real bank. The
code matches that admission — no surprises.

**Gaps that aren't flagged anywhere:**

1. **The node-permissioning sidecar doesn't exist.** Both docs (and the TOML
   file's own comments) describe production allowlist projection as
   automatic — a sidecar watching `PartyAdmitted`/`PartyRevoked` and
   rewriting the allowlist live (§4.2). There is no such service in this
   repo. The allowlist is a static, hand-written file for the two genesis
   validators only.
2. **The regulator doesn't run anything.** §3.4 and the whitepaper both
   describe the regulator running "its own observer node (or a light
   indexer)." There's no such service in `docker-compose.yml` — the
   regulator's auditor action is one transaction fired by the deployer
   script using the auditor's private key, not a standing observer process.

**Smaller mismatches:**

- The `null` payment plugin is documented as "no automation" but the code
  (`payments.js`) gives it the identical webhook/logging behavior as the
  real rail plugins — just a different `railName` label, not an actual no-op.
- The CDR-quantity trust gap from §6.1 is visible directly in the code, not
  just theoretical: `gateway.js` hardcodes a mock CDR
  (`total_energy_kwh: 23.4, total_cost: 1638.0`) and `settleCdr` never
  validates against tariff data.
- The repo only implements a thin slice of OCPI itself — `versions`,
  `version-detail`, `credentials`, and a stub `/cdrs` receiver that just logs
  and returns `{accepted:true}`. Locations, Tariffs, Tokens, Sessions, and
  Commands aren't implemented anywhere. That's consistent with the repo's
  stated purpose — a proof-of-concept of ADERA's identity/ledger/settlement
  layer, not a full OCPI server — but worth being precise about if you're
  evaluating how much of a real deployment already exists versus still needs
  to be built.

---

## 8. Quick-reference glossary

| Term | Plain-English meaning |
| --- | --- |
| AES-256-GCM | A fast, standard symmetric (same-key) encryption method; used here to hide network endpoints from non-members. |
| CDR (Charge Detail Record) | The bill/record for one completed charging session. |
| Consensus | The process by which independent parties running their own copies of a shared ledger agree on its contents. |
| CPO (Charge Point Operator) | A company that owns/operates physical EV chargers. |
| Digital signature | Cryptographic proof that a specific private key produced or approved a message, checkable by anyone with the matching public key. |
| eMSP (e-Mobility Service Provider) | A company that sells charging access to drivers across multiple CPOs' networks and bills them, without necessarily owning any chargers. |
| Enode | A node's unique network identity (public key + IP + port) on a devp2p/RLPx peer-to-peer network. |
| EVM (Ethereum Virtual Machine) | The standardized runtime that executes smart contracts on Ethereum-family ledgers. |
| Finality | The point at which a recorded transaction/block is permanent and can never be undone or reorganized. |
| HSM (Hardware Security Module) | Tamper-resistant hardware built specifically to store cryptographic keys so they can never be extracted. |
| IBFT 2.0 | The proof-of-authority consensus algorithm ADERA uses: a known validator set, immediate finality, no mining. |
| Idempotency | A system design property where repeating the same operation twice has the same effect as doing it once — prevents double-charging on retries. |
| Ledger | A shared, jointly-maintained, tamper-evident record book — here, used only for identity/discovery, never for OCPI traffic or money. |
| mTLS (mutual TLS) | Encrypted HTTPS-style connection where *both* sides (not just the server) prove their identity with a certificate. |
| Multisig | A rule requiring M-of-N approvals from a defined group before an action (e.g., admitting a new operator) takes effect. |
| OCPI (Open Charge Point Interface) | The open protocol defining how a CPO's and an eMSP's systems exchange roaming messages (sessions, tariffs, CDRs). |
| OCPP (Open Charge Point Protocol) | A *different* protocol, between a charger and its own CPO's back-end — not the subject of this whitepaper. |
| Off-chain | Happening directly between parties, never recorded on the shared ledger. |
| On-chain | Recorded on the shared ledger itself. |
| Permissioned (ledger/network) | Membership is a closed, vetted list, unlike public blockchains anyone can join. |
| Private key / public key | A mathematically linked pair: the private half proves identity by signing (never shared); the public half lets anyone verify that signature (shared freely). |
| Proof-of-authority | A consensus model where a known, vetted set of validators (not anonymous miners) produce blocks. |
| Quorum | The minimum number/proportion of validators that must agree for consensus to proceed. |
| Regulator (auditor role) | Whichever national authority licenses and oversees charging operators; holds a dedicated, read-only auditor key on the ledger. |
| Roaming | Letting a customer of one operator use a different operator's infrastructure — borrowed from the mobile-network industry. |
| Sidecar | A small helper process running alongside a main system to handle one specific external integration (e.g., a bank connection). |
| Smart contract | Code stored on a ledger whose rules are automatically enforced by every node, rather than by any single party's discretion. |
| Sybil attack | An attacker creating many fake identities to gain disproportionate influence over a system that assumes one identity = one real participant. |
| Symmetric vs. asymmetric encryption | Symmetric: one shared secret key both locks and unlocks data. Asymmetric: two different, mathematically linked keys — one public, one private. |
| Webhook | An HTTP callback: instead of repeatedly polling for a status, the other side proactively sends a message the moment something happens. |
| WireGuard | A modern VPN protocol used here to build a private, authenticated tunnel between two operators' gateways. |
| Zero-trust | Nobody is trusted merely by being listed somewhere or by claiming an identity — every connection is independently, cryptographically re-verified. |

---

*This document introduces no new claims, numbers, or design decisions beyond
what's in `01-ADERA-Whitepaper-PUCSL-Governance.md` and
`02-System-Architecture-Security-Design.md`. Where anything here appears to
contradict those two documents, the whitepaper and architecture doc are the
authoritative source.*
