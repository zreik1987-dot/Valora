'use strict';

// Stripe API access. All calls happen server-side; the secret key never
// leaves this process. Validation uses GET /v1/balance — never /v1/account.

const crypto = require('crypto');

const API = 'https://api.stripe.com/v1';

// Validate a restricted secret key against GET /v1/balance.
// Accepts: HTTP 200, or HTTP 403 with code "more_permissions_required"
// (a valid scoped key). Rejects: 401, invalid_request_error, anything else.
async function validateKey(secretKey) {
  let res;
  try {
    res = await fetch(`${API}/balance`, {
      headers: { Authorization: 'Bearer ' + secretKey },
    });
  } catch (e) {
    return { ok: false, error: 'Could not reach Stripe: ' + e.message };
  }
  if (res.status === 200) return { ok: true };
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  const err = body && body.error;
  const code = err && err.code;
  if (res.status === 403 && code === 'more_permissions_required') {
    return { ok: true, limited: true };
  }
  if (res.status === 401 || code === 'invalid_request_error' || code === 'api_key_expired') {
    return { ok: false, error: (err && err.message) || 'Invalid API key.' };
  }
  return { ok: false, error: (err && err.message) || `Stripe returned status ${res.status}` };
}

async function createPaymentIntent(secretKey, amountCents, description) {
  const params = new URLSearchParams();
  params.append('amount', String(amountCents));
  params.append('currency', 'usd');
  params.append('automatic_payment_methods[enabled]', 'true');
  params.append('automatic_payment_methods[allow_redirects]', 'never'); // on-page flow only
  if (description) params.append('description', description);
  let res;
  try {
    res = await fetch(`${API}/payment_intents`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
  } catch (e) {
    throw new Error('Could not reach Stripe: ' + e.message);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body.error && body.error.message) || 'Stripe PaymentIntent creation failed');
  }
  return body; // { id, client_secret, status, ... }
}

async function retrievePaymentIntent(secretKey, id) {
  let res;
  try {
    res = await fetch(`${API}/payment_intents/` + encodeURIComponent(id), {
      headers: { Authorization: 'Bearer ' + secretKey },
    });
  } catch (e) {
    throw new Error('Could not reach Stripe: ' + e.message);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body.error && body.error.message) || 'Stripe lookup failed');
  }
  return body;
}

// Confirm a PaymentIntent server-side with a collected payment method.
// The browser only collects card details (Payment Element) and handles
// 3-D Secure actions; the secret key and the confirmation stay server-side.
async function confirmPaymentIntent(secretKey, id, paymentMethodId) {
  const params = new URLSearchParams();
  params.append('payment_method', paymentMethodId);
  let res;
  try {
    res = await fetch(`${API}/payment_intents/` + encodeURIComponent(id) + '/confirm', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
  } catch (e) {
    throw new Error('Could not reach Stripe: ' + e.message);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body.error && body.error.message) || 'Stripe payment confirmation failed');
  }
  return body; // { id, status, client_secret, ... }
}

function verifyWebhookSignature(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = {};
  for (const p of String(header).split(',')) {
    const i = p.indexOf('=');
    if (i > 0) parts[p.slice(0, i)] = p.slice(i + 1);
  }
  if (!parts.t || !parts.v1) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(parts.t + '.' + payload)
    .digest('hex');
  const a = Buffer.from(parts.v1);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { validateKey, createPaymentIntent, retrievePaymentIntent, confirmPaymentIntent, verifyWebhookSignature };
