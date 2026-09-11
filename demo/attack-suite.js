'use strict';

/**
 * ADERA handshake attack suite
 * ============================
 * Runs INSIDE the CPO gateway container (it needs `ethers` and network access
 * to the peer gateway) and fires a series of forged, replayed and mis-declared
 * credentials handshakes at the eMSP gateway.
 *
 * Every case here is an attack the design claims to stop. The point of running
 * it live is that the security story stops being an assertion in a document and
 * becomes something a sceptical reviewer watches fail in real time.
 *
 * The only genuine credential used is the CPO's own messaging key, read from
 * the environment — i.e. this is an attack by a LEGITIMATELY ADMITTED party,
 * which is the interesting threat model. An outsider with no key at all is the
 * easy case and is covered by the unsigned-POST check in verify.sh.
 *
 * Usage (normally invoked by demo/verify.sh):
 *   docker cp demo/attack-suite.js adera-gateway-cpo:/tmp/
 *   docker exec adera-gateway-cpo node /tmp/attack-suite.js
 */

const crypto = require('crypto');
const { ethers } = require('/app/node_modules/ethers');

const TARGET =
  process.env.ATTACK_TARGET ||
  'http://adera-gateway-emsp:9102/party/LK/EMS/ocpi/2.2.1/credentials';
const CPO_KEY = process.env.TENANT_1_MESSAGING_KEY;
const REG_TOKEN = process.env.REG_TOKEN || 'ADERA-REG-TOKEN-A';

if (!CPO_KEY) {
  console.error('TENANT_1_MESSAGING_KEY not present — run this inside adera-gateway-cpo');
  process.exit(2);
}

// Must match gateway/lib/crypto.js handshakeSigningPayload().
const signingPayload = ({ timestamp, nonce, body }) => `${timestamp}\n${nonce}\n${body}`;

const wallet = new ethers.Wallet(CPO_KEY);
const cpoPartyKey = ethers.keccak256(
  ethers.concat([ethers.toUtf8Bytes('LK'), ethers.toUtf8Bytes('CPO')])
);

const credentials = (countryCode, partyId, role, name) =>
  JSON.stringify({
    token: REG_TOKEN,
    url: 'http://adera-gateway-cpo:9101/party/LK/CPO/ocpi/versions',
    roles: [{ role, party_id: partyId, country_code: countryCode, business_details: { name } }],
  });

async function send({ body, partyKey, signature, timestamp, nonce }) {
  const res = await fetch(TARGET, {
    method: 'POST',
    headers: {
      Authorization: `Token ${REG_TOKEN}`,
      'Content-Type': 'application/json',
      'X-ADERA-Party': partyKey,
      'X-ADERA-Signature': signature,
      'X-ADERA-Timestamp': timestamp,
      'X-ADERA-Nonce': nonce,
    },
    body,
  });
  let message = '';
  try {
    message = (await res.json()).status_message || '';
  } catch (_) {
    /* non-JSON body: status alone is enough */
  }
  return { status: res.status, message };
}

/** Sign and send a well-formed request, varying whichever part a case is probing. */
async function attempt({ body, partyKey = cpoPartyKey, timestamp, nonce, signature }) {
  const ts = timestamp || new Date().toISOString();
  const nc = nonce || crypto.randomBytes(16).toString('hex');
  const sig = signature || (await wallet.signMessage(signingPayload({ timestamp: ts, nonce: nc, body })));
  return send({ body, partyKey, signature: sig, timestamp: ts, nonce: nc });
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

let failures = 0;

function report(name, expectation, result, ok) {
  const verdict = ok ? `${GREEN}PASS${OFF}` : `${RED}FAIL${OFF}`;
  if (!ok) failures++;
  console.log(`  ${verdict}  ${name.padEnd(34)} ${result.status}  ${DIM}${result.message.slice(0, 58)}${OFF}`);
  if (!ok) console.log(`        expected: ${expectation}`);
}

(async () => {
  const honest = credentials('LK', 'CPO', 'CPO', 'Example Charging Co. (Pvt) Ltd');

  console.log('\n  Attacks by a LEGITIMATELY ADMITTED party (LK/CPO), against LK/EMS:\n');

  // Baseline: an honest handshake must still succeed, or the rest proves nothing.
  const baseline = await attempt({ body: honest });
  report('honest handshake', '200', baseline, baseline.status === 200);

  // 1. Replay: resend a previously accepted request byte for byte.
  const ts = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = await wallet.signMessage(signingPayload({ timestamp: ts, nonce, body: honest }));
  const first = await send({ body: honest, partyKey: cpoPartyKey, signature: sig, timestamp: ts, nonce });
  report('replay 1/2 (first send)', '200', first, first.status === 200);
  const replayed = await send({ body: honest, partyKey: cpoPartyKey, signature: sig, timestamp: ts, nonce });
  report('replay 2/2 (identical resend)', '401', replayed, replayed.status === 401);

  // 2. Impersonation: sign correctly as ourselves, but CLAIM to be LK/EVX.
  const asEvx = await attempt({ body: credentials('LK', 'EVX', 'CPO', 'Impersonating EVX') });
  report('payload claims another party', '403', asEvx, asEvx.status === 403);

  // 3. Role swap: a CPO presenting itself as an eMSP.
  const roleSwap = await attempt({ body: credentials('LK', 'CPO', 'EMSP', 'Role swap') });
  report('payload claims another role', '403', roleSwap, roleSwap.status === 403);

  // 4. Stale: correctly signed, but timestamped outside the freshness window.
  const stale = await attempt({ body: honest, timestamp: new Date(Date.now() - 20 * 60_000).toISOString() });
  report('stale timestamp (20 min old)', '401', stale, stale.status === 401);

  // 5. Refresh a captured request by swapping in a new timestamp/nonce. This is
  //    the case that proves freshness is SIGNED rather than merely transmitted.
  const refreshed = await send({
    body: honest,
    partyKey: cpoPartyKey,
    signature: sig, // signature over the ORIGINAL timestamp/nonce
    timestamp: new Date().toISOString(),
    nonce: crypto.randomBytes(16).toString('hex'),
  });
  report('captured sig + fresh nonce', '401', refreshed, refreshed.status === 401);

  console.log(
    failures === 0
      ? `\n  ${GREEN}All handshake attacks rejected.${OFF}\n`
      : `\n  ${RED}${failures} case(s) behaved unexpectedly.${OFF}\n`
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('attack suite error:', e.message);
  process.exit(2);
});
