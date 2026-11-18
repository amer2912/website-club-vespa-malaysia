-- =====================================================================
-- Vespa Club Malaysia: 013 pause online payments with a clear message
-- Lets the AJK stop new online payments at once (for example while moving
-- to another payment provider) and show visitors why:
--   * events.closed_message   shown on an event page when is_open = false
--   * settings.online_payments_paused / payments_paused_message
--                              stops membership payments in the portal
-- Paid tickets, QR codes, the counter and the portal login keep working.
-- Run AFTER 012. Safe to run again. No website or function change needed.
-- =====================================================================

alter table public.events add column if not exists closed_message text;
alter table public.events drop constraint if exists events_closed_message_check;
alter table public.events add constraint events_closed_message_check check (char_length(closed_message) <= 400);

alter table public.settings add column if not exists online_payments_paused boolean not null default false;
alter table public.settings add column if not exists payments_paused_message text;
alter table public.settings drop constraint if exists settings_payments_paused_message_check;
alter table public.settings add constraint settings_payments_paused_message_check check (char_length(payments_paused_message) <= 400);

-- Event page: a closed event shows the AJK's message (same columns as before).
create or replace function public.event_public(p_event text)
returns table (id text, title text, subtitle text, venue text, event_date date, sales_close_at timestamptz,
               price_cents integer, sizes text[], sold_out_sizes text[], moto_types text[],
               organizer_name text, organizer_contact text, open boolean, closed_reason text, interest_options text[])
language sql stable security definer set search_path = public
as $$
  select e.id, e.title, e.subtitle, e.venue, e.event_date, e.sales_close_at, e.price_cents, e.sizes,
         coalesce((select array_agg(l.size) from public.event_sizes_left(e.id) l where l.sold_out), '{}'),
         e.moto_types, e.organizer_name, e.organizer_contact,
         e.is_open and now() < e.sales_close_at and e.toyyibpay_secret_name is not null and e.toyyibpay_category_code is not null,
         case when not e.is_open then coalesce(nullif(btrim(e.closed_message), ''), 'Sales are closed.')
              when now() >= e.sales_close_at then 'Sales closed on ' || to_char(e.sales_close_at at time zone 'Asia/Kuala_Lumpur', 'DD Mon YYYY') || '.'
              when e.toyyibpay_secret_name is null or e.toyyibpay_category_code is null then 'Ticket sales open soon.'
         end,
         e.interest_options
  from public.events e
  where e.id = p_event;
$$;
revoke all on function public.event_public(text) from public;
grant execute on function public.event_public(text) to anon, authenticated;

-- Member portal: while payments are paused, renewal_quote says why and
-- start_renewal (which checks renewal_quote) refuses new bills.
create or replace function public.renewal_quote()
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

  if s.online_payments_paused then
    return query select false,
      coalesce(nullif(btrim(s.payments_paused_message), ''), 'Online payment is paused for now. Please check back soon.'),
      null::integer, v_amount, v_kind, s.new_member_fee_cents, s.fee_cents;
  elsif m.profile_completed_at is null then
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
    return query select true, null::text, y + 1, v_amount, v_kind, s.new_member_fee_cents, s.fee_cents;
  else
    return query select true, null::text, y, v_amount, v_kind, s.new_member_fee_cents, s.fee_cents;
  end if;
end;
$$;
revoke all on function public.renewal_quote() from public, anon;
grant execute on function public.renewal_quote() to authenticated;
