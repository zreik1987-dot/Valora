'use strict';

// Authentication: signup, login (with lockout), logout.

const express = require('express');
const bcrypt = require('bcryptjs');
const lib = require('../lib');
const { ah } = lib;
const session = require('../session');

const LOCKOUT_WINDOW_MIN = 15;
const LOCKOUT_MAX_ATTEMPTS = 5;

function safeNext(v) {
  if (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//')) return v;
  return '/dashboard';
}

module.exports = function (db, cfg, mw) {
  const r = express.Router();
  const secureCookies = cfg.nodeEnv === 'production';

  r.get('/signup', (req, res) => {
    if (req.member) return res.redirect('/dashboard');
    res.render('signup', { title: 'Sign up', error: null, username: '', display_name: '', email: '' });
  });

  r.post(
    '/signup',
    mw.authLimiter,
    mw.requireCsrf,
    ah(async (req, res) => {
      if (req.member) return res.redirect('/dashboard');
      const username = String(req.body.username || '').trim();
      const displayName = String(req.body.display_name || '').trim();
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = req.body.password || '';
      const renderErr = (message) =>
        res.status(400).render('signup', {
          title: 'Sign up',
          error: message,
          username,
          display_name: displayName,
          email,
        });

      if (!lib.isValidUsername(username)) {
        return renderErr('Username must be 3–20 characters, letters and numbers only.');
      }
      if (!displayName || displayName.length > 60) {
        return renderErr('Please enter a display name (up to 60 characters).');
      }
      if (!lib.isValidEmail(email)) return renderErr('Please enter a valid email address.');
      if (!lib.isValidPassword(password)) {
        return renderErr('Password must be at least 8 characters.');
      }
      const exists = await db.get(
        'SELECT id FROM members WHERE username = ? OR email = ?',
        username,
        email
      );
      if (exists) return renderErr('That username or email is already taken.');

      // NOTE: is_owner is hardcoded to 0 here. There is no code path, form field,
      // or parameter that can make a signup create an owner.
      const hash = bcrypt.hashSync(password, 12);
      const memberId = await db.insert(
        'INSERT INTO members (username, display_name, email, password_hash, is_owner, created_at) VALUES (?,?,?,?,0,?)',
        username,
        displayName,
        email,
        hash,
        lib.nowIso()
      );
      const s = await session.create(db, memberId);
      session.setCookie(res, s.token, secureCookies);
      res.redirect('/dashboard');
    })
  );

  r.get('/login', (req, res) => {
    if (req.member) return res.redirect('/dashboard');
    res.render('login', {
      title: 'Log in',
      error: null,
      email: '',
      next: safeNext(req.query.next) === '/dashboard' && req.query.next ? req.query.next : '',
    });
  });

  r.post(
    '/login',
    mw.authLimiter,
    mw.requireCsrf,
    ah(async (req, res) => {
      if (req.member) return res.redirect('/dashboard');
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = req.body.password || '';
      const next = safeNext(req.body.next);
      const ip = req.ip || 'unknown';
      const windowStart = new Date(Date.now() - LOCKOUT_WINDOW_MIN * 60 * 1000).toISOString();

      const attempts = (
        await db.get(
          'SELECT COUNT(*) AS c FROM login_attempts WHERE email = ? AND ip = ? AND created_at > ?',
          email,
          ip,
          windowStart
        )
      ).c;
      if (attempts >= LOCKOUT_MAX_ATTEMPTS) {
        return res.status(429).render('login', {
          title: 'Log in',
          error: 'Too many failed attempts. Please try again in 15 minutes.',
          email,
          next: req.body.next || '',
        });
      }

      const member = await db.get('SELECT * FROM members WHERE email = ?', email);
      const ok = member && bcrypt.compareSync(password, member.password_hash);
      if (!ok) {
        await db.run('INSERT INTO login_attempts (email, ip, created_at) VALUES (?,?,?)',
          email,
          ip,
          lib.nowIso()
        );
        return res.status(401).render('login', {
          title: 'Log in',
          error: 'Invalid email or password.',
          email,
          next: req.body.next || '',
        });
      }

      await db.run('DELETE FROM login_attempts WHERE email = ? AND ip = ?', email, ip);
      await session.revokeAll(db, member.id); // rotate: invalidate older sessions on login
      const s = await session.create(db, member.id);
      session.setCookie(res, s.token, secureCookies);
      res.redirect(next);
    })
  );

  r.post(
    '/logout',
    mw.requireCsrf,
    ah(async (req, res) => {
      if (req.sessionToken) await session.revoke(db, req.sessionToken);
      session.clearCookie(res);
      res.redirect('/');
    })
  );

  return r;
};
