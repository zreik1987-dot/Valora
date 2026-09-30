'use strict';

// Public pages: home, browse, about, listing detail.

const express = require('express');
const lib = require('../lib');
const { ah } = lib;

module.exports = function (db, cfg, mw) {
  const r = express.Router();

  r.get(
    '/',
    ah(async (req, res) => {
      const listings = await db.all(
        `SELECT l.*, m.display_name AS owner_name,
           (SELECT filename FROM listing_photos WHERE listing_id = l.id ORDER BY sort_order LIMIT 1) AS cover
         FROM listings l JOIN members m ON m.id = l.member_id
         WHERE l.status = 'active'
         ORDER BY l.created_at DESC LIMIT 12`
      );
      res.render('home', { title: 'Trade Almost Anything', listings });
    })
  );

  r.get(
    '/browse',
    ah(async (req, res) => {
      const category = String(req.query.category || '');
      const condition = String(req.query.condition || '');
      const q = String(req.query.q || '').trim();
      const where = ["l.status = 'active'"];
      const params = [];
      if (category && lib.CATEGORIES.includes(category)) {
        where.push('l.category = ?');
        params.push(category);
      }
      if (condition === 'new' || condition === 'used') {
        where.push('l.condition = ?');
        params.push(condition);
      }
      if (q) {
        where.push('(l.title LIKE ? OR l.description LIKE ?)');
        params.push(`%${q}%`, `%${q}%`);
      }
      const listings = await db.all(
        `SELECT l.*, m.display_name AS owner_name,
           (SELECT filename FROM listing_photos WHERE listing_id = l.id ORDER BY sort_order LIMIT 1) AS cover
         FROM listings l JOIN members m ON m.id = l.member_id
         WHERE ${where.join(' AND ')}
         ORDER BY l.created_at DESC`,
        ...params
      );
      res.render('browse', {
        title: 'Browse listings',
        listings,
        filters: { category, condition, q },
      });
    })
  );

  r.get('/about', (req, res) => {
    res.render('about', { title: 'About Valora' });
  });

  r.get(
    '/listings/:id',
    ah(async (req, res) => {
      const listing = await db.get(
        `SELECT l.*, m.display_name AS owner_name, m.username AS owner_username
         FROM listings l JOIN members m ON m.id = l.member_id
         WHERE l.id = ?`,
        req.params.id
      );
      if (!listing) {
        return res.status(404).render('error', { status: 404, message: 'Listing not found.' });
      }
      const photos = await db.all(
        'SELECT * FROM listing_photos WHERE listing_id = ? ORDER BY sort_order',
        listing.id
      );
      let myPendingOffer = null;
      if (req.member) {
        myPendingOffer = await db.get(
          `SELECT id FROM offers WHERE listing_id = ? AND from_member_id = ? AND status = 'pending'`,
          listing.id,
          req.member.id
        );
      }
      const offerCount = (
        await db.get(
          `SELECT COUNT(*) AS c FROM offers WHERE listing_id = ? AND status = 'pending'`,
          listing.id
        )
      ).c;
      const isOwn = req.member && req.member.id === listing.member_id;
      res.render('listing', {
        title: listing.title,
        listing,
        photos,
        myPendingOffer,
        offerCount,
        isOwn,
      });
    })
  );

  return r;
};
