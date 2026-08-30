// Shared service-role Supabase client for the Navigator product line
// (api/navigator-*.js, api/get-navigator-submission.js,
// api/generate-contractor-report.js, api/_lib/contractor-engine.js).
//
// This intentionally mirrors the existing api/stripe-webhook.js /
// api/create-portal-session.js pattern: the service_role key bypasses RLS,
// so every table these functions touch (navigator_submissions,
// contractor_reports) has RLS enabled with NO public policies — the
// browser's publishable key can never read or write them directly.
//
// Requires the same SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment
// variables already configured in this Vercel project for the streaming
// product's api/*.js functions.

const { createClient } = require('@supabase/supabase-js');

let cached = null;

function getSupabaseAdmin() {
  if (cached) return cached;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  }
  cached = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });
  return cached;
}

const ALLOWED_PRODUCTS = [
  'contractor', 'property-tax', 'home-savings', 'rental',
  'subscriptions', 'government-money', 'home-maintenance',
  'landlord', 'insurance', 'buying',
];

module.exports = { getSupabaseAdmin, ALLOWED_PRODUCTS };
