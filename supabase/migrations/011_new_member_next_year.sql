-- =====================================================================
-- Vespa Club Malaysia: 011 new members joining late in the year pay for
-- next year.
-- From the month renewals for next year open (settings.renewal_opens_month,
-- November by default), a NEW member's first payment covers next year
-- (valid until 31 Dec next year) instead of the few weeks left this year.
-- Existing members are unchanged. Run AFTER 010. Safe to run again.
-- =====================================================================

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
  elsif v_new and extract(month from today) >= s.renewal_opens_month then
    -- New members who join once next year's renewal is open (November by
    -- default) pay for NEXT year, so they are not charged for a year that is
    -- almost over.
    return query select true, null::text, y + 1, v_amount, v_kind, s.new_member_fee_cents, s.fee_cents;
  else
    return query select true, null::text, y, v_amount, v_kind, s.new_member_fee_cents, s.fee_cents;
  end if;
end;
$$;

revoke all on function public.renewal_quote() from public, anon;
grant execute on function public.renewal_quote() to authenticated;
