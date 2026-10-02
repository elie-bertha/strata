-- Strata · friends can offer credit from their own Claude key (stored encrypted in Supabase Vault)
alter table public.profiles
  add column if not exists server_paid boolean not null default false,          -- credit paid by the Strata server key (invited by the admin)
  add column if not exists sponsor_id uuid references auth.users on delete set null, -- credit paid by this friend's own key
  add column if not exists key_secret_id uuid,                                  -- this user's own Claude key, in Vault
  add column if not exists key_hint text;
alter table public.invites
  add column if not exists server_paid boolean not null default false,
  add column if not exists sponsor_id uuid references auth.users on delete set null;
-- invitations already sent by the admin with credit are paid by the server
update public.invites set server_paid = true
 where credit_cents > 0 and sponsor_id is null and created_by in (select user_id from public.profiles where is_admin);
update public.profiles set server_paid = true
 where not is_admin and budget_cents > 0 and sponsor_id is null and invited_by in (select user_id from public.profiles where is_admin);

create or replace function public.strata_set_key(p_uid uuid, p_key text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare sid uuid; nm text := 'strata_key_' || p_uid::text;
begin
  select key_secret_id into sid from profiles where user_id = p_uid;
  if sid is not null and exists (select 1 from vault.secrets where id = sid) then
    perform vault.update_secret(sid, p_key);
  else
    delete from vault.secrets where name = nm;
    sid := vault.create_secret(p_key, nm, 'Claude key of a Strata user, used only for the credit they offer to friends');
  end if;
  update profiles set key_secret_id = sid, key_hint = right(p_key, 4) where user_id = p_uid;
end $$;

create or replace function public.strata_get_key(p_uid uuid) returns text
language sql security definer set search_path = public, vault as $$
  select ds.decrypted_secret from vault.decrypted_secrets ds join profiles p on p.key_secret_id = ds.id where p.user_id = p_uid;
$$;

create or replace function public.strata_clear_key(p_uid uuid) returns void
language plpgsql security definer set search_path = public, vault as $$
declare sid uuid;
begin
  select key_secret_id into sid from profiles where user_id = p_uid;
  if sid is not null then delete from vault.secrets where id = sid; end if;
  update profiles set key_secret_id = null, key_hint = null where user_id = p_uid;
end $$;

revoke all on function public.strata_set_key(uuid, text) from public, anon, authenticated;
revoke all on function public.strata_get_key(uuid) from public, anon, authenticated;
revoke all on function public.strata_clear_key(uuid) from public, anon, authenticated;
grant execute on function public.strata_set_key(uuid, text) to service_role;
grant execute on function public.strata_get_key(uuid) to service_role;
grant execute on function public.strata_clear_key(uuid) to service_role;
