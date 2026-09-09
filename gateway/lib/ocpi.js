'use strict';

/**
 * Minimal, faithful OCPI 2.2.1 building blocks: the versions module, the
 * version-detail module, the credentials object, and a signed credentials
 * handshake client.
 *
 * ADERA enhancement: the OCPI credentials POST is signed with the sender's
 * messaging key and carries the sender's on-chain party key. The receiver
 * authenticates it against the registry rather than trusting a pre-shared
 * TOKEN_A alone — the classic weak point of vanilla OCPI onboarding.
 */

const { signBody } = require('./crypto');

const OCPI_VERSION = '2.2.1';

function envelope(data) {
  return {
    data,
    status_code: 1000,
    status_message: 'Success',
    timestamp: new Date().toISOString(),
  };
}

function errorEnvelope(statusCode, message) {
  return {
    data: null,
    status_code: statusCode,
    status_message: message,
    timestamp: new Date().toISOString(),
  };
}

function buildVersionsPayload(baseUrl) {
  return envelope({
    versions: [{ version: OCPI_VERSION, url: `${baseUrl}/ocpi/${OCPI_VERSION}` }],
  });
}

function buildVersionDetailPayload(baseUrl) {
  return envelope({
    version: OCPI_VERSION,
    endpoints: [
      { identifier: 'credentials', role: 'RECEIVER', url: `${baseUrl}/ocpi/${OCPI_VERSION}/credentials` },
      { identifier: 'versions', role: 'RECEIVER', url: `${baseUrl}/ocpi/versions` },
      { identifier: 'cdrs', role: 'RECEIVER', url: `${baseUrl}/ocpi/${OCPI_VERSION}/cdrs` },
    ],
  });
}

function buildCredentialsObject({ token, baseUrl, role, partyId, countryCode, businessName }) {
  return {
    token,
    url: `${baseUrl}/ocpi/versions`,
    roles: [
      {
        role, // "CPO" | "EMSP"
        party_id: partyId,
        country_code: countryCode,
        business_details: { name: businessName },
      },
    ],
  };
}

async function httpJson(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error(`non-JSON response from ${url} (${res.status}): ${text.slice(0, 200)}`);
  }
  return { status: res.status, json };
}

/**
 * Initiator side of the credentials handshake.
 *  1. GET peer /ocpi/versions           -> discover version url
 *  2. GET peer /ocpi/2.2.1              -> discover credentials url
 *  3. POST signed credentials           -> receive peer TOKEN_C credentials
 */
async function initiateHandshake({
  peerVersionsUrl,
  regToken,
  localCredentials,
  localPartyKey,
  messagingKey,
  logger,
}) {
  const authHeaders = { Authorization: `Token ${regToken}` };

  logger(`handshake step 1: GET ${peerVersionsUrl}`);
  const versionsRes = await httpJson(peerVersionsUrl, { headers: authHeaders });
  if (versionsRes.status !== 200) throw new Error(`versions returned ${versionsRes.status}`);
  const version = (versionsRes.json.data.versions || []).find((v) => v.version === OCPI_VERSION);
  if (!version) throw new Error(`peer does not support OCPI ${OCPI_VERSION}`);

  logger(`handshake step 2: GET ${version.url}`);
  const detailRes = await httpJson(version.url, { headers: authHeaders });
  if (detailRes.status !== 200) throw new Error(`version detail returned ${detailRes.status}`);
  const credsEndpoint = (detailRes.json.data.endpoints || []).find((e) => e.identifier === 'credentials');
  if (!credsEndpoint) throw new Error('peer exposes no credentials endpoint');

  const bodyString = JSON.stringify(localCredentials);
  const signature = await signBody(messagingKey, bodyString);

  logger(`handshake step 3: POST ${credsEndpoint.url} (signed, party=${localPartyKey.slice(0, 10)}...)`);
  const postRes = await httpJson(credsEndpoint.url, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
      'X-ADERA-Party': localPartyKey,
      'X-ADERA-Signature': signature,
    },
    body: bodyString,
  });
  if (postRes.status !== 200) {
    throw new Error(`credentials POST rejected (${postRes.status}): ${JSON.stringify(postRes.json)}`);
  }
  return postRes.json.data; // peer credentials (contains peer TOKEN_C)
}

module.exports = {
  OCPI_VERSION,
  envelope,
  errorEnvelope,
  buildVersionsPayload,
  buildVersionDetailPayload,
  buildCredentialsObject,
  initiateHandshake,
};
