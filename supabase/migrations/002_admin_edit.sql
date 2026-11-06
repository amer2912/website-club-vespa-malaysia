-- =====================================================================
-- Vespa Club Malaysia: AJK editing tools (run after 001_membership.sql)
-- Dashboard -> SQL Editor -> paste -> Run. Safe to run more than once.
--
-- Adds:
--   * admin_update_member: AJK edit member number, profile and expiry;
--   * "legacy" payments: record members who paid through the old Google Form;
--   * pre-registration: AJK add members who have not logged in yet
--     (stored in member_import and copied on their first login).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Payments recorded from the old Google Form (amount may be unknown: RM0)
-- ---------------------------------------------------------------------
alter table public.payments drop constraint if exists payments_method_check;
alter table public.payments add constraint payments_method_check
  check (method in ('fpx', 'cash', 'transfer', 'legacy'));
alter table public.payments drop constraint if exists payments_amount_cents_check;
alter table public.payments add constraint payments_amount_cents_check
  check (amount_cents > 0 or (method = 'legacy' and amount_cents = 0));

create or replace function public.admin_record_payment(
  p_member_id uuid, p_coverage_year integer, p_amount_cents integer, p_method text, p_note text default null)
returns public.payments
language plpgsql security definer set search_path = public
as $$
declare
  p public.payments%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only AJK admins can record payments' using errcode = '42501';
  end if;
  if p_method not in ('cash', 'transfer', 'legacy') then
    raise exception 'Method must be cash, transfer or legacy (old Google Form)' using errcode = 'P0001';
  end if;
  if p_amount_cents is null or p_amount_cents < 0 or (p_amount_cents = 0 and p_method <> 'legacy') then
    raise exception 'Amount must be more than RM0' using errcode = 'P0001';
  end if;
  insert into public.payments (member_id, coverage_year, amount_cents, method, status, note, recorded_by, paid_at)
  values (p_member_id, p_coverage_year, p_amount_cents, p_method, 'paid', p_note, auth.jwt() ->> 'email', now())
  returning * into p;
  perform public.apply_paid_payment(p.id);
  return p;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------
create or replace function public.clean_member_no(p text)
returns text
language plpgsql immutable
as $$
declare
  v text := nullif(upper(btrim(coalesce(p, ''))), '');
begin
  if v is not null and v !~ '^[A-Z0-9-]{1,20}$' then
    raise exception 'Member number can only use letters, numbers and "-" (max 20)' using errcode = 'P0001';
  end if;
  return v;
end;
$$;

-- A member number must be free in both lists (except for the same person).
create or replace function public.assert_member_no_free(p_no text, p_email text)
returns void
language plpgsql stable security definer set search_path = public
as $$
declare
  other text;
begin
  if p_no is null then return; end if;
  select email into other from public.members where member_no = p_no and email <> lower(p_email) limit 1;
  if found then
    raise exception 'Member number % is already used by %', p_no, other using errcode = 'P0001';
  end if;
  select email into other from public.member_import where member_no = p_no and email <> lower(p_email) limit 1;
  if found then
    raise exception 'Member number % is reserved for % in the pre-registered list', p_no, other using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. AJK edit an existing member (has logged in at least once)
-- ---------------------------------------------------------------------
create or replace function public.admin_update_member(
  p_member_id uuid, p_member_no text, p_full_name text, p_phone text, p_state text,
  p_vespa_model text, p_plate_no text, p_expires_on date)
returns public.members
language plpgsql security definer set search_path = public
as $$
declare
  v_no text := public.clean_member_no(p_member_no);
  v_email text;
  m public.members%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only AJK admins can edit members' using errcode = '42501';
  end if;
  select email into v_email from public.members where id = p_member_id;
  if not found then
    raise exception 'Member not found' using errcode = 'P0001';
  end if;
  perform public.assert_member_no_free(v_no, v_email);
  update public.members
     set member_no = v_no, full_name = p_full_name, phone = p_phone, state = p_state,
         vespa_model = p_vespa_model, plate_no = p_plate_no, expires_on = p_expires_on
   where id = p_member_id
   returning * into m;
  return m;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Pre-registration of members who have not logged in yet
-- ---------------------------------------------------------------------
create or replace function public.admin_upsert_import(
  p_email text, p_member_no text, p_full_name text, p_phone text, p_expires_on date)
returns public.member_import
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_no text := public.clean_member_no(p_member_no);
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  r public.member_import%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only AJK admins can pre-register members' using errcode = '42501';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    raise exception 'Please enter a valid email address' using errcode = 'P0001';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9][0-9 -]{7,18}$' then
    raise exception 'Please enter a valid phone number' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.members where email = v_email) then
    raise exception 'This email already has a portal account. Use Edit in the members list instead.' using errcode = 'P0001';
  end if;
  perform public.assert_member_no_free(v_no, v_email);
  insert into public.member_import (email, member_no, full_name, phone, expires_on)
  values (v_email, v_no, left(nullif(btrim(coalesce(p_full_name, '')), ''), 120), v_phone, p_expires_on)
  on conflict (email) do update
    set member_no = excluded.member_no, full_name = excluded.full_name,
        phone = excluded.phone, expires_on = excluded.expires_on
  returning * into r;
  return r;
end;
$$;

create or replace function public.admin_delete_import(p_email text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only AJK admins can remove pre-registered members' using errcode = '42501';
  end if;
  delete from public.member_import where email = lower(btrim(p_email));
end;
$$;

-- AJK can read the pre-registered list.
grant select on public.member_import to authenticated;
drop policy if exists member_import_admin_select on public.member_import;
create policy member_import_admin_select on public.member_import
  for select to authenticated
  using (public.is_admin());

-- First login: never fail because of an imported value. A number already
-- taken or a badly formatted phone is simply left empty for the AJK to fix.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  imp public.member_import%rowtype;
begin
  select * into imp from public.member_import where email = lower(new.email);
  insert into public.members (id, email, member_no, full_name, phone, expires_on, joined_on)
  values (
    new.id,
    lower(new.email),
    case when imp.member_no is not null
          and not exists (select 1 from public.members where member_no = imp.member_no)
         then imp.member_no end,
    left(imp.full_name, 120),
    case when imp.phone ~ '^\+?[0-9][0-9 -]{7,18}$' then imp.phone end,
    imp.expires_on,
    coalesce(imp.joined_on, public.today_myt()))
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Permissions
-- ---------------------------------------------------------------------
revoke all on function public.admin_update_member(uuid, text, text, text, text, text, text, date),
  public.admin_upsert_import(text, text, text, text, date), public.admin_delete_import(text),
  public.admin_record_payment(uuid, integer, integer, text, text)
  from public, anon;
grant execute on function public.admin_update_member(uuid, text, text, text, text, text, text, date),
  public.admin_upsert_import(text, text, text, text, date), public.admin_delete_import(text),
  public.admin_record_payment(uuid, integer, integer, text, text)
  to authenticated;
revoke all on function public.assert_member_no_free(text, text), public.handle_new_user()
  from public, anon, authenticated;
