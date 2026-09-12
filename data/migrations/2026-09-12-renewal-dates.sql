-- 2026-09-12 — renewal dates on tracked subscriptions
--
-- Why: the product could tell a customer WHAT to do but never WHEN. Without
-- a renewal date, "pause Netflix" is worth $0 if they act the day after it
-- renewed, and worth a full month if they act the day before. This is the
-- single field that turns a recommendation into a saving.
--
-- It also fixes the most expensive category of wrong advice the engine could
-- give: telling someone to cancel an ANNUAL plan mid-term, which forfeits
-- what they have already prepaid instead of saving anything. billing_period
-- lets the engine hold that advice until the annual renewal is close.
--
-- Both columns are nullable and the engine degrades to its previous
-- behaviour when they are empty, so existing rows keep working untouched and
-- customers can backfill at their own pace.
--
-- Run once against the StreamNavigator project (Supabase SQL editor).

alter table public.tracked_subscriptions
  add column if not exists next_renewal_date date,
  add column if not exists billing_period text not null default 'monthly';

alter table public.tracked_subscriptions
  drop constraint if exists tracked_subscriptions_billing_period_check;

alter table public.tracked_subscriptions
  add constraint tracked_subscriptions_billing_period_check
  check (billing_period in ('monthly', 'annual'));

-- The daily job scans for renewals coming up; without this it table-scans
-- every customer's rows to find the handful that are due this week.
create index if not exists tracked_subscriptions_next_renewal_date_idx
  on public.tracked_subscriptions (next_renewal_date)
  where next_renewal_date is not null;

comment on column public.tracked_subscriptions.next_renewal_date is
  'Next date this subscription bills. Pause reminders fire in the week before it; the daily cron rolls it forward once it passes. Null = unknown, engine falls back to date-free behaviour.';
comment on column public.tracked_subscriptions.billing_period is
  'monthly | annual. Annual plans are prepaid, so pause/cancel advice is suppressed until the renewal is within 14 days.';
