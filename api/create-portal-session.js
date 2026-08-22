// Creates a real, authenticated Stripe Billing Portal session for the
// signed-in customer and hands back its one-time URL — so "Manage Billing" /
// "Cancel subscription" drops them straight into the portal already logged
// in, with no email-a-magic-link step.
//
// Why this replaces the old static billing.stripe.com/p/login/... link:
// that "no-code" portal login page always asks the visitor to type an email
// and wait for Stripe to send them a sign-in link. Stripe only ever sends
// that link if the email matches a real Stripe Customer record — and for
// security it fails SILENTLY otherwise (no error shown), so someone on the
// Free plan, or who mistypes the email they signed up with, waits forever
// for an email that was never going to arrive. Creating the portal session
// here — server-side, looking the customer up by their actual Supabase
// account rather than a typed-in email — sidesteps that whole flow.
//
// Requires the same SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and
// STRIPE_SECRET_KEY environment variables already used by
// api/stripe-webhook.js and the other api/*.js functions in this project.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !STRIPE_SECRET_KEY) {
    res.status(500).json({ ok: false, error: 'Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or STRIPE_SECRET_KEY env vars' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!accessToken) {
    res.status(401).json({ ok: false, error: 'Missing session — log in and try again.' });
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: callerData, error: callerError } = await admin.auth.getUser(accessToken);
  if (callerError || !callerData || !callerData.user) {
    res.status(401).json({ ok: false, error: 'Invalid or expired session — log in again.' });
    return;
  }
  const user = callerData.user;

  const { data: subscriberRow, error: subscriberError } = await admin
    .from('subscribers')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (subscriberError) {
    res.status(500).json({ ok: false, error: 'Could not look up your billing account.' });
    return;
  }
  if (!subscriberRow || !subscriberRow.stripe_customer_id) {
    res.status(404).json({ ok: false, error: "You're on the Free plan, so there's no billing account to manage yet — upgrade to Pro or Family first." });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (err) { body = {}; }
  }
  const returnUrl = (body && body.returnUrl) || `https://${req.headers.host}/dashboard.html`;

  try {
    const stripe = new Stripe(STRIPE_SECRET_KEY);
    const session = await stripe.billingPortal.sessions.create({
      customer: subscriberRow.stripe_customer_id,
      return_url: returnUrl,
    });
    res.status(200).json({ ok: true, url: session.url });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Could not create billing portal session.' });
  }
};
