-- =====================================================================
-- Vespa Club Malaysia: 012 member price for event tickets / packs
-- An event can have a lower price for active VCM members. "Active" means
-- the membership is still valid on the event date (members who already
-- renewed for next year count too). The member must be logged in to the
-- member portal with a completed profile; the price is decided here, in
-- the database, never by the browser. One member-price order per member
-- per event: extra packs for friends are at the normal price.
-- Run AFTER 011. Safe to run again.
--   turn it on for an event:
--   update public.events set member_price_cents = 4000 where id = 'vespa-day-2026';
-- =====================================================================

alter table public.events add column if not exists member_price_cents integer;
alter table public.events drop constraint if exists events_member_price_check;
alter table public.events add constraint events_member_price_check
  check (member_price_cents is null or (member_price_cents > 0 and member_price_cents < price_cents));

alter table public.event_orders add column if not exists member_id uuid references public.members (id) on delete set null;
create index if not exists event_orders_member on public.event_orders (event_id, member_id) where member_id is not null;

-- Public: the member price shown on the event page (null when there is none).
create or replace function public.event_member_price(p_event text)
returns integer
language sql stable security definer set search_path = public
as $$ select member_price_cents from public.events where id = p_event $$;
revoke all on function public.event_member_price(text) from public;
grant execute on function public.event_member_price(text) to anon, authenticated;

-- Is a member's price slot for this event already taken (paid, or a payment still in progress)?
create or replace function public.event_member_slot_used(p_event text, p_member uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.event_orders o
                  where o.event_id = p_event and o.member_id = p_member
                    and (o.status = 'paid' or (o.status = 'pending' and o.created_at > now() - interval '30 minutes')))
$$;
revoke all on function public.event_member_slot_used(text, uuid) from public, anon, authenticated;

-- For the logged-in member: may they buy at the member price?
-- status: 'ok' | 'used' | 'expired' | 'profile' | 'not_member' | 'none'
create or replace function public.event_member_quote(p_event text)
returns table (status text, member_price_cents integer, price_cents integer, member_no text, full_name text,
               phone text, email text, expires_on date)
language plpgsql stable security definer set search_path = public
as $$
declare
  e public.events%rowtype;
  m public.members%rowtype;
  v_status text;
begin
  select * into e from public.events where id = p_event;
  if not found or e.member_price_cents is null then
    return query select 'none'::text, null::integer, e.price_cents, null::text, null::text, null::text, null::text, null::date;
    return;
  end if;
  select * into m from public.members where id = auth.uid();
  if not found or m.member_no is null then
    v_status := 'not_member';
  elsif m.profile_completed_at is null then
    v_status := 'profile';
  elsif m.expires_on is null or m.expires_on < e.event_date then
    v_status := 'expired';
  elsif public.event_member_slot_used(e.id, m.id) then
    v_status := 'used';
  else
    v_status := 'ok';
  end if;
  return query select v_status, e.member_price_cents, e.price_cents, m.member_no, m.full_name, m.phone, m.email, m.expires_on;
end;
$$;
revoke all on function public.event_member_quote(text) from public, anon;
grant execute on function public.event_member_quote(text) to authenticated;

-- Orders: p_member_user is the logged-in user, passed only by the checkout
-- function after it has verified the login. With it, the member price is
-- used if the member qualifies (otherwise the order is refused with the reason).
drop function if exists public.event_start_order(text, text, text, text, text, text, text);
drop function if exists public.event_start_order(text, text, text, text, text, text, text, text[]);
drop function if exists public.event_start_order(text, text, text, text, text, text, text, text[], text);
drop function if exists public.event_start_order(text, text, text, text, text, text, text, text[], text, uuid);
create function public.event_start_order(
  p_event text, p_full_name text, p_phone text, p_email text, p_moto_type text, p_moto_model text, p_size text,
  p_interests text[] default '{}', p_size_note text default null, p_member_user uuid default null)
returns public.event_orders
language plpgsql security definer set search_path = public
as $$
declare
  e public.events%rowtype;
  m public.members%rowtype;
  v_name  text := upper(left(regexp_replace(btrim(coalesce(p_full_name, '')), '\s+', ' ', 'g'), 120));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_type  text := btrim(coalesce(p_moto_type, ''));
  v_model text := nullif(left(btrim(coalesce(p_moto_model, '')), 80), '');
  v_interests text[];
  v_note  text := nullif(left(btrim(regexp_replace(coalesce(p_size_note, ''), '\s+', ' ', 'g')), 100), '');
  v_amount integer;
  v_member uuid;
  r public.event_orders%rowtype;
begin
  select * into e from public.events where id = p_event for update;
  if not found then raise exception 'Event not found.' using errcode = 'P0001'; end if;
  if not e.is_open or now() >= e.sales_close_at then raise exception 'Ticket sales for this event are closed.' using errcode = 'P0001'; end if;

  v_amount := e.price_cents;
  if p_member_user is not null then
    if e.member_price_cents is null then raise exception 'There is no member price for this event.' using errcode = 'P0001'; end if;
    select * into m from public.members where id = p_member_user;
    if not found or m.member_no is null then
      raise exception 'This login is not linked to a VCM membership. Please WhatsApp the club secretary.' using errcode = 'P0001';
    end if;
    if m.profile_completed_at is null then
      raise exception 'Please complete your member profile first.' using errcode = 'P0001';
    end if;
    if m.expires_on is null or m.expires_on < e.event_date then
      raise exception 'Your membership is not active on the event date. Renew in the member portal to get the member price.' using errcode = 'P0001';
    end if;
    if public.event_member_slot_used(e.id, m.id) then
      raise exception 'You have already bought your member-price pack. Extra packs are at the normal price.' using errcode = 'P0001';
    end if;
    v_amount := e.member_price_cents;
    v_member := m.id;
    v_name := upper(left(regexp_replace(btrim(coalesce(m.full_name, v_name)), '\s+', ' ', 'g'), 120));  -- the member's own pack
  end if;

  if char_length(v_name) < 2 then raise exception 'Please enter your full name.' using errcode = 'P0001'; end if;
  if v_phone !~ '^\+?[0-9][0-9 -]{7,18}$' then raise exception 'Please enter a valid phone number.' using errcode = 'P0001'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'Please enter a valid email address.' using errcode = 'P0001'; end if;
  if not (v_type = any (e.moto_types)) then raise exception 'Please choose your scooter type.' using errcode = 'P0001'; end if;
  if not (p_size = any (e.sizes)) then raise exception 'Please choose a T-shirt size.' using errcode = 'P0001'; end if;
  if p_size = 'Custom' and char_length(coalesce(v_note, '')) < 2 then
    raise exception 'For a Custom size, please enter your pit / chest measurement.' using errcode = 'P0001';
  end if;
  if p_size <> 'Custom' then v_note := null; end if;
  if exists (select 1 from public.event_sizes_left(e.id) l where l.size = p_size and l.sold_out) then
    raise exception 'Size % is sold out. Please choose another size.', p_size using errcode = 'P0001';
  end if;
  if (select count(*) from public.event_orders o
       where o.event_id = e.id and o.status = 'pending' and o.created_at > now() - interval '30 minutes'
         and (o.email = v_email or regexp_replace(o.phone, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g'))) >= 5 then
    raise exception 'Too many unfinished payments. Please wait a few minutes and try again.' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(opt order by ord), '{}') into v_interests
  from unnest(e.interest_options) with ordinality as t(opt, ord)
  where opt = any (coalesce(p_interests, '{}'));

  insert into public.event_orders (event_id, full_name, phone, email, moto_type, moto_model, shirt_size, amount_cents,
                                   interests, size_note, member_id)
  values (e.id, v_name, v_phone, v_email, v_type, v_model, p_size, v_amount, v_interests, v_note, v_member)
  returning * into r;
  return r;
end;
$$;
revoke all on function public.event_start_order(text, text, text, text, text, text, text, text[], text, uuid) from public, anon, authenticated;
grant execute on function public.event_start_order(text, text, text, text, text, text, text, text[], text, uuid) to service_role;
