'use strict';

/**
 * ADERA Pluggable Payment Abstraction Layer
 * ------------------------------------------
 * ADERA never touches money on-chain (it is tokenless). Financial clearing is
 * delegated to whatever local rail an operator already uses. A gateway loads a
 * plugin implementing this interface and the rest of the system is agnostic to
 * it. Settlement is driven by DECOUPLED, fire-and-forget event webhooks so a
 * slow or offline bank host never blocks the OCPI data plane.
 *
 * Interface (PaymentPlugin):
 *   get name(): string
 *   openSettlementChannel({ localParty, remoteParty, remoteRole, remotePubKey })
 *       -> { channelId, rail, mandateRef }
 *   settleCdr({ channelId, cdr }) -> { settlementRef, rail, amount, status }
 *
 * Concrete plugins below are mocks that log the exact event payload they would
 * hand to the rail and (optionally) POST it to a configured webhook receiver.
 */

const crypto = require('crypto');

async function postWebhook(url, event, logger) {
  if (!url) {
    logger(`webhook (no PAYMENT_WEBHOOK_URL set) would POST: ${JSON.stringify(event)}`);
    return;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    logger(`webhook POST ${url} -> ${res.status}`);
  } catch (e) {
    // Decoupled: a webhook failure is logged, never thrown into the data plane.
    logger(`webhook POST ${url} FAILED (non-fatal): ${e.message}`);
  }
}

class BasePaymentPlugin {
  constructor(config) {
    this.config = config || {};
    this.logger = this.config.logger || (() => {});
    this.webhookUrl = this.config.webhookUrl || null;
    this.railName = 'base';
  }

  get name() {
    return this.railName;
  }

  async openSettlementChannel({ localParty, remoteParty, remoteRole }) {
    const channelId = 'chan_' + crypto.randomBytes(8).toString('hex');
    const mandateRef = this.railName.toUpperCase() + '-MANDATE-' + crypto.randomBytes(4).toString('hex');
    const event = {
      type: 'settlement.channel.opened',
      rail: this.railName,
      channelId,
      mandateRef,
      localParty,
      remoteParty,
      remoteRole,
      ts: new Date().toISOString(),
    };
    this.logger(`[${this.railName}] opening settlement channel ${channelId} (mandate ${mandateRef})`);
    await postWebhook(this.webhookUrl, event, this.logger);
    return { channelId, rail: this.railName, mandateRef };
  }

  async settleCdr({ channelId, cdr }) {
    const settlementRef = this.railName.toUpperCase() + '-STL-' + crypto.randomBytes(6).toString('hex');
    const event = {
      type: 'settlement.cdr.posted',
      rail: this.railName,
      channelId,
      settlementRef,
      cdrId: cdr.cdr_id,
      amount: cdr.total_cost,
      kwh: cdr.total_energy_kwh,
      ts: new Date().toISOString(),
    };
    this.logger(`[${this.railName}] settling CDR ${cdr.cdr_id} amount ${cdr.total_cost} -> ${settlementRef}`);
    await postWebhook(this.webhookUrl, event, this.logger);
    return { settlementRef, rail: this.railName, amount: cdr.total_cost, status: 'ACCEPTED' };
  }
}

/** Account-mandate rail (customer authorizes a merchant to pull from their account). */
class MandateRailPlugin extends BasePaymentPlugin {
  constructor(config) {
    super(config);
    this.railName = 'mandate-rail';
  }
}

/** Real-time interbank transfer rail. */
class InterbankTransferPlugin extends BasePaymentPlugin {
  constructor(config) {
    super(config);
    this.railName = 'interbank-transfer';
  }
}

/** No-op rail (settlement handled entirely out-of-band). */
class NullPlugin extends BasePaymentPlugin {
  constructor(config) {
    super(config);
    this.railName = 'null';
  }
}

function createPaymentPlugin(kind, config) {
  switch ((kind || 'mandate').toLowerCase()) {
    case 'mandate':
    case 'mandate-rail':
      return new MandateRailPlugin(config);
    case 'transfer':
    case 'interbank-transfer':
      return new InterbankTransferPlugin(config);
    case 'null':
    case 'none':
      return new NullPlugin(config);
    default:
      throw new Error(`unknown payment plugin: ${kind}`);
  }
}

module.exports = { createPaymentPlugin, BasePaymentPlugin, MandateRailPlugin, InterbankTransferPlugin, NullPlugin };
