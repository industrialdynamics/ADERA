'use strict';

/**
 * ADERA contract deployer
 * ------------------------
 * 1. Waits for the local Besu RPC to become responsive.
 * 2. Compiles AderaRegistry.sol with a bare solc (no Hardhat/Foundry).
 * 3. Deploys the registry with the two FOUNDING parties (LK/CPO, LK/EMS),
 *    a 2-of-N multisig threshold, and the regulator's auditor key.
 * 4. Demonstrates the governance flow end to end:
 *      - proposes a THIRD party (LK/EVX) as CPO founder,
 *      - has the eMSP founder confirm it -> threshold met -> auto-admitted,
 *      - has the regulator's auditor emit an on-chain ComplianceProbe attestation.
 * 5. Writes /shared/deployment.json (address + ABI + party map) which the
 *    operator gateways consume for on-chain discovery.
 *
 * Everything here is deterministic and idempotent-friendly for a local sandbox.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const solc = require('solc');
const { ethers } = require('ethers');

// ---------------------------------------------------------------------------
// Configuration (env-overridable; defaults match docker-compose.yml)
// ---------------------------------------------------------------------------
const CFG = {
  rpcUrl: process.env.RPC_URL || 'http://adera-validator-cpo:8545',
  chainId: parseInt(process.env.CHAIN_ID || '20231', 10),
  sharedDir: process.env.SHARED_DIR || '/shared',
  threshold: parseInt(process.env.THRESHOLD || '2', 10),

  // Consortium data-plane symmetric key (AES-256-GCM). Provisioned out-of-band
  // to every admitted member. Used to encrypt the routable OCPI endpoints that
  // are stored (as opaque ciphertext) on-chain.
  consortiumKey: process.env.ADERA_CONSORTIUM_KEY ||
    '0x8d0c9b3a7f1e4d2c5b6a09182736455463728190a1b2c3d4e5f60718293a4b5c',

  // Governance signer keys (legal-entity keys).
  deployerKey: process.env.DEPLOYER_KEY ||           // founding CPO operator / signer 1
    '0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63',
  emspSignerKey: process.env.EMSP_SIGNER_KEY ||      // founding eMSP operator / signer 2
    '0xc87509a1c067bbde78beb793e6fa76530b6382a4c0241e5e4a9ec0a0f44dc0d3',
  auditorKey: process.env.AUDITOR_KEY ||             // Regulator auditor / observer
    '0xae6ae8e5ccbfb04590405997ee2d52d2b330726137b875053c36d94e974d162f',

  // Messaging (hot) keys — the registry stores their PUBLIC keys.
  cpoMessagingKey: process.env.CPO_MESSAGING_KEY ||
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  emspMessagingKey: process.env.EMSP_MESSAGING_KEY ||
    '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  evxMessagingKey: process.env.EVX_MESSAGING_KEY ||
    '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',

  // The EVX entity governance key address (admitted later via multisig; it does
  // not need to transact in this PoC, so only the address is required).
  evxEntity: process.env.EVX_ENTITY || '0x90F79bf6EB2c4f870365E785982E1f101E93b906',

  // Routable OCPI "versions" endpoints (kept confidential -> stored encrypted).
  // Each path is scoped /party/<country>/<partyId>/... because a single
  // gateway process can host more than one Party identity (see gateway.js).
  cpoOcpiUrl: process.env.CPO_OCPI_URL || 'http://adera-gateway-cpo:9101/party/LK/CPO/ocpi/versions',
  emspOcpiUrl: process.env.EMSP_OCPI_URL || 'http://adera-gateway-emsp:9102/party/LK/EMS/ocpi/versions',
  evxOcpiUrl: process.env.EVX_OCPI_URL || 'http://adera-gateway-evx:9103/party/LK/EVX/ocpi/versions',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(section, msg) {
  console.log(`[deployer] ${section.padEnd(10)} | ${msg}`);
}

/** ISO country / party-id ascii -> fixed-size bytesN hex. */
function toBytesN(str, n) {
  const bytes = Buffer.from(str, 'ascii');
  if (bytes.length > n) throw new Error(`"${str}" exceeds bytes${n}`);
  const padded = Buffer.alloc(n);
  bytes.copy(padded, 0);
  return '0x' + padded.toString('hex');
}

/** 64-byte (uncompressed, prefix-stripped) secp256k1 public key from a priv key. */
function messagingPubKey(privKey) {
  const sk = new ethers.SigningKey(privKey);
  return '0x' + sk.publicKey.slice(4); // drop the 0x04 SEC1 prefix -> 128 hex chars
}

/** AES-256-GCM encrypt a routable endpoint under the consortium data-plane key. */
function encryptEndpoint(url, keyHex) {
  const key = Buffer.from(keyHex.replace(/^0x/, ''), 'hex');
  if (key.length !== 32) throw new Error('consortium key must be 32 bytes');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // wire format: iv(12) || tag(16) || ciphertext
  return '0x' + Buffer.concat([iv, tag, ct]).toString('hex');
}

async function waitForRpc(provider) {
  for (let i = 1; i <= 60; i++) {
    try {
      const net = await provider.getNetwork();
      const block = await provider.getBlockNumber();
      log('rpc', `connected: chainId=${net.chainId} head=#${block}`);
      return;
    } catch (e) {
      log('rpc', `waiting for ${CFG.rpcUrl} (attempt ${i}/60): ${e.shortMessage || e.message}`);
      await sleep(2000);
    }
  }
  throw new Error('Besu RPC never became available');
}

function compileRegistry() {
  const source = fs.readFileSync(path.join(__dirname, 'AderaRegistry.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'AderaRegistry.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'london',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors) {
    const fatal = out.errors.filter((e) => e.severity === 'error');
    for (const e of out.errors) log('solc', e.formattedMessage.trim());
    if (fatal.length) throw new Error('Solidity compilation failed');
  }
  const c = out.contracts['AderaRegistry.sol']['AderaRegistry'];
  log('solc', `compiled AderaRegistry (${c.evm.bytecode.object.length / 2} bytes runtime input)`);
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log('boot', 'ADERA registry deployer starting');

  const provider = new ethers.JsonRpcProvider(CFG.rpcUrl, undefined, { staticNetwork: true });
  await waitForRpc(provider);

  const cpoSigner = new ethers.Wallet(CFG.deployerKey, provider);   // founding CPO
  const emspSigner = new ethers.Wallet(CFG.emspSignerKey, provider); // founding eMSP
  const auditorSigner = new ethers.Wallet(CFG.auditorKey, provider); // Regulator

  const cpoEntity = cpoSigner.address;
  const emspEntity = emspSigner.address;
  const auditorAddr = auditorSigner.address;

  log('actors', `CPO   entity  = ${cpoEntity}`);
  log('actors', `eMSP  entity  = ${emspEntity}`);
  log('actors', `Regulator auditor = ${auditorAddr}`);

  // Fixed-size OCPI identifiers.
  const LK = toBytesN('LK', 2);
  const CPO = toBytesN('CPO', 3);
  const EMS = toBytesN('EMS', 3);
  const EVX = toBytesN('EVX', 3);

  // Founding party records.
  const founders = [
    {
      countryCode: LK,
      partyId: CPO,
      role: 1, // Role.CPO
      entity: cpoEntity,
      endpointCipher: encryptEndpoint(CFG.cpoOcpiUrl, CFG.consortiumKey),
      pubKey: messagingPubKey(CFG.cpoMessagingKey),
    },
    {
      countryCode: LK,
      partyId: EMS,
      role: 2, // Role.EMSP
      entity: emspEntity,
      endpointCipher: encryptEndpoint(CFG.emspOcpiUrl, CFG.consortiumKey),
      pubKey: messagingPubKey(CFG.emspMessagingKey),
    },
  ];

  // ---- Compile & deploy ---------------------------------------------------
  const { abi, bytecode } = compileRegistry();
  const factory = new ethers.ContractFactory(abi, bytecode, cpoSigner);

  log('deploy', `deploying registry (threshold=${CFG.threshold}, auditor=${auditorAddr})`);
  const registry = await factory.deploy(founders, CFG.threshold, auditorAddr);
  await registry.waitForDeployment();
  const address = await registry.getAddress();
  log('deploy', `AderaRegistry deployed at ${address}`);

  // Sanity read-back.
  const memberCount = await registry.memberCount();
  const partyCount = await registry.partyCount();
  log('verify', `partyCount=${partyCount} memberCount=${memberCount}`);

  const cpoKey = await registry.computePartyKey(LK, CPO);
  const emsKey = await registry.computePartyKey(LK, EMS);
  const evxKey = await registry.computePartyKey(LK, EVX);

  // ---- Multisig admission of a THIRD party (LK/EVX) -----------------------
  log('gov', 'CPO founder proposes admission of new party LK/EVX (CPO role)');
  const evxCipher = encryptEndpoint(CFG.evxOcpiUrl, CFG.consortiumKey);
  const evxPub = messagingPubKey(CFG.evxMessagingKey);

  const nextProposalId = await registry.proposalCount(); // id of the proposal we are about to create
  let tx = await registry.connect(cpoSigner).proposeAdmitParty(
    LK, EVX, 1 /* CPO */, CFG.evxEntity, evxCipher, evxPub
  );
  await tx.wait();
  log('gov', `proposal #${nextProposalId} created and auto-confirmed by CPO founder (1/${CFG.threshold})`);

  log('gov', 'eMSP founder confirms the proposal');
  tx = await registry.connect(emspSigner).confirm(nextProposalId);
  await tx.wait();

  const p = await registry.getProposal(nextProposalId);
  log('gov', `proposal #${nextProposalId} executed=${p.executed} confirmations=${p.confirmations}/${CFG.threshold}`);

  const evxActive = await registry.isActiveParty(LK, EVX);
  log('gov', `LK/EVX admitted & active = ${evxActive}; members now = ${await registry.memberCount()}`);

  // ---- Regulator auditor attestation --------------------------------------
  log('audit', 'Regulator auditor emits on-chain ComplianceProbe against LK/CPO');
  tx = await registry.connect(auditorSigner).auditProbe(
    cpoKey, 'Regulator 2026-Q3 spot inspection: verified CPO endpoint + pubkey binding'
  );
  const probeReceipt = await tx.wait();
  log('audit', `ComplianceProbe mined in block #${probeReceipt.blockNumber}`);

  // ---- Emit deployment manifest for the gateways --------------------------
  const manifest = {
    network: 'adera-qbft-local',
    chainId: CFG.chainId,
    registryAddress: address,
    threshold: CFG.threshold,
    auditor: auditorAddr,
    deployedAt: new Date().toISOString(),
    abi,
    parties: {
      'LK/CPO': {
        partyKey: cpoKey, countryCode: 'LK', partyId: 'CPO', role: 'CPO',
        entity: cpoEntity, ocpiUrl: CFG.cpoOcpiUrl, gateway: 'adera-gateway-cpo',
      },
      'LK/EMS': {
        partyKey: emsKey, countryCode: 'LK', partyId: 'EMS', role: 'EMSP',
        entity: emspEntity, ocpiUrl: CFG.emspOcpiUrl, gateway: 'adera-gateway-emsp',
      },
      'LK/EVX': {
        partyKey: evxKey, countryCode: 'LK', partyId: 'EVX', role: 'CPO',
        entity: CFG.evxEntity, ocpiUrl: CFG.evxOcpiUrl, gateway: 'adera-gateway-evx (not run in PoC)',
      },
    },
  };

  fs.mkdirSync(CFG.sharedDir, { recursive: true });
  const outPath = path.join(CFG.sharedDir, 'deployment.json');
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  log('manifest', `wrote ${outPath}`);

  log('done', 'ADERA registry bootstrapped successfully. Gateways may start.');
}

main().catch((err) => {
  console.error('[deployer] FATAL:', err);
  process.exit(1);
});
