'use strict';

// Valora production test suite: business rules, auth/security, Stripe validation.
// Run with: npm test
//
// Tests run against pg-mem (an in-memory Postgres) so no database server is
// needed. The app code itself speaks real Postgres wire protocol.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const pgLocal = require('./pg-local');

const { createApp } = require('../src/app');
const { feeFor } = require('../src/lib');
const stripeLib = require('../src/stripe');

const SECRET = 'test-session-secret-0123456789abcdef-zz';
const OWNER_EMAIL = 'owner@valora.test';
const SETUP_TOKEN = 'setup-token-abcdef-12345';

let ctx; // { app, db, resetRateLimits }

async function makeCtx(dbName, overrides = {}) {
  await pgLocal.resetDatabase(dbName);
  return createApp({
    databaseUrl: pgLocal.databaseUrl(dbName),
    sessionSecret: SECRET,
    ownerEmail: overrides.ownerEmail !== undefined ? overrides.ownerEmail : OWNER_EMAIL,
    setupToken: overrides.setupToken !== undefined ? overrides.setupToken : SETUP_TOKEN,
  });
}

before(async () => {
  await pgLocal.ensureRunning();
  ctx = await makeCtx('valora_test');
});

after(async () => {
  await ctx.db.close();
  await pgLocal.stop();
});

beforeEach(async () => {
  ctx.resetRateLimits();
  await ctx.db.run('DELETE FROM login_attempts');
});

// ---------- helpers ----------

async function csrfFor(agent, url) {
  const res = await agent.get(url);
  assert.equal(res.status, 200, `GET ${url} should be 200`);
  const m = res.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(m, `CSRF token found on ${url}`);
  return m[1];
}

let userSeq = 0;
async function signup(agent, overrides = {}) {
  userSeq += 1;
  const username = overrides.username || `trader${userSeq}`;
  const email = overrides.email || `${username}@valora.test`;
  const t = await csrfFor(agent, '/signup');
  const res = await agent
    .post('/signup')
    .type('form')
    .send({
      _csrf: t,
      username,
      display_name: overrides.display_name || username,
      email,
      password: overrides.password || 'password123',
    });
  assert.equal(res.status, 302, 'signup should redirect');
  return { agent, username, email };
}

async function login(agent, email, password) {
  const t = await csrfFor(agent, '/login');
  return agent.post('/login').type('form').send({ _csrf: t, email, password });
}

async function createListing(agent, overrides = {}) {
  const t = await csrfFor(agent, '/listings/new');
  const res = await agent
    .post('/listings')
    .type('form')
    .send({
      _csrf: t,
      title: overrides.title || 'Vintage road bike',
      description: overrides.description || 'A well-kept road bike, ridden for two seasons.',
      category: overrides.category || 'Other',
      condition: overrides.condition || 'used',
      price_estimate: overrides.price_estimate || '300',
    });
  assert.equal(res.status, 302, 'listing creation should redirect');
  const id = res.headers.location.split('/').pop();
  return Number(id);
}

async function postOffer(agent, listingId, token, overrides = {}) {
  return agent
    .post(`/listings/${listingId}/offer`)
    .type('form')
    .send({
      _csrf: token,
      item_title: overrides.item_title || 'Acoustic guitar',
      item_description: overrides.item_description || 'Six-string acoustic, great tone, with soft case.',
      item_condition: overrides.item_condition || 'used',
      cash_on_top: overrides.cash_on_top !== undefined ? overrides.cash_on_top : '50',
    });
}

async function makeOffer(agent, listingId, overrides = {}) {
  const t = await csrfFor(agent, `/listings/${listingId}/offer`);
  return postOffer(agent, listingId, t, overrides);
}

// CSRF token from any logged-in page (tokens are bound to the session, not the page).
async function dashboardCsrf(agent) {
  return csrfFor(agent, '/dashboard');
}

// ---------- fee math ----------

describe('fee math', () => {
  it('computes 5% of cash on top, rounded to the nearest cent', () => {
    assert.equal(feeFor(1000), 50); // $10.00 -> $0.50
    assert.equal(feeFor(20000), 1000); // $200.00 -> $10.00
    assert.equal(feeFor(333), 17); // $3.33 -> $0.1665 -> $0.17
    assert.equal(feeFor(10), 1); // $0.10 -> $0.005 -> $0.01
    assert.equal(feeFor(1), 0); // $0.01 -> $0.0005 -> $0.00
  });

  it('is zero when cash on top is zero', () => {
    assert.equal(feeFor(0), 0);
  });
});

// ---------- owner setup & owner-only routes ----------

describe('owner setup and owner-only routes', () => {
  it('rejects /setup without the setup token', async () => {
    const res = await request(ctx.app).get('/setup');
    assert.equal(res.status, 404);
  });

  it('rejects /setup with a wrong token', async () => {
    const res = await request(ctx.app).get('/setup?token=wrong');
    assert.equal(res.status, 404);
  });

  it('creates the owner exactly once via the one-time setup flow', async () => {
    const agent = request.agent(ctx.app);
    const t = await csrfFor(agent, `/setup?token=${SETUP_TOKEN}`);
    const res = await agent
      .post('/setup')
      .type('form')
      .send({
        _csrf: t,
        token: SETUP_TOKEN,
        username: 'zrek',
        display_name: 'Zrek',
        email: OWNER_EMAIL,
        password: 'ownerpass123',
      });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/owner/);

    const owner = await ctx.db.get('SELECT * FROM members WHERE email = ?', OWNER_EMAIL);
    assert.ok(owner);
    assert.equal(owner.is_owner, 1);

    // Second setup attempt is permanently disabled.
    const res2 = await request(ctx.app).get(`/setup?token=${SETUP_TOKEN}`);
    assert.equal(res2.status, 404);
    const t2agent = request.agent(ctx.app);
    const t2 = await csrfFor(t2agent, '/login'); // setup page no longer renders; use login CSRF
    const res3 = await t2agent
      .post('/setup')
      .type('form')
      .send({ _csrf: t2, token: SETUP_TOKEN, username: 'evil', display_name: 'Evil', email: OWNER_EMAIL, password: 'password123' });
    assert.equal(res3.status, 404);
  });

  it('lets the owner view /owner but forbids regular members', async () => {
    const ownerAgent = request.agent(ctx.app);
    await login(ownerAgent, OWNER_EMAIL, 'ownerpass123');

    const user = await signup(request.agent(ctx.app));

    const ownerRes = await ownerAgent.get('/owner');
    assert.equal(ownerRes.status, 200);
    assert.match(ownerRes.text, /Owner admin/);
    // Secret keys must never be rendered into the page (the input placeholder
    // contains only a short "rk_live_…" hint, not a real key).
    assert.doesNotMatch(ownerRes.text, /rk_live_[A-Za-z0-9]{8,}|sk_live_[A-Za-z0-9]{8,}/);

    const userRes = await user.agent.get('/owner');
    assert.equal(userRes.status, 403);

    const anonRes = await request(ctx.app).get('/owner');
    assert.equal(anonRes.status, 302); // redirected to login

    // Non-owner cannot save Stripe settings either.
    const t = await csrfFor(user.agent, '/dashboard');
    const postRes = await user.agent
      .post('/owner/stripe')
      .type('form')
      .send({ _csrf: t, secret_key: 'rk_live_x', publishable_key: 'pk_live_x' });
    assert.equal(postRes.status, 403);
  });

  it('never grants owner through signup (no mass assignment)', async () => {
    const agent = request.agent(ctx.app);
    const t = await csrfFor(agent, '/signup');
    const res = await agent
      .post('/signup')
      .type('form')
      .send({
        _csrf: t,
        username: 'sneaky99',
        display_name: 'Sneaky',
        email: 'sneaky@valora.test',
        password: 'password123',
        is_owner: '1',
        isOwner: 'true',
      });
    assert.equal(res.status, 302);
    const row = await ctx.db.get('SELECT is_owner FROM members WHERE email = ?', 'sneaky@valora.test');
    assert.equal(row.is_owner, 0);
    const owners = await ctx.db.get('SELECT COUNT(*) AS c FROM members WHERE is_owner = 1');
    assert.equal(Number(owners.c), 1, 'exactly one owner exists');
  });
});

// ---------- auth, sessions, CSRF ----------

describe('auth and sessions', () => {
  it('validates signup input', async () => {
    const agent = request.agent(ctx.app);
    const t = await csrfFor(agent, '/signup');
    const badUser = await agent.post('/signup').type('form').send({
      _csrf: t, username: 'ab', display_name: 'X', email: 'x@valora.test', password: 'password123',
    });
    assert.equal(badUser.status, 400);

    const t2 = await csrfFor(agent, '/signup');
    const badPass = await agent.post('/signup').type('form').send({
      _csrf: t2, username: 'validuser1', display_name: 'V', email: 'v@valora.test', password: 'short',
    });
    assert.equal(badPass.status, 400);
  });

  it('sets a session cookie with HttpOnly and SameSite=Lax flags', async () => {
    const creator = request.agent(ctx.app);
    const { email } = await signup(creator); // signup logs the creator in
    const agent = request.agent(ctx.app); // fresh agent: not logged in yet
    const res = await login(agent, email, 'password123');
    assert.equal(res.status, 302);
    const cookies = res.headers['set-cookie'].join('; ');
    assert.match(cookies, /valora_session=/);
    assert.match(cookies, /HttpOnly/i);
    assert.match(cookies, /SameSite=Lax/i);
  });

  it('sets the Secure flag on the session cookie in production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let prodCtx;
    try {
      prodCtx = await makeCtx('valora_test_prod');
      const agent = request.agent(prodCtx.app);
      const getRes = await agent.get('/signup');
      assert.equal(getRes.status, 200);
      const t = getRes.text.match(/name="_csrf" value="([^"]+)"/)[1];
      userSeq += 1;
      // The Secure valora_csrf cookie is not sent back over plain HTTP by the
      // cookie jar, so attach it manually (production always runs behind HTTPS).
      // The signup response itself sets the session cookie — check its flags directly.
      const res = await agent.post('/signup')
        .set('Cookie', `valora_csrf=${encodeURIComponent(t)}`)
        .type('form').send({
          _csrf: t,
          username: `secureuser${userSeq}`,
          display_name: 'Secure User',
          email: `secureuser${userSeq}@valora.test`,
          password: 'password123',
        });
      assert.equal(res.status, 302);
      const cookies = res.headers['set-cookie'].join('; ');
      assert.match(cookies, /valora_session=/);
      assert.match(cookies, /Secure/i);
      assert.match(cookies, /HttpOnly/i);
      await prodCtx.db.close();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('rejects POSTs without a CSRF token', async () => {
    const noToken = await request(ctx.app).post('/login').type('form').send({
      email: 'x@valora.test', password: 'whatever',
    });
    assert.equal(noToken.status, 403);

    const agent = request.agent(ctx.app);
    await signup(agent);
    const noTokenAuthed = await agent.post('/logout').type('form').send({});
    assert.equal(noTokenAuthed.status, 403);

    const t = await csrfFor(agent, '/listings/new');
    const badToken = await agent.post('/listings').type('form').send({
      _csrf: 'wrong-token',
      title: 'Test item', description: 'A description long enough.', category: 'Other', condition: 'used',
    });
    assert.equal(badToken.status, 403);
  });

  it('locks out an account after 5 failed logins (account + IP)', async () => {
    const creator = request.agent(ctx.app);
    const { email } = await signup(creator); // signup logs the creator in
    const agent = request.agent(ctx.app); // fresh agent: not logged in
    for (let i = 0; i < 5; i++) {
      const t = await csrfFor(agent, '/login');
      const res = await agent.post('/login').type('form').send({ _csrf: t, email, password: 'wrongpass' });
      assert.equal(res.status, 401);
    }
    const t = await csrfFor(agent, '/login');
    const locked = await agent.post('/login').type('form').send({ _csrf: t, email, password: 'password123' });
    assert.equal(locked.status, 429);
    assert.match(locked.text, /15 minutes/);
  });

  it('revokes the session on logout', async () => {
    const agent = request.agent(ctx.app);
    await signup(agent);
    const dash1 = await agent.get('/dashboard');
    assert.equal(dash1.status, 200);
    const t = await csrfFor(agent, '/dashboard');
    const logout = await agent.post('/logout').type('form').send({ _csrf: t });
    assert.equal(logout.status, 302);
    const dash2 = await agent.get('/dashboard');
    assert.equal(dash2.status, 302); // back to login
    assert.match(dash2.headers.location, /\/login/);
  });
});

// ---------- listings, offers, trades ----------

describe('listings and offers', () => {
  it('creates a listing and shows it publicly', async () => {
    const agent = request.agent(ctx.app);
    await signup(agent);
    const id = await createListing(agent, { title: 'DeWalt drill set' });
    const page = await request(ctx.app).get(`/listings/${id}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /DeWalt drill set/);
    const home = await request(ctx.app).get('/');
    assert.match(home.text, /DeWalt drill set/);
  });

  it('rejects a duplicate pending offer from the same member', async () => {
    const seller = request.agent(ctx.app);
    await signup(seller);
    const listingId = await createListing(seller);

    const buyer = request.agent(ctx.app);
    await signup(buyer);

    const first = await makeOffer(buyer, listingId);
    assert.equal(first.status, 302);

    // The offer form itself now 400s (a pending offer exists), so grab the
    // CSRF token from the dashboard instead.
    const t = await csrfFor(buyer, '/dashboard');
    const second = await buyer.post(`/listings/${listingId}/offer`).type('form').send({
      _csrf: t,
      item_title: 'Another guitar',
      item_description: 'A second attempt at an offer.',
      item_condition: 'used',
      cash_on_top: '10',
    });
    assert.equal(second.status, 400);
    assert.match(second.text, /already have a pending offer/);

    const count = await ctx.db.get(
      'SELECT COUNT(*) AS c FROM offers WHERE listing_id = ? AND status = ?',
      listingId, 'pending'
    );
    assert.equal(Number(count.c), 1);
  });

  it('forbids offers on your own listing', async () => {
    const agent = request.agent(ctx.app);
    await signup(agent);
    const listingId = await createListing(agent);
    const t = await dashboardCsrf(agent);
    const res = await postOffer(agent, listingId, t, {});
    assert.equal(res.status, 400);
    assert.match(res.text, /own listing/);
  });

  it('locks the listing on accept: other offers declined, trade + ledger created', async () => {
    const seller = request.agent(ctx.app);
    await signup(seller);
    const listingId = await createListing(seller, { title: 'Leather sofa' });

    const buyerA = request.agent(ctx.app);
    await signup(buyerA);
    const buyerB = request.agent(ctx.app);
    await signup(buyerB);

    const rA = await makeOffer(buyerA, listingId, { cash_on_top: '100', item_title: 'Coffee table' });
    assert.equal(rA.status, 302);
    const rB = await makeOffer(buyerB, listingId, { cash_on_top: '40', item_title: 'Floor lamp' });
    assert.equal(rB.status, 302);

    const offerA = await ctx.db.get(
      'SELECT * FROM offers WHERE listing_id = ? AND item_title = ?',
      listingId, 'Coffee table'
    );
    const offerB = await ctx.db.get(
      'SELECT * FROM offers WHERE listing_id = ? AND item_title = ?',
      listingId, 'Floor lamp'
    );

    const t = await csrfFor(seller, '/dashboard');
    const accept = await seller.post(`/offers/${offerA.id}/accept`).type('form').send({ _csrf: t });
    assert.equal(accept.status, 302);

    const listing = await ctx.db.get('SELECT status FROM listings WHERE id = ?', listingId);
    assert.equal(listing.status, 'traded');

    assert.equal((await ctx.db.get('SELECT status FROM offers WHERE id = ?', offerA.id)).status, 'accepted');
    assert.equal((await ctx.db.get('SELECT status FROM offers WHERE id = ?', offerB.id)).status, 'declined');

    const trade = await ctx.db.get('SELECT * FROM trades WHERE listing_id = ?', listingId);
    assert.ok(trade);
    assert.equal(trade.cash_on_top_cents, 10000);
    assert.equal(trade.fee_cents, 500); // 5% of $100

    const ledger = await ctx.db.get('SELECT * FROM fee_ledger WHERE trade_id = ?', trade.id);
    assert.ok(ledger);
    assert.equal(ledger.amount_cents, 500);
    assert.equal(ledger.status, 'unpaid'); // Stripe not connected in tests

    // The listing is locked: no new offers, no second accept.
    const tLate = await dashboardCsrf(buyerB);
    const lateOffer = await postOffer(buyerB, listingId, tLate, { item_title: 'Late chair' });
    assert.equal(lateOffer.status, 400);

    const t2 = await csrfFor(seller, '/dashboard');
    const acceptAgain = await seller.post(`/offers/${offerA.id}/accept`).type('form').send({ _csrf: t2 });
    assert.equal(acceptAgain.status, 400);
  });

  it('completes a $0-cash trade with a $0 fee marked paid', async () => {
    const seller = request.agent(ctx.app);
    await signup(seller);
    const listingId = await createListing(seller, { title: 'Paperback novels' });
    const buyer = request.agent(ctx.app);
    await signup(buyer);
    const r = await makeOffer(buyer, listingId, { cash_on_top: '0', item_title: 'Board game' });
    assert.equal(r.status, 302);

    const offer = await ctx.db.get('SELECT * FROM offers WHERE listing_id = ?', listingId);
    const t = await csrfFor(seller, '/dashboard');
    const accept = await seller.post(`/offers/${offer.id}/accept`).type('form').send({ _csrf: t });
    assert.equal(accept.status, 302);

    const trade = await ctx.db.get('SELECT * FROM trades WHERE listing_id = ?', listingId);
    assert.equal(trade.fee_cents, 0);
    const ledger = await ctx.db.get('SELECT * FROM fee_ledger WHERE trade_id = ?', trade.id);
    assert.equal(ledger.amount_cents, 0);
    assert.equal(ledger.status, 'paid');
  });

  it('lets the offer maker withdraw and the listing owner decline', async () => {
    const seller = request.agent(ctx.app);
    await signup(seller);
    const listingId = await createListing(seller, { title: 'Camping tent' });
    const buyer = request.agent(ctx.app);
    await signup(buyer);

    await makeOffer(buyer, listingId, { item_title: 'Sleeping bag' });
    const offer = await ctx.db.get('SELECT * FROM offers WHERE listing_id = ?', listingId);

    const t1 = await csrfFor(buyer, '/dashboard');
    const withdraw = await buyer.post(`/offers/${offer.id}/withdraw`).type('form').send({ _csrf: t1 });
    assert.equal(withdraw.status, 302);
    assert.equal((await ctx.db.get('SELECT status FROM offers WHERE id = ?', offer.id)).status, 'withdrawn');

    // After withdrawing, the buyer may offer again.
    const again = await makeOffer(buyer, listingId, { item_title: 'Lantern' });
    assert.equal(again.status, 302);
    const offer2 = await ctx.db.get(
      'SELECT * FROM offers WHERE listing_id = ? AND status = ?',
      listingId, 'pending'
    );

    const t2 = await csrfFor(seller, '/dashboard');
    const decline = await seller.post(`/offers/${offer2.id}/decline`).type('form').send({ _csrf: t2 });
    assert.equal(decline.status, 302);
    assert.equal((await ctx.db.get('SELECT status FROM offers WHERE id = ?', offer2.id)).status, 'declined');
  });

  it('forbids non-owners from accepting offers', async () => {
    const seller = request.agent(ctx.app);
    await signup(seller);
    const listingId = await createListing(seller, { title: 'Bike helmet' });
    const buyer = request.agent(ctx.app);
    await signup(buyer);
    const stranger = request.agent(ctx.app);
    await signup(stranger);

    await makeOffer(buyer, listingId, { item_title: 'Gloves' });
    const offer = await ctx.db.get('SELECT * FROM offers WHERE listing_id = ?', listingId);

    const t = await csrfFor(stranger, '/dashboard');
    const res = await stranger.post(`/offers/${offer.id}/accept`).type('form').send({ _csrf: t });
    assert.equal(res.status, 403);
    assert.equal((await ctx.db.get('SELECT status FROM offers WHERE id = ?', offer.id)).status, 'pending');
  });

  it('lets the listing owner remove an active listing', async () => {
    const agent = request.agent(ctx.app);
    await signup(agent);
    const listingId = await createListing(agent, { title: 'Old monitor' });
    const t = await csrfFor(agent, '/dashboard');
    const res = await agent.post(`/listings/${listingId}/remove`).type('form').send({ _csrf: t });
    assert.equal(res.status, 302);
    assert.equal((await ctx.db.get('SELECT status FROM listings WHERE id = ?', listingId)).status, 'removed');

    const buyer = request.agent(ctx.app);
    await signup(buyer);
    const tBuy = await dashboardCsrf(buyer);
    const offer = await postOffer(buyer, listingId, tBuy, { item_title: 'Keyboard' });
    assert.equal(offer.status, 400);
  });

  it('stores listing photos in the database and serves them back', async () => {
    const agent = request.agent(ctx.app);
    await signup(agent);
    const t = await csrfFor(agent, '/listings/new');
    // Minimal valid PNG (1x1 pixel).
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const res = await agent
      .post('/listings')
      .set('Cookie', `valora_csrf=${encodeURIComponent(t)}`)
      .field('_csrf', t)
      .field('title', 'Camera with photo')
      .field('description', 'A camera listing that includes an uploaded photo.')
      .field('category', 'Other')
      .field('condition', 'used')
      .field('price_estimate', '50')
      .attach('photos', png, { filename: 'tiny.png', contentType: 'image/png' });
    assert.equal(res.status, 302, 'listing with photo should redirect');
    const listingId = Number(res.headers.location.split('/').pop());

    const photo = await ctx.db.get(
      'SELECT filename, content_type, data FROM listing_photos WHERE listing_id = ?',
      listingId
    );
    assert.ok(photo, 'photo row exists in Postgres');
    assert.equal(photo.content_type, 'image/png');
    assert.ok(Buffer.isBuffer(photo.data) || photo.data instanceof Uint8Array, 'photo bytes stored');
    assert.ok(photo.data.length > 0);

    const served = await request(ctx.app).get(`/uploads/${photo.filename}`);
    assert.equal(served.status, 200);
    assert.match(served.headers['content-type'], /image\/png/);
    assert.ok(served.body.length > 0, 'photo bytes served');

    const page = await request(ctx.app).get(`/listings/${listingId}`);
    assert.equal(page.status, 200);
    assert.match(page.text, new RegExp(`/uploads/${photo.filename}`));
  });
});

// ---------- Stripe validation ----------

describe('Stripe key validation', () => {
  const realFetch = global.fetch;
  after(() => {
    global.fetch = realFetch;
  });

  it('accepts HTTP 200 from /v1/balance', async () => {
    let calledUrl = null;
    global.fetch = async (url) => {
      calledUrl = url;
      return { status: 200, ok: true, json: async () => ({ object: 'balance' }) };
    };
    const result = await stripeLib.validateKey('rk_live_test');
    assert.equal(result.ok, true);
    assert.match(calledUrl, /\/v1\/balance/);
    assert.doesNotMatch(calledUrl, /\/v1\/account/);
  });

  it('accepts 403 more_permissions_required (valid scoped restricted key)', async () => {
    global.fetch = async () => ({
      status: 403,
      ok: false,
      json: async () => ({ error: { code: 'more_permissions_required', message: 'scoped' } }),
    });
    const result = await stripeLib.validateKey('rk_live_scoped');
    assert.equal(result.ok, true);
  });

  it('rejects 401 unauthorized', async () => {
    global.fetch = async () => ({
      status: 401,
      ok: false,
      json: async () => ({ error: { code: 'invalid_request_error', message: 'Invalid API Key' } }),
    });
    const result = await stripeLib.validateKey('rk_live_bad');
    assert.equal(result.ok, false);
  });

  it('saves validated keys via /owner/stripe and never renders the secret', async () => {
    global.fetch = async () => ({ status: 200, ok: true, json: async () => ({ object: 'balance' }) });
    const ownerAgent = request.agent(ctx.app);
    await login(ownerAgent, OWNER_EMAIL, 'ownerpass123');
    const t = await csrfFor(ownerAgent, '/owner');
    const res = await ownerAgent
      .post('/owner/stripe')
      .type('form')
      .send({ _csrf: t, secret_key: 'rk_live_abc123', publishable_key: 'pk_live_xyz' });
    assert.equal(res.status, 302);

    const settings = await ctx.db.get('SELECT * FROM stripe_settings WHERE id = 1');
    assert.equal(settings.secret_key, 'rk_live_abc123');

    const page = await ownerAgent.get('/owner');
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /rk_live_abc123/);
    assert.match(page.text, /Connected/);
  });

  it('rejects an invalid key via /owner/stripe without saving', async () => {
    global.fetch = async () => ({
      status: 401,
      ok: false,
      json: async () => ({ error: { code: 'invalid_request_error', message: 'Invalid API Key provided' } }),
    });
    const ownerAgent = request.agent(ctx.app);
    await login(ownerAgent, OWNER_EMAIL, 'ownerpass123');
    const t = await csrfFor(ownerAgent, '/owner');
    const res = await ownerAgent
      .post('/owner/stripe')
      .type('form')
      .send({ _csrf: t, secret_key: 'rk_live_wrong', publishable_key: 'pk_live_xyz' });
    assert.equal(res.status, 400);
    const settings = await ctx.db.get('SELECT * FROM stripe_settings WHERE id = 1');
    assert.notEqual(settings.secret_key, 'rk_live_wrong');
  });
});

// ---------- fee payment flow (server-side confirmation) ----------

describe('fee payment flow', () => {
  // Build a completed trade with a $10 cash top-up (fee $0.50).
  async function tradeWithFee() {
    const seller = request.agent(ctx.app);
    await signup(seller);
    const listingId = await createListing(seller);
    const buyer = request.agent(ctx.app);
    await signup(buyer);
    await makeOffer(buyer, listingId, { cash_on_top: '10' });
    const offerId = (await ctx.db.get('SELECT id FROM offers WHERE listing_id = ?', listingId)).id;
    const t = await csrfFor(seller, '/dashboard');
    const acc = await seller.post(`/offers/${offerId}/accept`).type('form').send({ _csrf: t });
    assert.equal(acc.status, 302);
    const trade = await ctx.db.get('SELECT * FROM trades WHERE listing_id = ?', listingId);
    assert.equal(trade.fee_cents, 50);
    return { seller, buyer, tradeId: trade.id };
  }

  async function saveStripeKeys() {
    global.fetch = async () => ({ status: 200, ok: true, json: async () => ({ object: 'balance' }) });
    const ownerAgent = request.agent(ctx.app);
    await login(ownerAgent, OWNER_EMAIL, 'ownerpass123');
    const t = await csrfFor(ownerAgent, '/owner');
    const res = await ownerAgent
      .post('/owner/stripe')
      .type('form')
      .send({ _csrf: t, secret_key: 'rk_live_paytest', publishable_key: 'pk_live_paytest' });
    assert.equal(res.status, 302);
  }

  it('rejects payment confirmation when Stripe is not connected', async () => {
    const { buyer, tradeId } = await tradeWithFee();
    const t = await csrfFor(buyer, '/dashboard');
    const res = await buyer
      .post(`/trades/${tradeId}/pay/confirm`)
      .set('Accept', 'application/json')
      .send({ _csrf: t, payment_method: 'pm_test_123' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not connected/);
  });

  it('completes payment via server-side confirmation (mocked Stripe)', async () => {
    await saveStripeKeys();
    const { buyer, tradeId } = await tradeWithFee();
    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = (opts.method || 'GET').toUpperCase();
      if (u.endsWith('/v1/payment_intents') && method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'pi_test_ok', client_secret: 'cs_test_ok', status: 'requires_payment_method' }),
        };
      }
      if (u.includes('/payment_intents/pi_test_ok/confirm')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'pi_test_ok', status: 'succeeded' }),
        };
      }
      throw new Error('unexpected Stripe call: ' + method + ' ' + u);
    };
    const page = await buyer.get(`/trades/${tradeId}/pay`);
    assert.equal(page.status, 200);
    assert.match(page.text, /pk_live_paytest/); // publishable key present…
    assert.doesNotMatch(page.text, /rk_live_paytest/); // …secret key never rendered
    const t = await csrfFor(buyer, '/dashboard');
    const res = await buyer
      .post(`/trades/${tradeId}/pay/confirm`)
      .set('Accept', 'application/json')
      .send({ _csrf: t, payment_method: 'pm_1TestCard123' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const ledger = await ctx.db.get('SELECT * FROM fee_ledger WHERE trade_id = ?', tradeId);
    assert.equal(ledger.status, 'paid');
    assert.equal(ledger.stripe_payment_intent_id, 'pi_test_ok');
  });

  it('handles requires_action via finalize (mocked Stripe)', async () => {
    await saveStripeKeys();
    const { buyer, tradeId } = await tradeWithFee();
    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = (opts.method || 'GET').toUpperCase();
      if (u.endsWith('/v1/payment_intents') && method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'pi_test_3ds', client_secret: 'cs_test_3ds', status: 'requires_payment_method' }),
        };
      }
      if (u.includes('/payment_intents/pi_test_3ds/confirm')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'pi_test_3ds', status: 'requires_action', client_secret: 'cs_test_3ds' }),
        };
      }
      if (u.includes('/payment_intents/pi_test_3ds') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'pi_test_3ds', status: 'succeeded' }),
        };
      }
      throw new Error('unexpected Stripe call: ' + method + ' ' + u);
    };
    const page = await buyer.get(`/trades/${tradeId}/pay`);
    assert.equal(page.status, 200);
    const t = await csrfFor(buyer, '/dashboard');
    const conf = await buyer
      .post(`/trades/${tradeId}/pay/confirm`)
      .set('Accept', 'application/json')
      .send({ _csrf: t, payment_method: 'pm_13dsTest456' });
    assert.equal(conf.status, 200);
    assert.equal(conf.body.requires_action, true);
    const fin = await buyer
      .post(`/trades/${tradeId}/pay/finalize`)
      .set('Accept', 'application/json')
      .send({ _csrf: t });
    assert.equal(fin.status, 200);
    assert.equal(fin.body.ok, true);
    const ledger = await ctx.db.get('SELECT * FROM fee_ledger WHERE trade_id = ?', tradeId);
    assert.equal(ledger.status, 'paid');
  });
});

// ---------- public pages ----------

describe('public pages', () => {
  it('renders home, browse, and about without errors', async () => {
    for (const p of ['/', '/browse', '/about']) {
      const res = await request(ctx.app).get(p);
      assert.equal(res.status, 200, p);
    }
    const home = await request(ctx.app).get('/');
    assert.match(home.text, /Valora/);
    assert.match(home.text, /Trade Almost Anything/);
    assert.match(home.text, /Founded by Zrek/);
    const about = await request(ctx.app).get('/about');
    assert.match(about.text, /5%/);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await request(ctx.app).get('/no-such-page');
    assert.equal(res.status, 404);
  });
});
