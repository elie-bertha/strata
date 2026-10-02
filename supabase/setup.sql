-- Strata · friends, invitations and shared Claude credit
-- Run once in Supabase → SQL Editor. Safe to run again.

create table if not exists public.profiles (
  user_id      uuid primary key references auth.users on delete cascade,
  name         text,
  lang         text,
  budget_cents integer not null default 0,     -- credit offered, in US cents
  spent_micro  bigint  not null default 0,     -- spent so far, in millionths of a dollar
  invited_by   uuid references auth.users on delete set null,
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "Read own profile" on public.profiles;
create policy "Read own profile" on public.profiles for select using (auth.uid() = user_id);

create table if not exists public.invites (
  code         text primary key,
  created_by   uuid references auth.users on delete cascade,
  credit_cents integer not null default 0,
  created_at   timestamptz not null default now(),
  used_by      uuid references auth.users on delete set null,
  used_at      timestamptz
);
alter table public.invites enable row level security;
drop policy if exists "Read own invites" on public.invites;
create policy "Read own invites" on public.invites for select using (auth.uid() = created_by);

create table if not exists public.usage (
  id            bigserial primary key,
  user_id       uuid references auth.users on delete cascade,
  at            timestamptz not null default now(),
  model         text,
  input_tokens  integer,
  output_tokens integer,
  searches      integer,
  cost_micro    bigint
);
alter table public.usage enable row level security;
drop policy if exists "Read own usage" on public.usage;
create policy "Read own usage" on public.usage for select using (auth.uid() = user_id);

-- Adds spending atomically and returns what is left (in millionths of a dollar). Only the relay may call it.
create or replace function public.strata_spend(p_uid uuid, p_micro bigint) returns bigint
language sql security definer set search_path = public as $$
  update profiles set spent_micro = spent_micro + p_micro where user_id = p_uid
  returning budget_cents::bigint * 10000 - spent_micro;
$$;
revoke all on function public.strata_spend(uuid, bigint) from public, anon, authenticated;
grant execute on function public.strata_spend(uuid, bigint) to service_role;

-- Today you are the only account: it becomes the admin (unlimited credit, can invite with $2 and top up friends)
insert into public.profiles (user_id, name, is_admin)
select id, coalesce(raw_user_meta_data->>'name', split_part(email, '@', 1)), true from auth.users
on conflict (user_id) do update set is_admin = true;
