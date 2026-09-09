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
  signBody,
  recoverSigner,
  addressFromStoredPubKey,
};
