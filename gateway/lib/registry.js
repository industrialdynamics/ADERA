'use strict';

/**
 * Thin, read-mostly client around the on-chain AderaRegistry. This is the
 * "dynamic routing table": the gateway never hard-codes a peer address, it
 * resolves it live from the ledger on every handshake.
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for, then load, the deployment manifest written by the deployer. */
async function loadManifest(sharedDir, logger) {
  const p = path.join(sharedDir, 'deployment.json');
  for (let i = 1; i <= 90; i++) {
    if (fs.existsSync(p)) {
      const manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (manifest.registryAddress && Array.isArray(manifest.abi)) {
        logger(`loaded manifest: registry=${manifest.registryAddress}`);
        return manifest;
      }
    }
    logger(`waiting for ${p} (attempt ${i}/90)`);
    await sleep(2000);
  }
  throw new Error('deployment manifest never appeared');
}

class RegistryClient {
  constructor({ rpcUrl, manifest, logger }) {
    this.logger = logger || (() => {});
    this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
    this.contract = new ethers.Contract(manifest.registryAddress, manifest.abi, this.provider);
    this.manifest = manifest;
  }

  async waitForRpc() {
    for (let i = 1; i <= 60; i++) {
      try {
        const head = await this.provider.getBlockNumber();
        this.logger(`rpc connected, head=#${head}`);
        return;
      } catch (e) {
        this.logger(`waiting for rpc (attempt ${i}/60): ${e.shortMessage || e.message}`);
        await sleep(2000);
      }
    }
    throw new Error('gateway could not reach its Besu RPC');
  }

  partyKey(countryCode, partyId) {
    const cc = ethers.hexlify(ethers.toUtf8Bytes(countryCode)); // bytes2
    const pid = ethers.hexlify(ethers.toUtf8Bytes(partyId));    // bytes3
    return this.contract.computePartyKey(cc, pid);
  }

  /** Resolve a peer: returns { endpointCipher, pubKey, role, active }. */
  async resolveEndpoint(partyKey) {
    const [endpointCipher, pubKey, role, active] = await this.contract.resolveEndpoint(partyKey);
    return { endpointCipher, pubKey, role: Number(role), active };
  }

  async getParty(partyKey) {
    return this.contract.getParty(partyKey);
  }

  async isActive(countryCode, partyId) {
    const cc = ethers.hexlify(ethers.toUtf8Bytes(countryCode));
    const pid = ethers.hexlify(ethers.toUtf8Bytes(partyId));
    return this.contract.isActiveParty(cc, pid);
  }

  async members() {
    return this.contract.getMembers();
  }
}

module.exports = { RegistryClient, loadManifest };
