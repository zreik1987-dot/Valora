'use strict';

// Evergreen trading guides served at /guides/:slug.
// Content lives in content/guides/<slug>.md (plain markdown, trusted —
// written by us, not user input). This module loads metadata and renders
// a small safe subset of markdown to HTML.

const fs = require('fs');
const path = require('path');

const GUIDES = [
  {
    slug: 'trade-safely-in-person',
    title: 'How to Trade Items Safely in Person',
    description: 'Meet in public, bring a friend, inspect carefully — simple steps that keep every face-to-face trade safe.',
  },
  {
    slug: 'value-used-items-before-you-trade',
    title: 'How to Value Your Used Items Before a Trade',
    description: 'Check real market prices, grade condition honestly, and set a fair cash-on-top amount before you offer.',
  },
  {
    slug: 'trading-vs-selling',
    title: 'Trading vs. Selling: When Each Wins',
    description: 'Sometimes a swap beats a sale. Here is how to decide which one gets you more value with less hassle.',
  },
  {
    slug: 'photograph-items-to-trade-faster',
    title: 'How to Photograph Items So They Trade Faster',
    description: 'Good photos are the difference between ten offers and zero. Phone-camera tips anyone can follow.',
  },
  {
    slug: 'avoid-scams-peer-to-peer-trades',
    title: 'Avoiding Scams in Peer-to-Peer Trades',
    description: 'Red flags, common tricks, and the habits that keep your trades honest on any marketplace.',
  },
];

const CONTENT_DIR = path.join(__dirname, '..', 'content', 'guides');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Minimal markdown renderer: # / ## headings, - bullets, **bold**, paragraphs.
// Input is our own trusted content; escaping still applied for safety.
function renderMarkdown(md) {
  const lines = String(md).split('\n');
  let html = '';
  let inList = false;
  const flushList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };
  const inline = (t) =>
    escapeHtml(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^#{1,2}\s/.test(line)) {
      flushList();
      const level = line.startsWith('## ') ? 'h2' : 'h1';
      html += `<${level}>${inline(line.replace(/^#{1,2}\s+/, ''))}</${level}>`;
    } else if (/^-\s+/.test(line)) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${inline(line.replace(/^-\s+/, ''))}</li>`;
    } else if (line.trim() === '') {
      flushList();
    } else {
      flushList();
      html += `<p>${inline(line.trim())}</p>`;
    }
  }
  flushList();
  return html;
}

function getGuide(slug) {
  const meta = GUIDES.find((g) => g.slug === slug);
  if (!meta) return null;
  let md = '';
  try {
    md = fs.readFileSync(path.join(CONTENT_DIR, `${slug}.md`), 'utf8');
  } catch (e) {
    return null;
  }
  return { ...meta, html: renderMarkdown(md) };
}

function listGuides() {
  return GUIDES.map((g) => ({ ...g }));
}

module.exports = { listGuides, getGuide };
