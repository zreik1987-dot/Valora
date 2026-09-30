# Valora — Trade Almost Anything

The production trade marketplace for **Valora** (https://tradevalora.com).
People list items, others offer trades (another item + optional cash on top),
and Valora collects a **5% platform fee** on the cash portion of every completed trade.

## Stack

- Node.js + Express, server-rendered with EJS (no frontend build step)
- SQLite via better-sqlite3 (single file)
- bcryptjs (cost 12), helmet, multer for photo uploads
- Stripe Payment Element for fee collection (server-side PaymentIntents)

## Install

```bash
npm install
```

## Configure

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | **yes** | 32+ random characters. Generate with `openssl rand -hex 32`. |
| `OWNER_EMAIL` | yes (first boot) | Email of the single owner account, created via the one-time `/setup` flow. |
| `SETUP_TOKEN` | yes (first boot) | Long random token guarding the one-time `/setup` page. Generate with `openssl rand -hex 32`. |
| `PORT` | no | Default `3000`. |
| `DB_PATH` | no | Default `./data/valora.db`. |
| `UPLOAD_DIR` | no | Default `./data/uploads`. |
| `NODE_ENV` | no | Set `production` to enable `Secure` session cookies + HTTPS assumptions. |
| `STRIPE_WEBHOOK_SECRET` | no | Enables Stripe webhook signature verification. |

## Run

```bash
# initialize the database (also happens automatically on boot)
npm run init

# start the server
npm start
```

Then open http://localhost:3000.

### First boot — create the owner account

1. Start the server with `OWNER_EMAIL` and `SETUP_TOKEN` set.
2. Visit `http://localhost:3000/setup?token=<SETUP_TOKEN>`.
3. Fill in the owner account form (email must match `OWNER_EMAIL`).
4. The `/setup` route is permanently disabled after the owner is created.
   There is no other way to become owner — no promotion endpoint, no "first user becomes owner".

### Connect Stripe (owner only)

1. Log in as the owner, open **Owner** in the nav.
2. Paste the Stripe **restricted secret key** + **publishable key**.
3. The key is validated live against `GET /v1/balance` (accepts HTTP 200, or
   403 `more_permissions_required` for scoped keys; rejects 401). Never `/v1/account`.
4. Keys are stored server-side only and never rendered into HTML/JS.

## Tests

```bash
npm test
```

Covers: fee math (including $0 cash), duplicate-offer rejection, accept-offer
locking (listing locked, other offers declined, trade + ledger created),
owner-only route protection, one-time setup flow, CSRF rejection, session
cookie flags (`HttpOnly`, `SameSite=Lax`, `Secure` in production), login
lockout, Stripe key validation (mocked), and the server-side fee payment
flow including 3-D Secure `requires_action` handling (mocked).

## Deploy to Fly.io

```bash
# 1. Install the Fly CLI and log in
curl -L https://fly.io/install.sh | sh
fly auth login

# 2. Create the app (accept defaults; the included fly.toml configures it)
fly launch --no-deploy

# 3. Create the persistent volume for SQLite + uploads (do this once per region)
fly volumes create valora_data --region ord --size 1

# 4. Set secrets (never commit these)
fly secrets set SESSION_SECRET="$(openssl rand -hex 32)"
fly secrets set OWNER_EMAIL="zreik1987@gmail.com"
fly secrets set SETUP_TOKEN="$(openssl rand -hex 32)"
# optional:
fly secrets set STRIPE_WEBHOOK_SECRET="whsec_..."

# 5. Deploy
fly deploy

# 6. Point tradevalora.com at the app
fly certs add tradevalora.com
# then add the DNS records Fly shows you at your registrar (Porkbun)

# If the app name "valora-prod" is already taken on Fly, pick another name
# (e.g. fly apps create tradevalora) and update the `app = "..."` line in fly.toml.
```

After deploy, create the owner account once at
`https://tradevalora.com/setup?token=<SETUP_TOKEN>`.

## Security notes

- Sessions: random 256-bit tokens stored as SHA-256 hashes; `HttpOnly`,
  `Secure` (production), `SameSite=Lax` cookies; 30-day sliding expiry;
  rotated on login, revoked on logout. Tokens are never in localStorage.
- CSRF synchronizer tokens on every POST (HMAC-bound to the session).
- Login lockout: 5 failed attempts → 15-minute lockout per account + IP.
- Rate limits: 100 req/min per IP globally, 10/min on login/signup.
- All user content is HTML-escaped; security headers via helmet.
