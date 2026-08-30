// Stripe webhook for the 10 Navigator product Payment Links — deliberately
// separate from the existing api/stripe-webhook.js (which handles the
// streaming product's subscriptions) so the two product lines never share
// a webhook secret or interfere with each other.
//
// Each Navigator page sends the customer to its Stripe Payment Link with
// ?client_reference_id=<submission id> appended (see navigator-shared.js
// on each product page). When Stripe calls back here after a successful
// one-time payment, this just marks that submission "paid" — it does NOT
// do any report generation itself (see api/get-navigator-submission.js for
// why: keeping this webhook fast and simple is what actually matters for
// Stripe's retry behavior, and Contractor Navigator's report is triggered
// lazily on the customer's first status poll instead).
//
// One-time setup once this is deployed:
//   1. Create the 10 Payment Links in Stripe Dashboard -> Payment links
//      (see the price list in each page's PAYMENT PORTAL SETUP comment).
//   2. Stripe Dashboard -> Developers -> Webhooks -> Add endpoint
//      -> https://streamnavigator.ai/api/navigator-stripe-webhook
//      -> events: checkout.session.completed
//   3. Copy that endpoint's signing secret into this Vercel project's
//      NAVIGATOR_STRIPE_WEBHOOK_SECRET environment variable.
//   4. STRIPE_SECRET_KEY is reused from the existing streaming product's
//      configuration — nothing new needed there.

const Stripe = require('stripe');
const { getSupabaseAdmin, ALLOWED_PRODUCTS } = require('./_lib/supabaseAdmin');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const WEBHOOK_SECRET = process.env.NAVIGATOR_STRIPE_WEBHOOK_SECRET;
  if (!STRIPE_SECRET_KEY || !WEBHOOK_SECRET) {
    res.status(500).json({ ok: false, error: 'Missing STRIPE_SECRET_KEY or NAVIGATOR_STRIPE_WEBHOOK_SECRET env vars' });
    return;
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);

  let event;
  try {
    const rawBody = await buffer(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
  } catch (err) {
    res.status(400).json({ ok: false, error: `Webhook signature verification failed: ${err.message}` });
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const submissionId = session.client_reference_id;
      if (!submissionId) {
        res.status(200).json({ ok: true, skipped: true, reason: 'No client_reference_id on this session' });
        return;
      }

      const admin = getSupabaseAdmin();
      const { data: submission } = await admin
        .from('navigator_submissions')
        .select('id, product')
        .eq('id', submissionId)
        .maybeSingle();

      if (!submission || !ALLOWED_PRODUCTS.includes(submission.product)) {
        res.status(200).json({ ok: true, skipped: true, reason: 'Unknown submission — not a Navigator product payment' });
        return;
      }

      await admin
        .from('navigator_submissions')
        .update({
          status: 'paid',
          stripe_customer_id: session.customer || null,
          stripe_checkout_session_id: session.id,
          price_cents: session.amount_total ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', submissionId);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Unexpected error' });
  }
};

module.exports.config = { api: { bodyParser: false } };

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
