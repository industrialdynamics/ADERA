'use strict';

/**
 * ADERA Operator Gateway — multi-tenant
 * =======================================
 * Serves a TABLE of Party identities from one process, rather than being
 * hardwired to a single one. Each tenant is a distinct on-chain Party (its
 * own Party ID, its own entity binding, its own messaging key), reachable at
 * its own path (`/party/<country>/<partyId>/...`), so one running gateway
 * can front many CPOs/eMSPs the way an eMSP hosting infrastructure for
 * several fronted CPOs would (see docs/00, §1.8).
 *
 * For each tenant this gateway:
 *   1. Serves an OCPI 2.2.1 receiver (versions + credentials modules) at
 *      that tenant's own path.
 *   2. Authenticates every inbound handshake against the sender's ON-CHAIN
 *      public key (identity-hijack / Sybil defense at the application layer).
 *   3. If configured with peers to initiate toward, DISCOVERS each peer
 *      purely from the ledger, decrypts its endpoint, and runs a signed OCPI
 *      credentials handshake AS that tenant.
 *   4. Opens a settlement channel through the pluggable payment layer and
 *      settles a mock CDR, with a per-tenant durable offline queue for
 *      disconnected states.
 *
 * The same image runs for every gateway process; which identities it hosts,
 * and which peers each of them initiates toward, is entirely env-driven.
 */

const express = require('express');
const crypto = require('crypto');

const { RegistryClient, loadManifest } = require('./lib/registry');
const {
  OCPI_VERSION,
  envelope,
  errorEnvelope,
  buildVersionsPayload,
  buildVersionDetailPayload,
  buildCredentialsObject,
  initiateHandshake,
} = require('./lib/ocpi');
const {
  decryptEndpoint,
  recoverSigner,
  addressFromStoredPubKey,
  handshakeSigningPayload,
} = require('./lib/crypto');
const { createPaymentPlugin } = require('./lib/payments');
const { OfflineQueue } = require('./lib/offlineQueue');
const { ReplayGuard } = require('./lib/replayGuard');

/** On-chain Role enum -> OCPI role name, for checking payload claims. */
const ROLE_NAMES = { 1: 'CPO', 2: 'EMSP', 3: 'HUB' };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Reads TENANT_COUNT and, for each index 1..N, TENANT_<i>_* env vars into a
 * tenant record. A tenant with no PEER_ID configured hosts no outbound
 * relationships (passive receiver only) — the common case for a CPO-only
 * party (§1.7 of docs/00).
 */
function loadTenants() {
  const count = parseInt(process.env.TENANT_COUNT || '0', 10);
  const tenants = [];
  for (let i = 1; i <= count; i++) {
    const get = (name) => process.env[`TENANT_${i}_${name}`];
    const partyId = get('PARTY_ID');
    const messagingKey = get('MESSAGING_KEY');
    if (!partyId) throw new Error(`TENANT_${i}_PARTY_ID is required`);
    if (!messagingKey) throw new Error(`TENANT_${i}_MESSAGING_KEY is required`);

    const partyCountry = get('PARTY_COUNTRY') || 'LK';
    const peerId = get('PEER_ID') || null;
    const peers = peerId
      ? [
          {
            peerCountry: get('PEER_COUNTRY') || partyCountry,
            peerId,
            initiate: (get('INITIATE') || 'false').toLowerCase() === 'true',
          },
        ]
      : [];

    tenants.push({
      role: (get('ROLE') || 'CPO').toUpperCase(),
      partyCountry,
      partyId,
      businessName: get('BUSINESS_NAME') || 'ADERA Operator',
      messagingKey,
      peers,
    });
  }
  return tenants;
}

const CFG = {
  tenants: loadTenants(),
  rpcUrl: process.env.RPC_URL || 'http://adera-validator-cpo:8545',
  sharedDir: process.env.SHARED_DIR || '/shared',
  dataDir: process.env.DATA_DIR || '/data',
  ocpiPort: parseInt(process.env.OCPI_PORT || '9101', 10),
  publicBase: process.env.PUBLIC_OCPI_BASE || 'http://adera-gateway-cpo:9101',

  consortiumKey: process.env.ADERA_CONSORTIUM_KEY ||
    '0x8d0c9b3a7f1e4d2c5b6a09182736455463728190a1b2c3d4e5f60718293a4b5c',
  regToken: process.env.REG_TOKEN || 'ADERA-REG-TOKEN-A',

  paymentPlugin: process.env.PAYMENT_PLUGIN || 'mandate',
  paymentWebhookUrl: process.env.PAYMENT_WEBHOOK_URL || null,
};

if (CFG.tenants.length === 0) {
  throw new Error(
    'no tenants configured: set TENANT_COUNT and TENANT_1_ROLE / TENANT_1_PARTY_ID / ' +
      'TENANT_1_MESSAGING_KEY (etc.) env vars — see docker-compose.yml for examples'
  );
}

const PROCESS_TAG = CFG.tenants.map((t) => `${t.partyCountry}/${t.partyId}`).join('+');
const log = (tenantTag, section, msg) =>
  console.log(`[gateway:${tenantTag}] ${String(section).padEnd(10)} | ${msg}`);
const plog = (section, msg) => log(PROCESS_TAG, section, msg); // process-level (shared) log line
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// tenantKey ("country/partyId") -> tenant record, for O(1) inbound routing.
const tenantsByKey = new Map();
for (const t of CFG.tenants) tenantsByKey.set(`${t.partyCountry}/${t.partyId}`, t);

function tenantTag(t) {
  return `${t.partyCountry}/${t.partyId}`;
}

function tenantBaseUrl(t) {
  return `${CFG.publicBase}/party/${t.partyCountry}/${t.partyId}`;
}

// In-memory peer credential store, namespaced per (local tenant -> remote party).
const peerCredentials = new Map();

// ---------------------------------------------------------------------------
// OCPI receiver server — every OCPI route is scoped to /party/:country/:partyId
// ---------------------------------------------------------------------------
function buildServer(registry, payment, replayGuard) {
  const app = express();
  // Capture the raw body so we can verify the handshake signature over the
  // exact bytes the sender signed.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    })
  );

  /** Resolve :country/:partyId to a hosted tenant, or 404 if this gateway doesn't serve it. */
  function resolveTenant(req, res) {
    const key = `${req.params.country}/${req.params.partyId}`;
    const t = tenantsByKey.get(key);
    if (!t) {
      plog('routing', `404: this gateway does not host party ${key}`);
      res.status(404).json(errorEnvelope(2003, `this gateway does not host party ${key}`));
      return null;
    }
    return t;
  }

  // Aggregate health check — lists every identity this one process serves.
  app.get('/health', (_req, res) =>
    res.json({
      status: 'ok',
      tenants: CFG.tenants.map((t) => ({ party: tenantTag(t), role: t.role })),
    })
  );

  // OCPI versions module.
  app.get('/party/:country/:partyId/ocpi/versions', (req, res) => {
    const t = resolveTenant(req, res);
    if (!t) return;
    res.json(buildVersionsPayload(tenantBaseUrl(t)));
  });

  // OCPI version detail module.
  app.get(`/party/:country/:partyId/ocpi/${OCPI_VERSION}`, (req, res) => {
    const t = resolveTenant(req, res);
    if (!t) return;
    res.json(buildVersionDetailPayload(tenantBaseUrl(t)));
  });

  // OCPI credentials module (receiver side of the handshake) — signed against
  // whichever tenant the request's path names.
  app.post(`/party/:country/:partyId/ocpi/${OCPI_VERSION}/credentials`, async (req, res) => {
    const t = resolveTenant(req, res);
    if (!t) return;
    const tag = tenantTag(t);
    try {
      const senderPartyKey = req.header('X-ADERA-Party');
      const signature = req.header('X-ADERA-Signature');
      const timestamp = req.header('X-ADERA-Timestamp');
      const nonce = req.header('X-ADERA-Nonce');
      const authz = req.header('Authorization') || '';

      if (!authz.startsWith('Token ')) {
        return res.status(401).json(errorEnvelope(2001, 'missing OCPI Token authorization'));
      }
      if (!senderPartyKey || !signature || !timestamp || !nonce) {
        return res.status(401).json(errorEnvelope(2001, 'missing ADERA identity headers'));
      }

      // 1. Reject stale or already-seen handshakes BEFORE doing any chain reads,
      //    so replayed bytes cost us nothing.
      const fresh = replayGuard.check({ timestamp, nonce });
      if (!fresh.ok) {
        log(tag, 'SECURITY', `REJECTED handshake from ${senderPartyKey.slice(0, 10)}...: ${fresh.reason}`);
        return res.status(401).json(errorEnvelope(2001, `handshake rejected: ${fresh.reason}`));
      }

      // 2. Resolve the sender on-chain and require they are an ACTIVE party.
      let onchain;
      try {
        onchain = await registry.resolveEndpoint(senderPartyKey);
      } catch (_) {
        return res.status(403).json(errorEnvelope(2001, 'sender party not found in ADERA registry'));
      }
      if (!onchain.active) {
        return res.status(403).json(errorEnvelope(2001, 'sender party is not active'));
      }

      // 3. Verify the signature binds to the sender's ON-CHAIN public key. The
      //    signature covers the timestamp and nonce as well as the body, so the
      //    freshness checked in step 1 is itself signed and cannot be forged.
      const recovered = recoverSigner(
        handshakeSigningPayload({ timestamp, nonce, body: req.rawBody }),
        signature
      );
      const expected = addressFromStoredPubKey(onchain.pubKey);
      if (recovered.toLowerCase() !== expected.toLowerCase()) {
        log(tag, 'SECURITY', `REJECTED handshake: signer ${recovered} != on-chain ${expected} for ${senderPartyKey.slice(0, 10)}...`);
        return res.status(401).json(errorEnvelope(2001, 'signature does not match on-chain party public key'));
      }

      const senderCreds = req.body;

      // 4. Bind the PAYLOAD's declared identity to the on-chain identity that
      //    just proved key control. Step 3 proves "you hold LK/CPO's key"; it
      //    says nothing about who the body claims to be. Without this check an
      //    admitted party could sign correctly as itself while declaring some
      //    other party in `roles[]` — and it is the body, not the party key,
      //    that names the counterparty in the settlement channel opened below.
      const claimed = senderCreds?.roles?.[0];
      if (!claimed?.country_code || !claimed?.party_id) {
        return res.status(400).json(errorEnvelope(2001, 'credentials payload declares no OCPI role'));
      }

      const claimedKey = await registry.partyKey(claimed.country_code, claimed.party_id);
      if (claimedKey.toLowerCase() !== senderPartyKey.toLowerCase()) {
        log(tag, 'SECURITY', `REJECTED handshake: payload claims ${claimed.country_code}/${claimed.party_id} but the signing party is ${senderPartyKey.slice(0, 10)}...`);
        return res.status(403).json(errorEnvelope(2001, 'credentials payload identity does not match the signing party'));
      }

      // The declared role must match the ledger too — a CPO cannot present
      // itself as an eMSP to attract the wrong side of a settlement.
      const onchainRole = ROLE_NAMES[onchain.role];
      if (onchainRole && String(claimed.role).toUpperCase() !== onchainRole) {
        log(tag, 'SECURITY', `REJECTED handshake: ${claimed.country_code}/${claimed.party_id} claims role ${claimed.role} but is ${onchainRole} on-chain`);
        return res.status(403).json(errorEnvelope(2001, 'credentials payload role does not match on-chain role'));
      }

      // 5. Accept: store peer credentials, mint our TOKEN_C, respond AS this tenant.
      const senderTag = `${claimed.country_code}/${claimed.party_id}`;
      peerCredentials.set(`${tag}<-${senderPartyKey}`, senderCreds);
      log(tag, 'handshake', `INBOUND verified from ${senderTag} (${senderPartyKey.slice(0, 10)}...) signer=${recovered}`);

      const tokenC = 'TOKEN_C_' + crypto.randomBytes(16).toString('hex');
      const myCreds = buildCredentialsObject({
        token: tokenC,
        baseUrl: tenantBaseUrl(t),
        role: t.role,
        partyId: t.partyId,
        countryCode: t.partyCountry,
        businessName: t.businessName,
      });

      // Receiver also establishes its settlement channel toward the sender.
      // Both identifiers below are the ledger-verified ones from step 4 — money
      // is never attributed to a counterparty the payload merely asserted.
      await payment.openSettlementChannel({
        localParty: tag,
        remoteParty: senderTag,
        remoteRole: onchainRole || 'PEER',
      });

      return res.json(envelope(myCreds));
    } catch (e) {
      log(tag, 'error', `credentials endpoint failure: ${e.message}`);
      return res.status(500).json(errorEnvelope(3000, 'internal handshake error'));
    }
  });

  // Mock payment webhook receiver (stands in for the local bank/national-rail
  // connector sidecar). Shared across all tenants on this process — it's a
  // generic inbound sink, not part of any single Party's OCPI identity.
  app.post('/webhooks/payments', (req, res) => {
    plog('webhook-in', `settlement event received: ${JSON.stringify(req.body)}`);
    res.json({ received: true });
  });

  // Minimal CDR intake (receiver). Queues then settles.
  app.post(`/party/:country/:partyId/ocpi/${OCPI_VERSION}/cdrs`, async (req, res) => {
    const t = resolveTenant(req, res);
    if (!t) return;
    log(tenantTag(t), 'cdr-in', `received CDR ${req.body?.cdr_id}`);
    res.status(200).json(envelope({ accepted: true }));
  });

  return app;
}

// ---------------------------------------------------------------------------
// Initiator flow: one tenant discovers + hand-shakes + settles with one peer
// ---------------------------------------------------------------------------
async function runInitiatorFor(tenant, peer, registry, payment, queue) {
  const tag = tenantTag(tenant);
  const selfKey = await registry.partyKey(tenant.partyCountry, tenant.partyId);
  const peerKey = await registry.partyKey(peer.peerCountry, peer.peerId);
  log(tag, 'discover', `self=${tag} (${selfKey.slice(0, 10)}...) peer=${peer.peerCountry}/${peer.peerId} (${peerKey.slice(0, 10)}...)`);

  // On-chain discovery of the peer.
  const peerRecord = await registry.resolveEndpoint(peerKey);
  log(tag, 'discover', `on-chain peer: role=${peerRecord.role} active=${peerRecord.active} pubKey=${peerRecord.pubKey.slice(0, 14)}...`);
  if (!peerRecord.active) throw new Error('peer is not an active ADERA party');

  // Decrypt the confidential endpoint with the consortium data-plane key.
  const peerVersionsUrl = decryptEndpoint(peerRecord.endpointCipher, CFG.consortiumKey);
  log(tag, 'discover', `decrypted peer OCPI endpoint: ${peerVersionsUrl}`);

  // Run the signed OCPI credentials handshake, AS this tenant.
  const localCredentials = buildCredentialsObject({
    token: CFG.regToken,
    baseUrl: tenantBaseUrl(tenant),
    role: tenant.role,
    partyId: tenant.partyId,
    countryCode: tenant.partyCountry,
    businessName: tenant.businessName,
  });

  const peerCreds = await initiateHandshake({
    peerVersionsUrl,
    regToken: CFG.regToken,
    localCredentials,
    localPartyKey: selfKey,
    messagingKey: tenant.messagingKey,
    logger: (m) => log(tag, 'handshake', m),
  });

  log(tag, 'handshake', `OUTBOUND verified: peer returned ${peerCreds.roles?.[0]?.country_code}/${peerCreds.roles?.[0]?.party_id} token=${String(peerCreds.token).slice(0, 16)}...`);
  peerCredentials.set(`${tag}->${peerKey}`, peerCreds);

  // Open settlement channel through the pluggable payment layer.
  const channel = await payment.openSettlementChannel({
    localParty: tag,
    remoteParty: `${peer.peerCountry}/${peer.peerId}`,
    remoteRole: peerRecord.role === 1 ? 'CPO' : peerRecord.role === 2 ? 'EMSP' : 'PEER',
  });
  log(tag, 'settle', `settlement channel open: ${channel.channelId} via ${channel.rail}`);

  // Produce a mock roaming CDR, enqueue durably, then flush (settle).
  const cdr = {
    cdr_id: 'CDR_' + crypto.randomBytes(6).toString('hex'),
    country_code: tenant.partyCountry,
    party_id: tenant.partyId,
    counterparty: `${peer.peerCountry}/${peer.peerId}`,
    total_energy_kwh: 23.4,
    total_cost: 1638.0,
    session_start: new Date(Date.now() - 45 * 60000).toISOString(),
    session_end: new Date().toISOString(),
  };
  queue.enqueue(cdr);
  await queue.flush(async (item) => {
    const result = await payment.settleCdr({ channelId: channel.channelId, cdr: item });
    log(tag, 'settle', `CDR ${item.cdr_id} settled: ${result.settlementRef} (${result.status})`);
  });

  log(tag, 'done', `roaming session established end-to-end (discovery -> handshake -> settlement) with ${peer.peerCountry}/${peer.peerId}.`);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  plog('boot', `tenants=${CFG.tenants.length} rpc=${CFG.rpcUrl} ocpiPort=${CFG.ocpiPort}`);
  for (const t of CFG.tenants) {
    const peerDesc = t.peers.map((p) => `${p.peerCountry}/${p.peerId}${p.initiate ? ' (initiate)' : ' (passive)'}`).join(', ') || 'none';
    log(tenantTag(t), 'boot', `role=${t.role} businessName="${t.businessName}" peers=[${peerDesc}]`);
  }

  const manifest = await loadManifest(CFG.sharedDir, (m) => plog('manifest', m));
  const registry = new RegistryClient({ rpcUrl: CFG.rpcUrl, manifest, logger: (m) => plog('registry', m) });
  await registry.waitForRpc();

  // Default the payment webhook at our own local mock receiver if unset, so the
  // decoupled event path is exercised end-to-end without any external service.
  const webhookUrl = CFG.paymentWebhookUrl || `http://127.0.0.1:${CFG.ocpiPort}/webhooks/payments`;
  const payment = createPaymentPlugin(CFG.paymentPlugin, {
    logger: (m) => plog('payment', m),
    webhookUrl,
  });
  plog('payment', `payment rail plugin loaded: ${payment.name} (webhook -> ${webhookUrl}); shared across all tenants on this process`);

  // One offline queue per tenant, so CDRs from different identities never mix
  // ordering or get attributed to the wrong Party.
  const queuesByTenant = new Map();
  for (const t of CFG.tenants) {
    const tag = tenantTag(t);
    queuesByTenant.set(tag, new OfflineQueue(`${CFG.dataDir}/cdr-queue-${t.partyId}.json`, (m) => log(tag, 'queue', m)));
  }

  // Freshness/replay state is per-process and shared by every hosted tenant:
  // a nonce is single-use across this gateway, not merely per identity.
  const replayGuard = new ReplayGuard({ logger: (m) => plog('replay', m) });

  const app = buildServer(registry, payment, replayGuard);
  await new Promise((resolve) => app.listen(CFG.ocpiPort, '0.0.0.0', resolve));
  plog('http', `OCPI receiver listening on 0.0.0.0:${CFG.ocpiPort}, serving: ${CFG.tenants.map((t) => `/party/${t.partyCountry}/${t.partyId}`).join(', ')}`);

  // Kick off each tenant's configured initiator relationships concurrently —
  // one identity's slow/unreachable peer never blocks another identity's.
  const initiations = [];
  for (const t of CFG.tenants) {
    const tag = tenantTag(t);
    const queue = queuesByTenant.get(tag);
    for (const peer of t.peers) {
      if (!peer.initiate) continue;
      initiations.push(
        (async () => {
          for (let attempt = 1; attempt <= 30; attempt++) {
            try {
              await runInitiatorFor(t, peer, registry, payment, queue);
              return;
            } catch (e) {
              log(tag, 'retry', `initiator attempt ${attempt}/30 (peer ${peer.peerCountry}/${peer.peerId}) failed: ${e.message}`);
              await sleep(3000);
            }
          }
          log(tag, 'retry', `giving up on peer ${peer.peerCountry}/${peer.peerId} after 30 attempts`);
        })()
      );
    }
  }
  if (initiations.length === 0) {
    plog('ready', 'passive receiver mode for every hosted tenant; awaiting inbound handshakes.');
  }
  await Promise.all(initiations);
}

main().catch((err) => {
  console.error(`[gateway:${PROCESS_TAG}] FATAL:`, err);
  process.exit(1);
});
