'use strict';

/**
 * ADERA gateway crypto helpers.
 *
 *  - Endpoint confidentiality: routable OCPI endpoints are stored on-chain only
 *    as AES-256-GCM ciphertext under the consortium data-plane key. Only an
 *    admitted member holding that key can resolve a peer's real address.
 *
 *  - Identity binding: OCPI credential handshakes are signed with the sender's
 *    messaging key; the receiver verifies the recovered address against the
 *    sender's on-chain public key. A rogue node cannot forge another party's
 *    signature, so it cannot impersonate another Party ID.
 *
 *  - Freshness: the signature covers a timestamp and a single-use nonce as well
 *    as the body, so a captured handshake cannot be replayed later. This is what
 *    makes the Layer 6 claim ("proving I hold this key, RIGHT NOW" — docs/02
 *    §4.4) literally true rather than merely "I held it at some point".
 */

const crypto = require('crypto');
const { ethers } = require('ethers');

/** AES-256-GCM decrypt an endpoint blob produced by the deployer. */
function decryptEndpoint(cipherHex, keyHex) {
  const buf = Buffer.from(cipherHex.replace(/^0x/, ''), 'hex');
  const key = Buffer.from(keyHex.replace(/^0x/, ''), 'hex');
  if (key.length !== 32) throw new Error('consortium key must be 32 bytes');
  if (buf.length < 28) throw new Error('ciphertext too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * The exact bytes both sides sign / verify for a credentials handshake.
 *
 * Defined in ONE place so the initiator and the receiver can never drift apart:
 * if this format changes, both ends change with it. The timestamp and nonce are
 * carried as headers rather than injected into the credentials object so the
 * POST body stays a byte-for-byte valid OCPI 2.2.1 payload.
 */
function handshakeSigningPayload({ timestamp, nonce, body }) {
  return `${timestamp}\n${nonce}\n${body}`;
}

/** Sign a canonical UTF-8 body with the gateway's messaging key (EIP-191). */
function signBody(messagingKey, body) {
  const wallet = new ethers.Wallet(messagingKey);
  return wallet.signMessage(body); // returns Promise<string>
}

/** Recover the signer address from a signed body. */
function recoverSigner(body, signature) {
  return ethers.verifyMessage(body, signature);
}

/** Derive the ethereum address from a stored 64-byte (prefix-stripped) pubkey. */
function addressFromStoredPubKey(pubKeyHex) {
  const hex = pubKeyHex.replace(/^0x/, '');
  return ethers.computeAddress('0x04' + hex);
}

module.exports = {
  decryptEndpoint,
  handshakeSigningPayload,
  signBody,
  recoverSigner,
  addressFromStoredPubKey,
};
