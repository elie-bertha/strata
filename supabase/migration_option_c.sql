-- Strata · option C: credit is always paid by the Strata server key.
-- Credit offered in a friend's invitation waits for the admin's approval. No user's own Claude key is stored.
alter table public.profiles add column if not exists requested_cents integer not null default 0;

-- Cleanup of the earlier "friends pay with their own saved key" experiment (columns were never used)
drop function if exists public.strata_set_key(uuid, text);
drop function if exists public.strata_get_key(uuid);
drop function if exists public.strata_clear_key(uuid);
delete from vault.secrets where name like 'strata_key_%';
alter table public.profiles drop column if exists key_secret_id, drop column if exists key_hint, drop column if exists sponsor_id;
alter table public.invites drop column if exists sponsor_id;
