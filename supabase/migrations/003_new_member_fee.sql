-- =====================================================================
-- Vespa Club Malaysia: separate fees for new members and renewals
-- Run after 001 and 002 (Dashboard -> SQL Editor -> paste -> Run).
-- Safe to run more than once.
--
--   * New member (never had a member number or a paid year): RM130
--   * Renewal (has a member number or has paid before):      RM60
--   The database decides which one applies. Members cannot choose.
--   * Automatic member numbers continue from VCM5020.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Fees (change later in Table Editor -> settings, amounts in sen)
-- ---------------------------------------------------------------------
alter table public.settings
  add column if not exists new_member_fee_cents integer not null default 13000
  check (new_member_fee_cents > 0);
update public.settings set fee_cents = 6000 where fee_cents = 5000;  -- renewal RM60 (only replaces the old default)

-- AJK can read the fees (for the admin page). Members still cannot.
grant select on public.settings to authenticated;
drop policy if exists settings_admin_select on public.settings;
create policy settings_admin_select on public.settings
  for select to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------
-- 2. Record whether each payment was a new membership or a renewal
-- ---------------------------------------------------------------------
alter table public.payments
  add column if not exists kind text not null default 'renewal'
  check (kind in ('new', 'renewal'));

-- ---------------------------------------------------------------------
-- 3. Member numbers continue from VCM5020 (never moves backwards)
-- ---------------------------------------------------------------------
select setval('public.member_no_seq',
              greatest(5019, (select last_value from public.member_no_seq)),
              true);

-- ---------------------------------------------------------------------
-- 4. Quote: decides new vs renewal and the amount
-- ---------------------------------------------------------------------
create or replace function public.is_new_member(p_member_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select m.member_no is null
     and m.expires_on is null
     and not exists (select 1 from public.payments p where p.member_id = m.id and p.status = 'paid')
  from public.members m
  where m.id = p_member_id;
$$;

drop function if exists public.renewal_quote();
create function public.renewal_quote()
returns table (allowed boolean, reason text, coverage_year integer, amount_cents integer, kind text,
               new_fee_cents integer, renewal_fee_cents integer)
language plpgsql stable security definer set search_path = public
as $$
declare
  m public.members%rowtype;
  s public.settings%rowtype;
  today date := public.today_myt();
  y integer := extract(year from today)::integer;
  v_new boolean;
  v_kind text;
  v_amount integer;
begin
  select * into m from public.members where id = auth.uid();
  if not found then
    return query select false, 'Member profile not found.', null::integer, null::integer, null::text, null::integer, null::integer;
    return;
  end if;
  select * into s from public.settings limit 1;
  v_new := public.is_new_member(m.id);
  v_kind := case when v_new then 'new' else 'renewal' end;
  v_amount := case when v_new then s.new_member_fee_cents else s.fee_cents end;

  if m.profile_completed_at is null then
    return query select false, 'Please complete your profile first.', null::integer, v_amount, v_kind, s.new_member_fee_cents, s.fee_cents;
  elsif m.expires_on >= make_date(y + 1, 12, 31) then
    return query select false, format('Your membership is already paid until %s.', to_char(m.expires_on, 'DD Mon YYYY')), null::integer, v_amount, v_kind, s.new_member_fee_cents, s.fee_cents;
  elsif m.expires_on >= make_date(y, 12, 31) then
    if extract(month from today) >= s.renewal_opens_month then
      return query select true, null::text, y + 1, v_amount, v_kind, s.new_member_fee_cents, s.fee_cents;
    else
      return query select false,
        format('Your membership is active until %s. Renewal for %s opens on 1 %s.',
               to_char(m.expires_on, 'DD Mon YYYY'), y + 1,
               trim(to_char(make_date(y, s.renewal_opens_month, 1), 'Month'))),
        null::integer, v_amount, v_kind, s.new_member_fee_cents, s.fee_cents;
    end if;
  else
    return query select true, null::text, y, v_amount, v_kind, s.new_member_fee_cents, s.fee_cents;
  end if;
end;
$$;

create or replace function public.start_renewal()
returns public.payments
language plpgsql security definer set search_path = public
as $$
declare
  q record;
  p public.payments%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not logged in' using errcode = '42501';
  end if;
  select * into q from public.renewal_quote();
  if not q.allowed then
    raise exception '%', q.reason using errcode = 'P0001';
  end if;
  if (select count(*) from public.payments
      where member_id = auth.uid() and status = 'pending'
        and created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'Too many payment attempts. Please wait 10 minutes and try again.' using errcode = 'P0001';
  end if;
  insert into public.payments (member_id, coverage_year, amount_cents, method, kind)
  values (auth.uid(), q.coverage_year, q.amount_cents, 'fpx', q.kind)
  returning * into p;
  return p;
end;
$$;

-- AJK manual payments: kind is worked out the same way.
create or replace function public.admin_record_payment(
  p_member_id uuid, p_coverage_year integer, p_amount_cents integer, p_method text, p_note text default null)
returns public.payments
language plpgsql security definer set search_path = public
as $$
declare
  p public.payments%rowtype;
  v_kind text;
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
  v_kind := case when public.is_new_member(p_member_id) then 'new' else 'renewal' end;
  insert into public.payments (member_id, coverage_year, amount_cents, method, kind, status, note, recorded_by, paid_at)
  values (p_member_id, p_coverage_year, p_amount_cents, p_method, v_kind, 'paid', p_note, auth.jwt() ->> 'email', now())
  returning * into p;
  perform public.apply_paid_payment(p.id);
  return p;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Permissions
-- ---------------------------------------------------------------------
revoke all on function public.renewal_quote(), public.is_new_member(uuid) from public, anon;
grant execute on function public.renewal_quote() to authenticated;
revoke all on function public.is_new_member(uuid) from authenticated;
