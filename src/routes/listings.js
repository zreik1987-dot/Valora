'use strict';

// Listings, trade offers, and the member dashboard.

const express = require('express');
const lib = require('../lib');
const { ah } = lib;

function validateListing(form) {
  if (!form.title || form.title.length < 3 || form.title.length > 120) {
    return 'Title must be between 3 and 120 characters.';
  }
  if (!form.description || form.description.length < 10 || form.description.length > 5000) {
    return 'Description must be between 10 and 5000 characters.';
  }
  if (!lib.CATEGORIES.includes(form.category)) return 'Please choose a valid category.';
  if (form.condition !== 'new' && form.condition !== 'used') {
    return 'Please choose whether the item is new or used.';
  }
  if (lib.parseCashDollars(form.price_estimate) === null) {
    return 'Price estimate must be a valid non-negative amount.';
  }
  return null;
}

function validateOffer(form) {
  if (!form.item_title || form.item_title.length < 3 || form.item_title.length > 120) {
    return 'Describe your item with a title of 3–120 characters.';
  }
  if (!form.item_description || form.item_description.length < 10 || form.item_description.length > 5000) {
    return 'Describe your item in 10–5000 characters.';
  }
  if (form.item_condition !== 'new' && form.item_condition !== 'used') {
    return 'Please choose whether your item is new or used.';
  }
  if (lib.parseCashDollars(form.cash_on_top) === null) {
    return 'Cash on top must be a valid non-negative amount.';
  }
  return null;
}

// Photos arrive in memory (multer memoryStorage); store bytes in Postgres.
async function savePhotos(db, photoFilename, table, fkCol, fkId, files) {
  if (!files || !files.length) return;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    await db.run(
      `INSERT INTO ${table} (${fkCol}, filename, data, content_type, sort_order) VALUES (?,?,?,?,?)`,
      fkId,
      photoFilename(f.mimetype),
      f.buffer,
      f.mimetype,
      i
    );
  }
}

// Shared guard: can this member make an offer on this listing?
async function canOffer(db, listingId, memberId) {
  const listing = await db.get(
    `SELECT l.*, m.display_name AS owner_name
     FROM listings l JOIN members m ON m.id = l.member_id
     WHERE l.id = ?`,
    listingId
  );
  if (!listing) return { status: 404, error: 'Listing not found.' };
  if (listing.status !== 'active') {
    return { status: 400, error: 'This listing is no longer available for offers.' };
  }
  if (listing.member_id === memberId) {
    return { status: 400, error: 'You cannot make an offer on your own listing.' };
  }
  const dup = await db.get(
    `SELECT id FROM offers WHERE listing_id = ? AND from_member_id = ? AND status = 'pending'`,
    listingId,
    memberId
  );
  if (dup) {
    return { status: 400, error: 'You already have a pending offer on this listing.' };
  }
  return { listing };
}

const NOTICES = {
  offer_sent: 'Your trade offer was sent.',
  trade_completed: 'Trade completed. The item has been marked as traded.',
  offer_withdrawn: 'Your offer was withdrawn.',
  offer_declined: 'The offer was declined.',
  listing_removed: 'Your listing was removed.',
};

module.exports = function (db, cfg, mw) {
  const r = express.Router();

  // ---- New listing ----
  r.get('/listings/new', mw.requireAuth, (req, res) => {
    res.render('listing-new', { title: 'List an item', error: null, form: {} });
  });

  r.post(
    '/listings',
    mw.requireAuth,
    mw.handleUpload,
    mw.requireCsrf,
    ah(async (req, res) => {
      const form = {
        title: String(req.body.title || '').trim(),
        description: String(req.body.description || '').trim(),
        category: req.body.category,
        condition: req.body.condition,
        price_estimate: req.body.price_estimate,
      };
      const err = req.uploadError || validateListing(form);
      if (err) {
        mw.discardFiles(req.files);
        return res.status(400).render('listing-new', { title: 'List an item', error: err, form });
      }
      const listingId = await db.insert(
        `INSERT INTO listings (member_id, title, description, category, condition, price_estimate_cents, status, created_at)
         VALUES (?,?,?,?,?,?, 'active', ?)`,
        req.member.id,
        form.title,
        form.description,
        form.category,
        form.condition,
        lib.parseCashDollars(form.price_estimate),
        lib.nowIso()
      );
      await savePhotos(db, mw.photoFilename, 'listing_photos', 'listing_id', listingId, req.files);
      res.redirect('/listings/' + listingId);
    })
  );

  // ---- Make an offer ----
  r.get(
    '/listings/:id/offer',
    mw.requireAuth,
    ah(async (req, res) => {
      const check = await canOffer(db, req.params.id, req.member.id);
      if (check.error) {
        return res.status(check.status).render('error', { status: check.status, message: check.error });
      }
      res.render('offer-new', { title: 'Make a trade offer', listing: check.listing, error: null, form: {} });
    })
  );

  r.post(
    '/listings/:id/offer',
    mw.requireAuth,
    mw.handleUpload,
    mw.requireCsrf,
    ah(async (req, res) => {
      const check = await canOffer(db, req.params.id, req.member.id);
      if (check.error) {
        mw.discardFiles(req.files);
        return res.status(check.status).render('error', { status: check.status, message: check.error });
      }
      const form = {
        item_title: String(req.body.item_title || '').trim(),
        item_description: String(req.body.item_description || '').trim(),
        item_condition: req.body.item_condition,
        cash_on_top: req.body.cash_on_top,
      };
      const err = req.uploadError || validateOffer(form);
      if (err) {
        mw.discardFiles(req.files);
        return res
          .status(400)
          .render('offer-new', { title: 'Make a trade offer', listing: check.listing, error: err, form });
      }
      try {
        const offerId = await db.insert(
          `INSERT INTO offers (listing_id, from_member_id, item_title, item_description, item_condition, cash_on_top_cents, status, created_at)
           VALUES (?,?,?,?,?,?, 'pending', ?)`,
          check.listing.id,
          req.member.id,
          form.item_title,
          form.item_description,
          form.item_condition,
          lib.parseCashDollars(form.cash_on_top),
          lib.nowIso()
        );
        await savePhotos(db, mw.photoFilename, 'offer_photos', 'offer_id', offerId, req.files);
      } catch (e) {
        mw.discardFiles(req.files);
        if (e && e.code === '23505') {
          return res.status(400).render('offer-new', {
            title: 'Make a trade offer',
            listing: check.listing,
            error: 'You already have a pending offer on this listing.',
            form,
          });
        }
        throw e;
      }
      res.redirect('/dashboard?notice=offer_sent');
    })
  );

  // ---- Accept an offer (listing owner only). Atomic: locks the listing. ----
  async function acceptOffer(offerId, memberId) {
    return db.transaction(async (tx) => {
      const offer = await tx.get('SELECT * FROM offers WHERE id = ?', offerId);
      if (!offer) return { status: 404, error: 'Offer not found.' };
      if (offer.status !== 'pending') return { status: 400, error: 'This offer is no longer pending.' };
      const listing = await tx.get('SELECT * FROM listings WHERE id = ?', offer.listing_id);
      if (!listing) return { status: 404, error: 'Listing not found.' };
      if (listing.member_id !== memberId) {
        return { status: 403, error: 'Only the listing owner can accept offers.' };
      }
      if (listing.status !== 'active') {
        return { status: 400, error: 'This listing is no longer active.' };
      }
      const fee = lib.feeFor(offer.cash_on_top_cents);
      await tx.run(`UPDATE listings SET status = 'traded' WHERE id = ?`, listing.id);
      await tx.run(`UPDATE offers SET status = 'accepted' WHERE id = ?`, offer.id);
      await tx.run(
        `UPDATE offers SET status = 'declined' WHERE listing_id = ? AND status = 'pending' AND id != ?`,
        listing.id,
        offer.id
      );
      const tradeId = await tx.insert(
        `INSERT INTO trades (listing_id, offer_id, seller_member_id, buyer_member_id, cash_on_top_cents, fee_cents, completed_at)
         VALUES (?,?,?,?,?,?,?)`,
        listing.id,
        offer.id,
        listing.member_id,
        offer.from_member_id,
        offer.cash_on_top_cents,
        fee,
        lib.nowIso()
      );
      await tx.run(
        `INSERT INTO fee_ledger (trade_id, amount_cents, status, created_at) VALUES (?,?,?,?)`,
        tradeId,
        fee,
        fee === 0 ? 'paid' : 'unpaid',
        lib.nowIso()
      );
      return { tradeId, fee };
    });
  }

  r.post(
    '/offers/:id/accept',
    mw.requireAuth,
    mw.requireCsrf,
    ah(async (req, res) => {
      const result = await acceptOffer(req.params.id, req.member.id);
      if (result.error) {
        return res.status(result.status).render('error', { status: result.status, message: result.error });
      }
      res.redirect('/dashboard?notice=trade_completed');
    })
  );

  r.post(
    '/offers/:id/decline',
    mw.requireAuth,
    mw.requireCsrf,
    ah(async (req, res) => {
      const offer = await db.get('SELECT * FROM offers WHERE id = ?', req.params.id);
      if (!offer) return res.status(404).render('error', { status: 404, message: 'Offer not found.' });
      const listing = await db.get('SELECT * FROM listings WHERE id = ?', offer.listing_id);
      if (!listing || listing.member_id !== req.member.id) {
        return res.status(403).render('error', {
          status: 403,
          message: 'Only the listing owner can decline offers.',
        });
      }
      if (offer.status !== 'pending') {
        return res.status(400).render('error', { status: 400, message: 'This offer is no longer pending.' });
      }
      await db.run(`UPDATE offers SET status = 'declined' WHERE id = ?`, offer.id);
      res.redirect('/dashboard?notice=offer_declined');
    })
  );

  r.post(
    '/offers/:id/withdraw',
    mw.requireAuth,
    mw.requireCsrf,
    ah(async (req, res) => {
      const offer = await db.get('SELECT * FROM offers WHERE id = ?', req.params.id);
      if (!offer) return res.status(404).render('error', { status: 404, message: 'Offer not found.' });
      if (offer.from_member_id !== req.member.id) {
        return res.status(403).render('error', {
          status: 403,
          message: 'Only the person who made the offer can withdraw it.',
        });
      }
      if (offer.status !== 'pending') {
        return res.status(400).render('error', { status: 400, message: 'This offer is no longer pending.' });
      }
      await db.run(`UPDATE offers SET status = 'withdrawn' WHERE id = ?`, offer.id);
      res.redirect('/dashboard?notice=offer_withdrawn');
    })
  );

  // ---- Remove a listing (owner only, active only, no accepted offer) ----
  r.post(
    '/listings/:id/remove',
    mw.requireAuth,
    mw.requireCsrf,
    ah(async (req, res) => {
      const listing = await db.get('SELECT * FROM listings WHERE id = ?', req.params.id);
      if (!listing) return res.status(404).render('error', { status: 404, message: 'Listing not found.' });
      if (listing.member_id !== req.member.id) {
        return res.status(403).render('error', {
          status: 403,
          message: 'Only the listing owner can remove it.',
        });
      }
      if (listing.status !== 'active') {
        return res.status(400).render('error', { status: 400, message: 'This listing is not active.' });
      }
      const accepted = await db.get(
        `SELECT id FROM offers WHERE listing_id = ? AND status = 'accepted'`,
        listing.id
      );
      if (accepted) {
        return res.status(400).render('error', {
          status: 400,
          message: 'This listing has a completed trade and cannot be removed.',
        });
      }
      await db.run(`UPDATE listings SET status = 'removed' WHERE id = ?`, listing.id);
      res.redirect('/dashboard?notice=listing_removed');
    })
  );

  // ---- Dashboard ----
  r.get(
    '/dashboard',
    mw.requireAuth,
    ah(async (req, res) => {
      const id = req.member.id;
      const myListings = await db.all(
        `SELECT l.*,
           (SELECT filename FROM listing_photos WHERE listing_id = l.id ORDER BY sort_order LIMIT 1) AS cover,
           (SELECT COUNT(*) FROM offers WHERE listing_id = l.id AND status = 'pending') AS pending_offers
         FROM listings l WHERE l.member_id = ? ORDER BY l.created_at DESC`,
        id
      );
      const offersMade = await db.all(
        `SELECT o.*, l.title AS listing_title
         FROM offers o JOIN listings l ON l.id = o.listing_id
         WHERE o.from_member_id = ? ORDER BY o.created_at DESC`,
        id
      );
      const offersReceived = await db.all(
        `SELECT o.*, l.title AS listing_title, l.id AS listing_id, m.display_name AS from_name,
           (SELECT filename FROM offer_photos WHERE offer_id = o.id ORDER BY sort_order LIMIT 1) AS cover
         FROM offers o
         JOIN listings l ON l.id = o.listing_id
         JOIN members m ON m.id = o.from_member_id
         WHERE l.member_id = ? AND o.status = 'pending'
         ORDER BY o.created_at DESC`,
        id
      );
      const trades = await db.all(
        `SELECT t.*, l.title AS listing_title, b.display_name AS buyer_name, s.display_name AS seller_name,
           f.status AS fee_status
         FROM trades t
         JOIN listings l ON l.id = t.listing_id
         JOIN members b ON b.id = t.buyer_member_id
         JOIN members s ON s.id = t.seller_member_id
         JOIN fee_ledger f ON f.trade_id = t.id
         WHERE t.seller_member_id = ? OR t.buyer_member_id = ?
         ORDER BY t.completed_at DESC`,
        id,
        id
      );
      res.render('dashboard', {
        title: 'Dashboard',
        myListings,
        offersMade,
        offersReceived,
        trades,
        notice: NOTICES[req.query.notice] || null,
      });
    })
  );

  return r;
};
