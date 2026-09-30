'use strict';

// Shared constants and helpers.

const crypto = require('crypto');

const CATEGORIES = ['Cars', 'Tools', 'Jewelry', 'Clothes', 'Home Goods', 'Other'];
const CONDITIONS = ['new', 'used'];
const CATEGORY_EMOJI = {
  Cars: '🚗',
  Tools: '🛠️',
  Jewelry: '💎',
  Clothes: '👕',
  'Home Goods': '🛋️',
  Other: '📦',
};

const nowIso = () => new Date().toISOString();

// Wrap async route handlers so rejections reach Express error handling.
const ah = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Platform fee: 5% of the cash on top, rounded to the nearest cent.
const feeFor = (cashCents) => Math.round(Number(cashCents) * 0.05);

const money = (cents) => '$' + (Number(cents) / 100).toFixed(2);

// Parse a dollar amount string ("25", "25.50") into integer cents.
// Returns 0 for empty input, null for invalid input.
function parseCashDollars(str) {
  if (str === undefined || str === null || String(str).trim() === '') return 0;
  const n = Number(String(str).trim());
  if (!Number.isFinite(n) || n < 0 || n > 100000000) return null;
  return Math.round(n * 100);
}

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim());
const isValidUsername = (u) => /^[A-Za-z0-9]{3,20}$/.test(String(u || ''));
const isValidPassword = (p) => typeof p === 'string' && p.length >= 8;

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

module.exports = {
  CATEGORIES,
  CONDITIONS,
  CATEGORY_EMOJI,
  nowIso,
  ah,
  feeFor,
  money,
  parseCashDollars,
  isValidEmail,
  isValidUsername,
  isValidPassword,
  fmtDate,
};
