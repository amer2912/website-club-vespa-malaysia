-- =====================================================================
-- Vespa Club Malaysia: 007 AJK roles (editor / viewer)
-- Run AFTER 006. Safe to run again.
--
-- editor : sees everything and can change data (as before).
-- viewer : sees the dashboard, member list and old records, but every
--          change is refused by the database.
--
-- Existing admins become editors. To add a viewer:
--   insert into public.admins (email, role) values ('name@example.com', 'viewer')
--   on conflict (email) do update set role = excluded.role;
-- =====================================================================

alter table public.admins
  add column if not exists role text not null default 'editor';
alter table public.admins drop constraint if exists admins_role_check;
alter table public.admins add constraint admins_role_check check (role in ('editor', 'viewer'));

-- is_admin(): may change data. Every admin_* function already checks it,
-- so viewers are refused everywhere without touching those functions.
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and role = 'editor'
  );
$$;

-- is_staff(): may read AJK data (editor or viewer).
create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- For the website: 'editor', 'viewer' or null.
create or replace function public.my_admin_role()
returns text
language sql stable security definer set search_path = public
as $$
  select role from public.admins
  where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  limit 1;
$$;

revoke all on function public.is_staff(), public.my_admin_role() from public, anon;
grant execute on function public.is_staff(), public.my_admin_role() to authenticated;

-- Reading AJK data: editors and viewers.
drop policy if exists members_select on public.members;
create policy members_select on public.members
  for select to authenticated using (id = auth.uid() or public.is_staff());

drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments
  for select to authenticated using (member_id = auth.uid() or public.is_staff());

drop policy if exists member_import_admin_select on public.member_import;
create policy member_import_admin_select on public.member_import
  for select to authenticated using (public.is_staff());

drop policy if exists settings_admin_select on public.settings;
create policy settings_admin_select on public.settings
  for select to authenticated using (public.is_staff());

do $$
begin
  if to_regclass('public.member_archive') is not null then
    drop policy if exists member_archive_admin_select on public.member_archive;
    create policy member_archive_admin_select on public.member_archive
      for select to authenticated using (public.is_staff());
  end if;
  if to_regclass('public.member_followup') is not null then
    drop policy if exists member_followup_admin_select on public.member_followup;
    create policy member_followup_admin_select on public.member_followup
      for select to authenticated using (public.is_staff());
  end if;
end $$;
