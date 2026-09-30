'use strict';

// Valora production marketplace — Express application factory.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const { createDb } = require('./db');
const lib = require('./lib');
const session = require('./session');
const { ah } = lib;

function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  const mw = (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let e = hits.get(key);
    if (!e || now >= e.reset) e = { count: 0, reset: now + windowMs };
    e.count += 1;
    hits.set(key, e);
    if (e.count > max) {
      res.status(429);
      return res.render('error', {
        status: 429,
        message: 'Too many requests. Please slow down and try again shortly.',
      });
    }
    next();
  };
  mw.reset = () => hits.clear();
  return mw;
}

// Wrap async route handlers so rejections reach Express error handling.
const UPLOAD_NAME_RE = /^[a-f0-9]{32}\.(jpg|png|webp|gif)$/;

async function createApp(opts = {}) {
  const cfg = {
    databaseUrl: opts.databaseUrl || process.env.DATABASE_URL,
    sessionSecret: opts.sessionSecret || process.env.SESSION_SECRET,
    ownerEmail: (opts.ownerEmail || process.env.OWNER_EMAIL || '').trim().toLowerCase() || null,
    setupToken: opts.setupToken || process.env.SETUP_TOKEN || null,
    nodeEnv: process.env.NODE_ENV || 'development',
    poolOverride: opts.poolOverride || null,
  };
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET env var is required (32+ characters).');
  }
  if (!cfg.databaseUrl && !cfg.poolOverride) {
    throw new Error('DATABASE_URL env var is required.');
  }

  const db = createDb(cfg.databaseUrl, cfg.poolOverride);
  await db.init();
  const secureCookies = cfg.nodeEnv === 'production';

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://js.stripe.com'],
          frameSrc: ["'self'", 'https://js.stripe.com', 'https://hooks.stripe.com'],
          connectSrc: ["'self'", 'https://api.stripe.com'],
          imgSrc: ["'self'", 'data:', 'https:'],
          styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        },
      },
    })
  );
  app.use(cookieParser());

  // ---- Rate limiters ----
  const globalLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 100 });
  const authLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });
  app.use(globalLimiter);

  // ---- Stripe webhook needs the raw body: mount before the body parsers ----
  const mw = {
    cfg,
    requireAuth,
    requireOwner,
    requireCsrf,
    authLimiter,
    handleUpload,
    discardFiles,
    photoFilename,
  };
  const tradesRoutes = require('./routes/trades')(db, cfg, mw);
  app.post('/stripe/webhook', express.raw({ type: 'application/json' }), tradesRoutes.webhook);

  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(express.json({ limit: '100kb' }));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---- Listing/offer photos, served from Postgres ----
  app.get(
    '/uploads/:filename',
    ah(async (req, res) => {
      const filename = req.params.filename;
      if (!UPLOAD_NAME_RE.test(filename)) return res.status(404).end();
      let photo = await db.get(
        'SELECT data, content_type FROM listing_photos WHERE filename = ?',
        filename
      );
      if (!photo) {
        photo = await db.get(
          'SELECT data, content_type FROM offer_photos WHERE filename = ?',
          filename
        );
      }
      if (!photo) return res.status(404).end();
      res.set('Content-Type', photo.content_type);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(photo.data);
    })
  );

  // ---- Session loading ----
  async function loadMember(req, res, next) {
    try {
      req.member = null;
      req.sessionToken = null;
      const token = req.cookies[session.COOKIE_NAME];
      if (token) {
        const m = await session.getMemberByToken(db, token);
        if (m) {
          req.member = {
            id: m.member_id,
            username: m.username,
            display_name: m.display_name,
            email: m.email,
            is_owner: !!m.is_owner,
          };
          req.sessionToken = token;
          await session.touch(db, token); // sliding 30-day expiry (DB)
          // Re-set the browser cookie so its 30-day expiry slides too.
          session.setCookie(res, token, secureCookies);
        } else {
          session.clearCookie(res);
        }
      }
      res.locals.member = req.member;
      res.locals.money = lib.money;
      res.locals.fmtDate = lib.fmtDate;
      res.locals.CATEGORIES = lib.CATEGORIES;
      res.locals.CATEGORY_EMOJI = lib.CATEGORY_EMOJI;
      next();
    } catch (e) {
      next(e);
    }
  }

  // ---- CSRF (synchronizer token) ----
  function ensureCsrf(req, res, next) {
    let t = req.cookies['valora_csrf'];
    if (!t || typeof t !== 'string' || t.length < 16) {
      t = crypto.randomBytes(32).toString('hex');
      req.cookies['valora_csrf'] = t;
      res.cookie('valora_csrf', t, {
        httpOnly: true,
        secure: secureCookies,
        sameSite: 'lax',
        path: '/',
        maxAge: session.THIRTY_DAYS_MS,
      });
    }
    res.locals.csrfToken = req.sessionToken
      ? session.csrfFor(req.sessionToken, cfg.sessionSecret)
      : t;
    next();
  }

  function requireCsrf(req, res, next) {
    const sent = req.body && req.body._csrf;
    const expected = req.sessionToken
      ? session.csrfFor(req.sessionToken, cfg.sessionSecret)
      : req.cookies['valora_csrf'];
    let ok = false;
    if (
      typeof sent === 'string' &&
      typeof expected === 'string' &&
      sent.length > 0 &&
      sent.length === expected.length
    ) {
      try {
        ok = crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      // Uploaded files live only in memory and are dropped with the request.
      return res.status(403).render('error', {
        status: 403,
        message: 'Security check failed. Please go back and try again.',
      });
    }
    next();
  }

  function requireAuth(req, res, next) {
    if (!req.member) {
      if (req.method === 'GET') {
        return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
      }
      return res.status(401).render('error', {
        status: 401,
        message: 'Please log in to continue.',
      });
    }
    next();
  }

  function requireOwner(req, res, next) {
    if (!req.member) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (!req.member.is_owner) {
      return res.status(403).render('error', {
        status: 403,
        message: 'This area is restricted to the site owner.',
      });
    }
    next();
  }

  // ---- Uploads: kept in memory, then stored as BYTEA in Postgres ----
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 6 },
    fileFilter: (req, file, cb) => {
      if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Only JPG, PNG, WebP, and GIF images are allowed.'));
      }
    },
  });

  // Random public filename for a photo (extension normalized from mimetype).
  function photoFilename(mimetype) {
    const ext =
      mimetype === 'image/png'
        ? '.png'
        : mimetype === 'image/webp'
          ? '.webp'
          : mimetype === 'image/gif'
            ? '.gif'
            : '.jpg';
    return crypto.randomBytes(16).toString('hex') + ext;
  }

  function handleUpload(req, res, next) {
    upload.array('photos', 6)(req, res, (err) => {
      if (err) {
        req.uploadError =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'Each photo must be 5MB or smaller.'
            : err.message || 'Photo upload failed.';
      } else {
        req.uploadError = null;
      }
      next();
    });
  }

  // With in-memory uploads there is nothing on disk to clean up; buffers are
  // simply dropped with the request.
  function discardFiles() {}

  app.use(loadMember);
  app.use(ensureCsrf);

  app.use('/', require('./routes/listings')(db, cfg, mw));
  app.use('/', require('./routes/index')(db, cfg, mw));
  app.use('/', require('./routes/auth')(db, cfg, mw));
  const trades = require('./routes/trades')(db, cfg, mw);
  app.use('/', trades.router);
  app.use('/', require('./routes/owner')(db, cfg, mw));

  app.use((req, res) => {
    res.status(404).render('error', {
      status: 404,
      message: 'The page you are looking for does not exist.',
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    // JSON API callers (the Stripe checkout) get JSON, not an HTML page.
    if ((req.headers.accept || '').includes('application/json')) {
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
    res.status(500).render('error', {
      status: 500,
      message: 'Something went wrong. Please try again.',
    });
  });

  return {
    app,
    db,
    cfg,
    photoFilename,
    feeFor: lib.feeFor,
    resetRateLimits: () => {
      globalLimiter.reset();
      authLimiter.reset();
    },
  };
}

module.exports = { createApp };
