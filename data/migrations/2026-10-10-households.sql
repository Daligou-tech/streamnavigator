-- 2026-10-10 — household sharing
--
-- Why: the $19.99/year plan sells "everyone in the household, one price", and
-- the dashboard, api/invite-household-member.js, api/remove-household-member.js
-- and api/household-summary.js were all written against these two tables, but
-- the tables were never created. Every household action failed.
--
-- Who touches what:
--   * The three API endpoints use the service role and bypass RLS.
--   * The browser (dashboard.html) reads with the customer's own session:
--       - an owner lists the members of their own household;
--       - an invited person claims the pending row addressed to their login
--         email (attaches their uid, flips it to 'active');
--       - a member asks which plan their household is on, through
--         household_plan(), so the owner's subscriber row stays private.
--
-- RLS checks go through SECURITY DEFINER helpers: a policy on one table that
-- queries the other, and back, recurses forever in Postgres.
--
-- Run once against the StreamNavigator project (Supabase SQL editor).

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  email text not null,
  user_id uuid references auth.users (id) on delete cascade,
  status text not null default 'invited' check (status in ('invited', 'active')),
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  unique (household_id, email)
);

create index if not exists household_members_user_id_idx on public.household_members (user_id);
create index if not exists household_members_email_idx on public.household_members (lower(email));

alter table public.households enable row level security;
alter table public.household_members enable row level security;

create or replace function public.owns_household(h uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.households where id = h and owner_user_id = auth.uid());
$$;

create or replace function public.member_of_household(h uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.household_members
                 where household_id = h and user_id = auth.uid() and status = 'active');
$$;

-- The plan a member inherits: their household owner's, read live on every
-- call, so a member loses access the moment the owner cancels.
create or replace function public.household_plan()
returns text language sql stable security definer set search_path = '' as $$
  select s.plan
  from public.household_members m
  join public.households h on h.id = m.household_id
  join public.subscribers s on s.user_id = h.owner_user_id
  where m.user_id = auth.uid() and m.status = 'active'
  limit 1;
$$;

revoke all on function public.owns_household(uuid), public.member_of_household(uuid), public.household_plan() from public, anon;
grant execute on function public.owns_household(uuid), public.member_of_household(uuid), public.household_plan() to authenticated;

drop policy if exists households_select on public.households;
create policy households_select on public.households for select to authenticated
  using (owner_user_id = auth.uid() or public.member_of_household(id));

drop policy if exists members_select on public.household_members;
create policy members_select on public.household_members for select to authenticated
  using (
    public.owns_household(household_id)
    or user_id = auth.uid()
    or (user_id is null and lower(email) = lower(auth.jwt() ->> 'email'))
  );

-- Claiming an invite: only an unclaimed row addressed to my own login email,
-- and only by attaching my own uid.
drop policy if exists members_claim on public.household_members;
create policy members_claim on public.household_members for update to authenticated
  using (user_id is null and lower(email) = lower(auth.jwt() ->> 'email'))
  with check (user_id = auth.uid() and status = 'active');

-- ...and nothing else on the row: a claim must not be able to move it to
-- another household or rewrite the invited email.
revoke update on public.household_members from anon, authenticated;
grant update (user_id, status, joined_at) on public.household_members to authenticated;
