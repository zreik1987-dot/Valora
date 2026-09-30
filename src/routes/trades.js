'use strict';

// Trade fee payment: Stripe Payment Element checkout page, return handler,
// and the Stripe webhook. All Stripe calls are server-side.

const express = require('express');
const lib = require('../lib');
const { ah } = lib;
const stripeLib = require('../stripe');

async function getStripeSettings(db) {
  return db.get('SELECT * FROM stripe_settings WHERE id = 1');
}

async function markFeePaid(db, tradeId, piId) {
  await db.run(
    `UPDATE fee_ledger SET status = 'paid', stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?)
     WHERE trade_id = ?`,
    piId,
    tradeId
  );
  await db.run(
    `UPDATE trades SET stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?) WHERE id = ?`,
    piId,
    tradeId
  );
}

async function getTradeFor(db, tradeId, member) {
  const trade = await db.get(
    `SELECT t.*, l.title AS listing_title
     FROM trades t JOIN listings l ON l.id = t.listing_id
     WHERE t.id = ?`,
    tradeId
  );
  if (!trade) return null;
  if (trade.buyer_member_id !== member.id && trade.seller_member_id !== member.id && !member.is_owner) {
    return null;
  }
  return trade;
}

module.exports = function (db, cfg, mw) {
  const r = express.Router();

  // Checkout page: the buyer pays the 5% platform fee via Stripe Payment Element.
  r.get(
    '/trades/:id/pay',
    mw.requireAuth,
    ah(async (req, res) => {
      const trade = await getTradeFor(db, req.params.id, req.member);
      if (!trade) return res.status(404).render('error', { status: 404, message: 'Trade not found.' });
      if (trade.buyer_member_id !== req.member.id && !req.member.is_owner) {
        return res.status(403).render('error', {
          status: 403,
          message: 'Only the buyer can pay the fee for this trade.',
        });
      }
      const ledger = await db.get('SELECT * FROM fee_ledger WHERE trade_id = ?', trade.id);
      if (trade.fee_cents === 0 || (ledger && ledger.status === 'paid')) {
        return res.render('pay-result', { title: 'Fee payment', state: 'paid', trade, message: null });
      }
      const settings = await getStripeSettings(db);
      if (!settings || !settings.secret_key) {
        return res.render('pay-result', { title: 'Fee payment', state: 'noconn', trade, message: null });
      }

      let piId = trade.stripe_payment_intent_id;
      let clientSecret;
      if (piId) {
        const pi = await stripeLib.retrievePaymentIntent(settings.secret_key, piId);
        if (pi.status === 'succeeded') {
          await markFeePaid(db, trade.id, piId);
          return res.render('pay-result', { title: 'Fee payment', state: 'paid', trade, message: null });
        }
        clientSecret = pi.client_secret;
      } else {
        const pi = await stripeLib.createPaymentIntent(
          settings.secret_key,
          trade.fee_cents,
          `Valora platform fee — trade #${trade.id}`
        );
        piId = pi.id;
        clientSecret = pi.client_secret;
        await db.run('UPDATE trades SET stripe_payment_intent_id = ? WHERE id = ?', piId, trade.id);
        await db.run('UPDATE fee_ledger SET stripe_payment_intent_id = ? WHERE trade_id = ?', piId, trade.id);
      }

      res.render('pay', {
        title: 'Pay the platform fee',
        trade,
        amount: lib.money(trade.fee_cents),
        publishableKey: settings.publishable_key,
        clientSecret,
      });
    })
  );

  // The browser collects card details with the Payment Element, creates a
  // PaymentMethod, and POSTs its id here. Confirmation happens server-side.
  r.post(
    '/trades/:id/pay/confirm',
    mw.requireAuth,
    mw.requireCsrf,
    ah(async (req, res) => {
      const trade = await getTradeFor(db, req.params.id, req.member);
      if (!trade) return res.status(404).json({ error: 'Trade not found.' });
      if (trade.buyer_member_id !== req.member.id && !req.member.is_owner) {
        return res.status(403).json({ error: 'Only the buyer can pay the fee for this trade.' });
      }
      const ledger = await db.get('SELECT * FROM fee_ledger WHERE trade_id = ?', trade.id);
      if (trade.fee_cents === 0 || (ledger && ledger.status === 'paid')) {
        return res.json({ ok: true });
      }
      const settings = await getStripeSettings(db);
      if (!settings || !settings.secret_key || !trade.stripe_payment_intent_id) {
        return res.status(400).json({ error: 'Payments are not connected yet.' });
      }
      const pm = req.body && req.body.payment_method;
      if (!pm || typeof pm !== 'string' || !/^pm_[A-Za-z0-9]+$/.test(pm)) {
        return res.status(400).json({ error: 'Invalid payment details.' });
      }
      const pi = await stripeLib.confirmPaymentIntent(
        settings.secret_key,
        trade.stripe_payment_intent_id,
        pm
      );
      if (pi.status === 'succeeded') {
        await markFeePaid(db, trade.id, pi.id);
        return res.json({ ok: true });
      }
      if (pi.status === 'requires_action' && pi.client_secret) {
        // 3-D Secure (or similar): the browser completes the action, then
        // calls /finalize so the server re-verifies the outcome.
        return res.json({ requires_action: true, client_secret: pi.client_secret });
      }
      return res.status(400).json({
        error: 'The payment could not be completed. No money was charged.',
      });
    })
  );

  // After the browser completes a required action (e.g. 3-D Secure), the
  // server re-verifies the PaymentIntent before marking the fee paid.
  r.post(
    '/trades/:id/pay/finalize',
    mw.requireAuth,
    mw.requireCsrf,
    ah(async (req, res) => {
      const trade = await getTradeFor(db, req.params.id, req.member);
      if (!trade) return res.status(404).json({ error: 'Trade not found.' });
      const settings = await getStripeSettings(db);
      if (!settings || !settings.secret_key || !trade.stripe_payment_intent_id) {
        return res.status(400).json({ error: 'Payments are not connected yet.' });
      }
      const pi = await stripeLib.retrievePaymentIntent(
        settings.secret_key,
        trade.stripe_payment_intent_id
      );
      if (pi.status === 'succeeded') {
        await markFeePaid(db, trade.id, pi.id);
        return res.json({ ok: true });
      }
      return res.status(400).json({
        error: 'The payment did not go through. No money was charged.',
      });
    })
  );

  // Result page: always re-verified server-side, never trusted from the client.
  r.get(
    '/trades/:id/pay/result',
    mw.requireAuth,
    ah(async (req, res) => {
      const trade = await getTradeFor(db, req.params.id, req.member);
      if (!trade) return res.status(404).render('error', { status: 404, message: 'Trade not found.' });
      const ledger = await db.get('SELECT * FROM fee_ledger WHERE trade_id = ?', trade.id);
      if (trade.fee_cents === 0 || (ledger && ledger.status === 'paid')) {
        return res.render('pay-result', { title: 'Fee payment', state: 'paid', trade, message: null });
      }
      const settings = await getStripeSettings(db);
      if (settings && settings.secret_key && trade.stripe_payment_intent_id) {
        try {
          const pi = await stripeLib.retrievePaymentIntent(
            settings.secret_key,
            trade.stripe_payment_intent_id
          );
          if (pi.status === 'succeeded') {
            await markFeePaid(db, trade.id, pi.id);
            return res.render('pay-result', {
              title: 'Fee payment',
              state: 'paid',
              trade,
              message: null,
            });
          }
        } catch {
          // fall through to the failed state below
        }
      }
      res.render('pay-result', {
        title: 'Fee payment',
        state: 'failed',
        trade,
        message: 'The payment did not go through. No money was charged.',
      });
    })
  );

  // Raw-body webhook handler (mounted in app.js before the body parsers).
  async function webhook(req, res) {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const payload = req.body.toString('utf8');
    if (webhookSecret) {
      const ok = stripeLib.verifyWebhookSignature(payload, req.headers['stripe-signature'], webhookSecret);
      if (!ok) return res.status(400).send('Invalid signature');
    }
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return res.status(400).send('Invalid JSON');
    }
    try {
      if (event.type === 'payment_intent.succeeded' && event.data && event.data.object) {
        const pi = event.data.object;
        const trade = await db.get('SELECT id FROM trades WHERE stripe_payment_intent_id = ?', pi.id);
        if (trade) await markFeePaid(db, trade.id, pi.id);
      }
    } catch (e) {
      console.error('webhook handler error', e);
    }
    res.json({ received: true });
  }

  return { router: r, webhook };
};
