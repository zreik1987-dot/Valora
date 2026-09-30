'use strict';

// Session management: random 256-bit tokens, stored as SHA-256 hashes.
// Tokens live in an HttpOnly cookie — NEVER in localStorage.

const crypto = require('crypto');

const COOKIE_NAME = 'valora_session';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const newToken = () => crypto.randomBytes(32).toString('hex');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

async function create(db, memberId) {
  const token = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + THIRTY_DAYS_MS).toISOString();
  await db.run(
    'INSERT INTO sessions (member_id, token_hash, created_at, expires_at, revoked) VALUES (?,?,?,?,0)',
    memberId,
    hashToken(token),
    now.toISOString(),
    expiresAt
  );
  return { token, expiresAt };
}

async function getMemberByToken(db, token) {
  if (!token || typeof token !== 'string') return null;
  const row = await db.get(
    `SELECT m.id AS member_id, m.username, m.display_name, m.email, m.is_owner, s.expires_at
     FROM sessions s JOIN members m ON m.id = s.member_id
     WHERE s.token_hash = ? AND s.revoked = 0`,
    hashToken(token)
  );
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;
  return row;
}

// Sliding expiry: push the session out another 30 days on activity.
async function touch(db, token) {
  const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS).toISOString();
  await db.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND revoked = 0',
    expiresAt,
    hashToken(token)
  );
}

async function revoke(db, token) {
  await db.run('UPDATE sessions SET revoked = 1 WHERE token_hash = ?', hashToken(token));
}

async function revokeAll(db, memberId) {
  await db.run('UPDATE sessions SET revoked = 1 WHERE member_id = ?', memberId);
}

function setCookie(res, token, secure) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: !!secure,
    sameSite: 'lax',
    path: '/',
    maxAge: THIRTY_DAYS_MS,
  });
}

function clearCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// CSRF synchronizer token bound to the session token (HMAC with the server secret).
function csrfFor(token, secret) {
  return crypto.createHmac('sha256', secret).update('csrf:' + token).digest('hex');
}

module.exports = {
  COOKIE_NAME,
  THIRTY_DAYS_MS,
  newToken,
  hashToken,
  create,
  getMemberByToken,
  touch,
  revoke,
  revokeAll,
  setCookie,
  clearCookie,
  csrfFor,
};
