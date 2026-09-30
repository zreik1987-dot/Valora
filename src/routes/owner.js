'use strict';

// Owner-only area + the one-time owner setup flow.
// The owner is created ONLY here, via OWNER_EMAIL + SETUP_TOKEN. There is no
// other code path that grants is_owner to anyone.

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const lib = require('../lib');
const { ah } = lib;
const session = require('../session');
const stripeLib = require('../stripe');

async function ownerExists(db) {
  return !!(await db.get('SELECT id FROM members WHERE is_owner = 1'));
}

async function setupGuard(db, cfg, req, res) {
  if (await ownerExists(db)) {
    res.status(404).render('error', { status: 404, message: 'Not found.' });
    return false;
  }
  if (!cfg.setupToken || !cfg.ownerEmail) {
    res.status(404).render('error', { status: 404, message: 'Owner setup is not configured.' });
    return false;
  }
  const sent = String(req.query.token || req.body.token || '');
  const expected = cfg.setupToken;
  let ok = false;
  if (sent.length === expected.length && sent.length > 0) {
    try {
      ok = crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    res.status(404).render('error', { status: 404, message: 'Not found.' });
    return false;
  }
  return true;
}

function maskKey(key) {
  if (!key) return null;
  const s = String(key);
  return '…' + s.slice(-4);
}

async function ownerPageData(db) {
  const totals = await db.get(
    `SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END), 0) AS paid,
            COALESCE(SUM(CASE WHEN status = 'unpaid' THEN amount_cents ELSE 0 END), 0) AS unpaid,
            COUNT(*) AS entries
     FROM fee_ledger`
  );
  const ledger = await db.all(
    `SELECT f.*, t.cash_on_top_cents, l.title AS listing_title,
            b.display_name AS buyer_name, s.display_name AS seller_name
     FROM fee_ledger f
     JOIN trades t ON t.id = f.trade_id
     JOIN listings l ON l.id = t.listing_id
     JOIN members b ON b.id = t.buyer_member_id
     JOIN members s ON s.id = t.seller_member_id
     ORDER BY f.created_at DESC LIMIT 100`
  );
  const trades = await db.all(
    `SELECT t.*, l.title AS listing_title, b.display_name AS buyer_name, s.display_name AS seller_name
     FROM trades t
     JOIN listings l ON l.id = t.listing_id
     JOIN members b ON b.id = t.buyer_member_id
     JOIN members s ON s.id = t.seller_member_id
     ORDER BY t.completed_at DESC LIMIT 50`
  );
  const settings = await db.get('SELECT * FROM stripe_settings WHERE id = 1');
  const stripeStatus =
    settings && settings.secret_key
      ? { connected: true, masked: maskKey(settings.secret_key), connectedAt: settings.connected_at }
      : { connected: false };
  return { totals, ledger, trades, stripeStatus };
}

module.exports = function (db, cfg, mw) {
  const r = express.Router();
  const secureCookies = cfg.nodeEnv === 'production';

  // ---- One-time owner setup ----
  r.get(
    '/setup',
    ah(async (req, res) => {
      if (!(await setupGuard(db, cfg, req, res))) return;
      res.render('setup', {
        title: 'Owner setup',
        error: null,
        ownerEmail: cfg.ownerEmail,
        username: '',
        display_name: '',
        token: String(req.query.token || ''),
      });
    })
  );

  r.post(
    '/setup',
    mw.requireCsrf,
    ah(async (req, res) => {
      if (!(await setupGuard(db, cfg, req, res))) return;
      const username = String(req.body.username || '').trim();
      const displayName = String(req.body.display_name || '').trim();
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = req.body.password || '';
      const renderErr = (message) =>
        res.status(400).render('setup', {
          title: 'Owner setup',
          error: message,
          ownerEmail: cfg.ownerEmail,
          username,
          display_name: displayName,
          token: String(req.body.token || ''),
        });

      if (!lib.isValidUsername(username)) {
        return renderErr('Username must be 3–20 characters, letters and numbers only.');
      }
      if (!displayName || displayName.length > 60) {
        return renderErr('Please enter a display name (up to 60 characters).');
      }
      if (email !== cfg.ownerEmail) {
        return renderErr('The email must match the configured owner email.');
      }
      if (!lib.isValidPassword(password)) {
        return renderErr('Password must be at least 8 characters.');
      }
      if (await ownerExists(db)) {
        return res.status(404).render('error', { status: 404, message: 'Not found.' });
      }
      const taken = await db.get('SELECT id FROM members WHERE username = ? OR email = ?', username, email);
      if (taken) return renderErr('That username or email is already taken.');

      const hash = bcrypt.hashSync(password, 12);
      const memberId = await db.insert(
        'INSERT INTO members (username, display_name, email, password_hash, is_owner, created_at) VALUES (?,?,?,?,1,?)',
        username,
        displayName,
        email,
        hash,
        lib.nowIso()
      );
      const s = await session.create(db, memberId);
      session.setCookie(res, s.token, secureCookies);
      res.redirect('/owner');
    })
  );

  // ---- Owner admin ----
  r.get(
    '/owner',
    mw.requireOwner,
    ah(async (req, res) => {
      const data = await ownerPageData(db);
      res.render('owner', {
        title: 'Owner admin',
        ...data,
        stripeError: null,
        stripeOk: req.query.stripe === 'connected',
      });
    })
  );

  // Save + validate the Stripe restricted key. Keys stay server-side only.
  r.post(
    '/owner/stripe',
    mw.requireOwner,
    mw.requireCsrf,
    ah(async (req, res) => {
      const secretKey = String(req.body.secret_key || '').trim();
      const publishableKey = String(req.body.publishable_key || '').trim();
      const fail = async (message) => {
        const data = await ownerPageData(db);
        return res.status(400).render('owner', {
          title: 'Owner admin',
          ...data,
          stripeError: message,
          stripeOk: false,
        });
      };

      if (!secretKey) return fail('Please paste your Stripe restricted secret key.');
      if (!publishableKey) return fail('Please paste your Stripe publishable key.');

      // Validate against GET /v1/balance (never /v1/account).
      const result = await stripeLib.validateKey(secretKey);
      if (!result.ok) return fail('Stripe key validation failed: ' + result.error);

      await db.run(
        `INSERT INTO stripe_settings (id, secret_key, publishable_key, account_id, connected_at)
         VALUES (1, ?, ?, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET secret_key = excluded.secret_key,
           publishable_key = excluded.publishable_key, connected_at = excluded.connected_at`,
        secretKey,
        publishableKey,
        lib.nowIso()
      );
      res.redirect('/owner?stripe=connected');
    })
  );

  return r;
};
