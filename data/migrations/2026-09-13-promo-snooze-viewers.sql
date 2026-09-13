-- 2026-09-13 — the three things a correct recommendation can still get wrong
--
-- Each column here exists because acting on advice that was right could still
-- cost the customer money or access, and nothing told them:
--
--   is_promo_rate            — cancelling a legacy price usually means coming
--                              back at list price, so the quoted saving does
--                              not survive a round trip.
--   suggestion_snoozed_until — the customer said "no, I want to keep this".
--                              Re-suggesting it is how a product stops being
--                              read.
--   favorite_watches.viewer  — without knowing who follows what, the engine
--                              can tell you to cancel a service somebody else
--                              in the house is using.
--
-- All three are nullable/defaulted; existing rows keep working untouched.
-- Applied to production 2026-09-13.

alter table public.tracked_subscriptions
  add column if not exists is_promo_rate boolean not null default false;

alter table public.tracked_subscriptions
  add column if not exists suggestion_snoozed_until date;

alter table public.favorite_watches
  add column if not exists viewer text;

create index if not exists tracked_subscriptions_snoozed_idx
  on public.tracked_subscriptions (suggestion_snoozed_until)
  where suggestion_snoozed_until is not null;

comment on column public.tracked_subscriptions.is_promo_rate is
  'Customer is on a promo or legacy price. Suspend advice carries a warning that returning costs list price.';
comment on column public.tracked_subscriptions.suggestion_snoozed_until is
  'Customer declined the suspend suggestion. No suspend is suggested or emailed before this date.';
comment on column public.favorite_watches.viewer is
  'Optional household member name. Surfaced in the evidence and warns when more than one person follows content on the same service.';
