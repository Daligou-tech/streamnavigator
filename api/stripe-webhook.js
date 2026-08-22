// Stripe webhook — the single source of truth for "did this customer
// actually pay." Stripe calls this URL directly (server-to-server) whenever
// a checkout completes or a subscription's status changes; this function
// verifies the request really came from Stripe, then writes the real,
// current plan into Supabase's `subscribers` table using the service_role
// key (bypassing RLS, since this has to write rows for every customer, not
// just one logged-in user).
//
// The dashboard (dashboard.html) only ever READS its own row from
// `subscribers` with the customer's own anon-key session — it can never
// write to it — so there's no way for a customer to grant themselves a
// paid plan from the browser. This webhook is the only writer.
//
// Requires four Vercel project environment variables (Project Settings ->
// Environment Variables -> Production), none of which are ever sent to the
// browser:
//   SUPABASE_URL                same project URL already used elsewhere
//   SUPABASE_SERVICE_ROLE_KEY   same service_role secret key already used
//                                by api/refresh-shows.js
//   STRIPE_SECRET_KEY           Stripe Dashboard -> Developers -> API keys
//                                -> Secret key (starts with sk_live_ or
//                                sk_test_)
//   STRIPE_WEBHOOK_SECRET       Stripe Dashboard -> Developers -> Webhooks
//                                -> (this endpoint) -> Signing secret
//                                (starts with whsec_) — created once you've
//                                pointed a webhook at this URL (see setup
//                                notes at the bottom of this file)
//
// Vercel normally parses the request body as JSON before your function
// runs, but Stripe's signature check needs the exact raw bytes that were
// sent — so bodyParser is turned off below and the raw body is read by hand.

const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!STRIPE_SECRET_KEY || !WEBHOOK_SECRET || !SUPABASE_URL || !SERVICE_KEY) {
    res.status(500).json({ ok: false, error: 'Missing required environment variables' });
    return;
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);

  let event;
  try {
    const rawBody = await buffer(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
  } catch (err) {
    // Signature didn't match — either a stale/wrong webhook secret, or this
    // request didn't really come from Stripe. Don't process it.
    res.status(400).json({ ok: false, error: `Webhook signature verification failed: ${err.message}` });
    return;
  }

  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;
      // A checkout with no client_reference_id has no way to know which
      // Supabase account to unlock — this happens if someone reaches the
      // Stripe payment link without dashboard.html having been able to tag
      // it first (e.g. not logged in when they clicked). Nothing to write.
      if (!userId || session.mode !== 'subscription' || !session.subscription) {
        res.status(200).json({ ok: true, skipped: true, reason: 'No client_reference_id or not a subscription checkout' });
        return;
      }

      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      const plan = planFromSubscription(subscription);

      const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?on_conflict=user_id`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{
          user_id: userId,
          plan,
          stripe_customer_id: session.customer,
          stripe_subscription_id: subscription.id,
          stripe_status: subscription.status,
          current_period_end: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : null,
          updated_at: new Date().toISOString(),
        }]),
      });
      if (!upsertRes.ok) {
        res.status(500).json({ ok: false, error: 'Could not write plan to Supabase' });
        return;
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const isActive = subscription.status === 'active' || subscription.status === 'trialing';
      const plan = (event.type === 'customer.subscription.deleted' || !isActive) ? 'free' : planFromSubscription(subscription);

      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${encodeURIComponent(subscription.customer)}`,
        {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify({
            plan,
            stripe_status: subscription.status,
            current_period_end: subscription.current_period_end
              ? new Date(subscription.current_period_end * 1000).toISOString()
              : null,
            updated_at: new Date().toISOString(),
          }),
        }
      );
      if (!patchRes.ok) {
        res.status(500).json({ ok: false, error: 'Could not update plan in Supabase' });
        return;
      }
    }
    // Other event types (invoices, payment methods, etc.) aren't relevant
    // to plan gating — acknowledge and ignore them.

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Unexpected error' });
  }
};

module.exports.config = { api: { bodyParser: false } };

// Which plan a subscription's price maps to. There are only two real prices
// today ($4.99 Pro / $8.99 Family), so this compares the actual cents Stripe
// is charging rather than hardcoding a price ID — if the price ever
// changes, update the two amounts below. A successful payment that doesn't
// match either amount still defaults to 'pro' rather than 'free', since
// someone who just paid should never end up locked out.
function planFromSubscription(subscription){
  const item = subscription.items && subscription.items.data && subscription.items.data[0];
  const unitAmount = item && item.price ? item.price.unit_amount : null;
  if (unitAmount === 899) return 'family';
  if (unitAmount === 499) return 'pro';
  return 'pro';
}

async function buffer(readable){
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// One-time setup, after this file is deployed to Vercel:
//   1. Stripe Dashboard -> Developers -> Webhooks -> Add endpoint
//   2. Endpoint URL: https://<your-domain>/api/stripe-webhook
//   3. Events to send: checkout.session.completed, customer.subscription.updated,
//      customer.subscription.deleted
//   4. After creating it, click the endpoint -> reveal the Signing secret ->
//      copy it into Vercel's STRIPE_WEBHOOK_SECRET environment variable.
//   5. Copy your Secret key (Developers -> API keys) into STRIPE_SECRET_KEY.
// ---------------------------------------------------------------------------
