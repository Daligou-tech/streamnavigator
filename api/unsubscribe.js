// Opt-out endpoint for cold outreach (the Apollo sequences that go out from
// tarik@getstreamnavigator.com).
//
// Why this exists rather than Apollo's built-in unsubscribe: Apollo's opt-out
// link is a *tracked* link, and link tracking is a paid feature. On the free
// plan the setting cannot be saved at all — the server answers "Your current
// plan does not support email tracking" — which means the `<%unsubscribe here%>`
// token has nothing to expand into and would very likely arrive in a
// recipient's inbox as those literal characters.
//
// A working opt-out is the one CAN-SPAM element with no substitute, so it is
// not something to leave sitting on a vendor's paywall. This is a plain URL in
// the message body: nothing to render, nothing to expand, no dependency on
// Apollo at all.
//
// Writes to public.suppression_list. scripts/check-suppression.js is what
// actually enforces it — run it over a contact CSV before every send.

const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');

// Deliberately POST-only.
//
// Every one of these agents is behind Microsoft 365 or Google Workspace, and
// both prefetch the URLs in inbound mail to check them for malware (Defender
// Safe Links, for one). A GET that suppressed on sight would unsubscribe people
// who never clicked anything — silently emptying the list of exactly the
// recipients whose mail was delivered successfully. The landing page is static;
// only the button press writes.
//
// This still satisfies CAN-SPAM: the recipient visits a single web page and is
// not asked for anything beyond their email address, which is the one piece of
// information the statute permits requiring.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Circuit breaker, same reasoning as api/_lib/rate-limit.js: nothing here is
// expensive, but an unauthenticated endpoint that inserts rows should have a
// ceiling. The real list is ~115 addresses, so this is enormous headroom and a
// legitimate opt-out will never see it.
const MAX_PER_HOUR = 200;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (err) { body = {}; }
  }
  body = body || {};

  const email = typeof body.email === 'string'
    ? body.email.trim().toLowerCase().slice(0, 320)
    : '';

  if (!email || !EMAIL_RE.test(email)) {
    res.status(400).json({ ok: false, error: 'That email address doesn’t look right. Please check it and try again.' });
    return;
  }

  const campaign = typeof body.campaign === 'string' ? body.campaign.trim().slice(0, 120) : null;

  const admin = getSupabaseAdmin();

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await admin
    .from('suppression_list')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', hourAgo);

  if (typeof count === 'number' && count >= MAX_PER_HOUR) {
    res.status(429).json({ ok: false, error: 'Too many requests right now. Please try again shortly, or email partners@streamnavigator.ai and we’ll remove you by hand.' });
    return;
  }

  // Anyone may suppress any address, with no proof of ownership.
  //
  // That is a deliberate choice, not an oversight. Proving ownership needs a
  // per-recipient signed link, which needs a merge field inside the mailbox
  // signature — the exact mechanism that does not work here. And the asymmetry
  // is entirely in the recipient's favour: the worst a malicious caller can do
  // is stop us from mailing someone. Nobody can use this to read the list, add
  // someone to a mailing, or learn whether an address is on it.
  const { error } = await admin
    .from('suppression_list')
    .insert({ email, source: 'unsubscribe_page', campaign: campaign || null });

  // 23505 is unique_violation: the address is already suppressed. That is a
  // success from the person's point of view — they asked not to be emailed and
  // they will not be emailed — so it must not read as a failure. Answering
  // identically either way also keeps the endpoint from confirming whether a
  // given address is on the list.
  if (error && error.code !== '23505') {
    res.status(500).json({ ok: false, error: 'Something went wrong on our end. Email partners@streamnavigator.ai and we’ll remove you by hand.' });
    return;
  }

  res.status(200).json({ ok: true });
};
