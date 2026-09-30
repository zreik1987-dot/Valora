# Valora Production Build — SPEC

## What this is
The public production marketplace for **Valora** ("Trade Almost Anything"), to be deployed at **https://tradevalora.com**.
A trade marketplace: people list items, others offer trades (another item + optional cash on top), and Valora takes a **5% platform fee** on every completed trade.

This is a FRESH production codebase. Build it complete and correct — it must launch without errors.

## Branding (must match)
- Name: **Valora**, tagline "Trade Almost Anything"
- Colors: teal brand `#00a99d` / `#007f78`, ink navy `#071d2b`, background `#f3f8f8`, white surfaces
- Fonts: "DM Serif Display" for display headings, "Manrope" for body (Google Fonts)
- Footer + About page credit: "Founded by Zrek"
- Premium, polished, well-organized. Mobile responsive. No placeholder text anywhere.

## Stack
- Node.js + Express, server-rendered with EJS (no frontend build step)
- PostgreSQL via the `pg` driver (connection from `DATABASE_URL` env); schema auto-created on boot
- bcryptjs for password hashing
- Photo uploads held in memory, then stored as `BYTEA` in Postgres (`listing_photos` / `offer_photos`), served via `/uploads/:filename`; accept only jpg/png/webp/gif, max 5MB each, max 6 per listing/offer
- Single process; listen on `PORT` env (default 3000)
- `render.yaml` for Render deployment (free web service + free Neon Postgres)

## Data model
- **members**: id, username (unique), display_name, email (unique), password_hash, is_owner (boolean, exactly one owner ever), created_at
- **sessions**: id, member_id, token_hash, created_at, expires_at, revoked
- **listings**: id, member_id, title, description, category, condition ('new'|'used'), price_estimate_cents (optional), status ('active'|'traded'|'removed'), created_at
- **listing_photos**: id, listing_id, filename (unique), data (BYTEA), content_type, sort_order
- **offers**: id, listing_id, from_member_id, item_title, item_description, item_condition ('new'|'used'), cash_on_top_cents (>= 0), status ('pending'|'accepted'|'declined'|'withdrawn'), created_at
- **offer_photos**: id, offer_id, filename (unique), data (BYTEA), content_type, sort_order
- **trades**: id, listing_id, offer_id, seller_member_id, buyer_member_id, cash_on_top_cents, fee_cents (5% of cash_on_top_cents, rounded), completed_at, stripe_payment_intent_id (nullable)
- **stripe_settings**: id=1 single row: secret_key (server-side only, NEVER sent to client), publishable_key, account_id, connected_at
- **fee_ledger**: id, trade_id, amount_cents, stripe_payment_intent_id, status, created_at

## Categories
Cars, Tools, Jewelry, Clothes, Home Goods, Other.

## Pages
1. **Home** (`/`): hero with branding, category tiles, newest active listings grid, how-it-works (3 steps), footer
2. **Browse** (`/browse?category=&condition=&q=`): filterable listing grid
3. **Listing detail** (`/listings/:id`): photos, description, condition, owner display name, "Make a trade offer" button (logged in, not own listing)
4. **New listing** (`/listings/new`): form with photos (logged in)
5. **Make offer** (`/listings/:id/offer`): describe your item + photos + cash on top amount (logged in)
6. **Dashboard** (`/dashboard`): my listings, offers I've made, offers received on my listings (accept/decline), my completed trades
7. **Auth**: `/signup`, `/login`, `/logout`
8. **About** (`/about`): what Valora is, how the 5% fee works, Founded by Zrek
9. **Owner admin** (`/owner`): fee ledger table, total fees collected, Stripe settings form (paste restricted key + publishable key, validate + show connected account), recent trades. Owner-only.

## Business rules (enforce server-side, test them)
- Fee = 5% of cash_on_top_cents on trade completion, rounded to nearest cent. If cash_on_top is 0, fee is 0 and trade completes without payment.
- One active (pending) offer per member per listing — reject duplicates.
- Accepting an offer: only the listing owner; sets listing status 'traded', offer 'accepted', all other pending offers on that listing 'declined', creates the trade + fee ledger row.
- Cannot offer on your own listing. Cannot offer on a traded/removed listing.
- Withdrawing: offer maker can withdraw a pending offer.
- Removing: listing owner can remove an active listing (only if no accepted offer).

## Auth & security (production-grade, no shortcuts)
- Passwords: bcryptjs, cost 12. Signup validation: username 3-20 alphanumeric, email valid, password min 8 chars.
- Sessions: random 256-bit token, stored as SHA-256 hash in DB; cookie `valora_session` with `HttpOnly`, `Secure` (when behind HTTPS / `NODE_ENV=production`), `SameSite=Lax`, `Path=/`, 30-day expiry sliding; rotate token on login; revoke on logout; lockout: 5 failed logins → 15-minute lockout per account+IP.
- **NEVER put tokens in localStorage.**
- CSRF: synchronizer token for all POST/PUT/DELETE (render into forms, validate server-side).
- Rate limit: 100 req/min per IP global; stricter on /login and /signup (10/min).
- Owner exclusivity: the owner is seeded ONLY via env `OWNER_EMAIL` through a one-time setup flow (see below). There is NO code path where any other member becomes owner — no "first member becomes owner", no promotion endpoint, no mass-assignment of is_owner. All owner routes check `is_owner` server-side.
- Owner setup: on first boot with no owner in DB, `GET /setup?token=<SETUP_TOKEN env>` shows a one-time form to create the owner account (username, display name, email must match OWNER_EMAIL, password). After creation the setup route is permanently disabled.
- Stripe keys: stored ONLY in the `stripe_settings` DB row, used ONLY server-side. Never render them into HTML/JS. Owner settings page shows only masked status (e.g. "Connected", account id).
- Validate all inputs server-side; escape all rendered user content (EJS default escaping is fine — never use unescaped output for user data).
- Security headers via helmet. No `X-Powered-By`.

## Stripe integration
- Owner pastes restricted secret key + publishable key in `/owner` settings.
- Validation on save: `GET https://api.stripe.com/v1/balance` with the key. Accept HTTP 200, or 403 with code `more_permissions_required` (valid scoped key). Reject on 401 or `invalid_request_error`. Never call `/v1/account` as the validation gate.
- When a trade completes with fee_cents > 0 AND Stripe is connected: create a PaymentIntent server-side for fee_cents (USD) with the buyer's payment method collected via Stripe.js Payment Element on a checkout page (`/trades/:id/pay`). Confirm server-side; record payment_intent id on the trade + fee_ledger; handle failure with a retry page. If Stripe is not connected, the trade still completes and the fee is recorded as unpaid in the ledger (owner collects later).
- Use Stripe.js + Payment Element (publishable key only in the browser).

## Seed & first run
- `npm run init` (or automatic on boot if DB missing): create schema.
- No demo listings, no fake users. The marketplace launches empty; the owner adds the first real listings.

## Quality bar
- Zero placeholder text. Every page works without JS errors.
- Include a test script (`npm test`) covering: fee math (including $0 cash), duplicate-offer rejection, accept-offer locking (other offers declined, listing locked), owner-only route protection, CSRF rejection, session cookie flags.
- README with: install, env vars, how to run, how to deploy to Render.

## Env vars
`PORT`, `DATABASE_URL` (required, Postgres connection string), `SESSION_SECRET` (required, 32+ chars), `OWNER_EMAIL`, `SETUP_TOKEN`, `NODE_ENV`, `STRIPE_WEBHOOK_SECRET` (optional v1).
