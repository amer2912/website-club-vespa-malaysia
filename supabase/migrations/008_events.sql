-- =====================================================================
-- Vespa Club Malaysia: 008 event tickets (ticket + T-shirt) for events
-- run on the club website, including events of partner organisers.
-- Run AFTER 007. Safe to run again.
--
-- events        one row per event: price, sizes, sales close, organiser,
--               and the NAME of the Edge Function secret holding the
--               organiser's ToyyibPay key (money goes straight to them).
-- event_staff   organiser emails for an event: they see that event's buyers
--               and run the pick-up counter. Nothing else.
-- event_orders  one ticket + T-shirt per order. Buyers do not log in; the
--               website writes orders only through the event-checkout and
--               event-callback Edge Functions.
-- =====================================================================

create table if not exists public.events (
  id                      text primary key check (id ~ '^[a-z0-9-]{3,40}$'),
  title                   text not null check (char_length(title) <= 120),
  subtitle                text check (char_length(subtitle) <= 200),
  venue                   text check (char_length(venue) <= 200),
  event_date              date not null,
  sales_close_at          timestamptz not null,
  price_cents             integer not null check (price_cents > 0),
  bill_name               text not null check (char_length(bill_name) <= 30),  -- ToyyibPay limit
  order_prefix            text not null check (order_prefix ~ '^[A-Z0-9]{2,8}$'),
  sizes                   text[] not null default '{XS,S,M,L,XL,2XL}',
  size_stock              jsonb not null default '{}'::jsonb,  -- {"L": 100}; a size not listed has no limit
  moto_types              text[] not null default '{Vespa,Lambretta,Gilera,Italjet,Aprilia,Lain-lain}',
  organizer_name          text not null check (char_length(organizer_name) <= 120),
  organizer_contact       text check (char_length(organizer_contact) <= 200),
  toyyibpay_secret_name   text check (toyyibpay_secret_name ~ '^EVENT_TOYYIBPAY_[A-Z0-9_]{1,40}$'),
  toyyibpay_category_code text check (toyyibpay_category_code ~ '^[A-Za-z0-9]{3,40}$'),
  payment_channel         text not null default '0' check (payment_channel in ('0', '1', '2')),
  is_open                 boolean not null default true,
  next_no                 integer not null default 1,
  created_at              timestamptz not null default now()
);

create table if not exists public.event_staff (
  event_id text not null references public.events (id) on delete cascade,
  email    text not null check (email = lower(email) and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'),
  added_at timestamptz not null default now(),
  primary key (event_id, email)
);

create table if not exists public.event_orders (
  id                 uuid primary key default gen_random_uuid(),
  event_id           text not null references public.events (id),
  order_no           text unique,      -- given when paid, e.g. ISD-0001 (also the lucky draw number)
  ticket_code        text not null unique default replace(gen_random_uuid()::text, '-', ''),
  full_name          text not null check (char_length(full_name) between 2 and 120),
  phone              text not null check (phone ~ '^\+?[0-9][0-9 -]{7,18}$'),
  email              text not null check (email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'),
  moto_type          text not null check (char_length(moto_type) between 1 and 40),
  moto_model         text check (char_length(moto_model) <= 80),
  shirt_size         text not null check (char_length(shirt_size) <= 10),
  amount_cents       integer not null check (amount_cents > 0),
  status             text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  bill_code          text unique,
  provider_ref       text,
  paid_at            timestamptz,
  checked_in_at      timestamptz,
  checked_in_by      text,
  shirt_collected_at timestamptz,
  shirt_collected_by text,
  created_at         timestamptz not null default now()
);
create index if not exists event_orders_event_status on public.event_orders (event_id, status);

alter table public.events       enable row level security;
alter table public.event_staff  enable row level security;
alter table public.event_orders enable row level security;
revoke all on public.events, public.event_staff, public.event_orders from anon, authenticated;
grant select on public.events, public.event_staff, public.event_orders to authenticated;

-- ---------------------------------------------------------------------
-- Who may see / work an event
-- ---------------------------------------------------------------------
create or replace function public.my_email()
returns text language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

-- read: the event's organisers, and VCM AJK (editor or viewer)
create or replace function public.can_read_event(p_event text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.event_staff s where s.event_id = p_event and s.email = public.my_email())
      or public.is_staff();
$$;

-- counter work (check-in, T-shirt pick-up): the event's organisers and VCM editors
create or replace function public.can_work_event(p_event text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.event_staff s where s.event_id = p_event and s.email = public.my_email())
      or public.is_admin();
$$;

drop policy if exists events_staff_select on public.events;
create policy events_staff_select on public.events
  for select to authenticated using (public.can_read_event(id));
drop policy if exists event_staff_select on public.event_staff;
create policy event_staff_select on public.event_staff
  for select to authenticated using (public.can_read_event(event_id));
drop policy if exists event_orders_staff_select on public.event_orders;
create policy event_orders_staff_select on public.event_orders
  for select to authenticated using (public.can_read_event(event_id));

-- An organiser who logs in to the counter page is not a club member: do not
-- create a member account for them (keeps the member lists clean).
create or replace function public.skip_member_row_for_event_staff()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if exists (select 1 from public.event_staff where email = lower(new.email))
     and not exists (select 1 from public.member_import where email = lower(new.email))
     and not exists (select 1 from public.admins where lower(email) = lower(new.email)) then
    return null;
  end if;
  return new;
end;
$$;
drop trigger if exists a_skip_member_row_for_event_staff on public.members;
create trigger a_skip_member_row_for_event_staff
  before insert on public.members
  for each row execute function public.skip_member_row_for_event_staff();

-- ---------------------------------------------------------------------
-- Public: event details for the sales page
-- ---------------------------------------------------------------------
create or replace function public.event_sizes_left(p_event text)
returns table (size text, sold_out boolean)
language sql stable security definer set search_path = public
as $$
  select s.size,
         case when e.size_stock ? s.size then
           (select count(*) from public.event_orders o
             where o.event_id = e.id and o.shirt_size = s.size
               and (o.status = 'paid' or (o.status = 'pending' and o.created_at > now() - interval '30 minutes')))
           >= (e.size_stock ->> s.size)::integer
         else false end
  from public.events e, unnest(e.sizes) as s(size)
  where e.id = p_event;
$$;

drop function if exists public.event_public(text);  -- return type grew in 009
create function public.event_public(p_event text)
returns table (id text, title text, subtitle text, venue text, event_date date, sales_close_at timestamptz,
               price_cents integer, sizes text[], sold_out_sizes text[], moto_types text[],
               organizer_name text, organizer_contact text, open boolean, closed_reason text)
language sql stable security definer set search_path = public
as $$
  select e.id, e.title, e.subtitle, e.venue, e.event_date, e.sales_close_at, e.price_cents, e.sizes,
         coalesce((select array_agg(l.size) from public.event_sizes_left(e.id) l where l.sold_out), '{}'),
         e.moto_types, e.organizer_name, e.organizer_contact,
         e.is_open and now() < e.sales_close_at and e.toyyibpay_secret_name is not null and e.toyyibpay_category_code is not null,
         case when not e.is_open then 'Sales are closed.'
              when now() >= e.sales_close_at then 'Sales closed on ' || to_char(e.sales_close_at at time zone 'Asia/Kuala_Lumpur', 'DD Mon YYYY') || '.'
              when e.toyyibpay_secret_name is null or e.toyyibpay_category_code is null then 'Ticket sales open soon.'
         end
  from public.events e
  where e.id = p_event;
$$;

-- Public: a buyer's own ticket, found by its secret code (the QR code).
create or replace function public.event_ticket(p_code text)
returns table (event_id text, title text, venue text, event_date date, order_no text, full_name text,
               moto_type text, moto_model text, shirt_size text, amount_cents integer, status text,
               paid_at timestamptz, checked_in_at timestamptz, shirt_collected_at timestamptz,
               organizer_name text, organizer_contact text)
language sql stable security definer set search_path = public
as $$
  select o.event_id, e.title, e.venue, e.event_date, o.order_no, o.full_name, o.moto_type, o.moto_model,
         o.shirt_size, o.amount_cents, o.status, o.paid_at, o.checked_in_at, o.shirt_collected_at,
         e.organizer_name, e.organizer_contact
  from public.event_orders o join public.events e on e.id = o.event_id
  where o.ticket_code = lower(btrim(coalesce(p_code, ''))) and p_code ~* '^[0-9a-f]{32}$';
$$;

-- ---------------------------------------------------------------------
-- Server only (Edge Functions with the secret key)
-- ---------------------------------------------------------------------
create or replace function public.event_start_order(
  p_event text, p_full_name text, p_phone text, p_email text, p_moto_type text, p_moto_model text, p_size text)
returns public.event_orders
language plpgsql security definer set search_path = public
as $$
declare
  e public.events%rowtype;
  v_name  text := upper(left(regexp_replace(btrim(coalesce(p_full_name, '')), '\s+', ' ', 'g'), 120));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_type  text := btrim(coalesce(p_moto_type, ''));
  v_model text := nullif(left(btrim(coalesce(p_moto_model, '')), 80), '');
  r public.event_orders%rowtype;
begin
  select * into e from public.events where id = p_event for update;
  if not found then raise exception 'Event not found.' using errcode = 'P0001'; end if;
  if not e.is_open or now() >= e.sales_close_at then raise exception 'Ticket sales for this event are closed.' using errcode = 'P0001'; end if;
  if char_length(v_name) < 2 then raise exception 'Please enter your full name.' using errcode = 'P0001'; end if;
  if v_phone !~ '^\+?[0-9][0-9 -]{7,18}$' then raise exception 'Please enter a valid phone number.' using errcode = 'P0001'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'Please enter a valid email address.' using errcode = 'P0001'; end if;
  if not (v_type = any (e.moto_types)) then raise exception 'Please choose your scooter type.' using errcode = 'P0001'; end if;
  if not (p_size = any (e.sizes)) then raise exception 'Please choose a T-shirt size.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.event_sizes_left(e.id) l where l.size = p_size and l.sold_out) then
    raise exception 'Size % is sold out. Please choose another size.', p_size using errcode = 'P0001';
  end if;
  if (select count(*) from public.event_orders o
       where o.event_id = e.id and o.status = 'pending' and o.created_at > now() - interval '30 minutes'
         and (o.email = v_email or regexp_replace(o.phone, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g'))) >= 5 then
    raise exception 'Too many unfinished payments. Please wait a few minutes and try again.' using errcode = 'P0001';
  end if;
  insert into public.event_orders (event_id, full_name, phone, email, moto_type, moto_model, shirt_size, amount_cents)
  values (e.id, v_name, v_phone, v_email, v_type, v_model, p_size, e.price_cents)
  returning * into r;
  return r;
end;
$$;

create or replace function public.event_mark_paid(p_order uuid, p_provider_ref text, p_amount_cents integer)
returns public.event_orders
language plpgsql security definer set search_path = public
as $$
declare
  o public.event_orders%rowtype;
  v_no integer;
  v_prefix text;
begin
  select * into o from public.event_orders where id = p_order for update;
  if not found then raise exception 'Order not found' using errcode = 'P0001'; end if;
  if o.status = 'paid' then return o; end if;
  if o.amount_cents <> p_amount_cents then
    raise exception 'Amount mismatch for order %: expected %, got %', p_order, o.amount_cents, p_amount_cents;
  end if;
  update public.events set next_no = next_no + 1 where id = o.event_id
  returning next_no - 1, order_prefix into v_no, v_prefix;
  update public.event_orders
     set status = 'paid', paid_at = now(), provider_ref = p_provider_ref,
         order_no = v_prefix || '-' || lpad(v_no::text, 4, '0')
   where id = p_order
  returning * into o;
  return o;
end;
$$;

create or replace function public.event_mark_failed(p_order uuid)
returns void
language sql security definer set search_path = public
as $$ update public.event_orders set status = 'failed' where id = p_order and status = 'pending'; $$;

-- ---------------------------------------------------------------------
-- Counter: look up a ticket by its code and record check-in / T-shirt.
-- p_action: null (look only), 'checkin', 'shirt' or 'both'.
-- ---------------------------------------------------------------------
create or replace function public.event_counter(p_code text, p_action text default null)
returns table (order_id uuid, event_id text, order_no text, full_name text, phone text, moto_type text,
               moto_model text, shirt_size text, status text, checked_in_at timestamptz, checked_in_by text,
               shirt_collected_at timestamptz, shirt_collected_by text, already boolean)
language plpgsql security definer set search_path = public
as $$
declare
  o public.event_orders%rowtype;
  v_code text := lower(substring(coalesce(p_code, '') from '([0-9a-fA-F]{32})'));
  v_me text := public.my_email();
  v_already boolean := false;
begin
  if p_action is not null and p_action not in ('checkin', 'shirt', 'both') then
    raise exception 'Unknown action' using errcode = 'P0001';
  end if;
  select * into o from public.event_orders where ticket_code = v_code for update;
  if not found or not public.can_read_event(o.event_id) then
    raise exception 'Ticket not found for your events.' using errcode = 'P0001';
  end if;
  if p_action is not null then
    if not public.can_work_event(o.event_id) then
      raise exception 'Your account can view this event but not run the counter.' using errcode = '42501';
    end if;
    if o.status <> 'paid' then
      raise exception 'This ticket is not paid.' using errcode = 'P0001';
    end if;
    if p_action in ('checkin', 'both') then
      if o.checked_in_at is not null then v_already := true;
      else update public.event_orders set checked_in_at = now(), checked_in_by = v_me where id = o.id; end if;
    end if;
    if p_action in ('shirt', 'both') then
      if o.shirt_collected_at is not null then v_already := true;
      else update public.event_orders set shirt_collected_at = now(), shirt_collected_by = v_me where id = o.id; end if;
    end if;
    select * into o from public.event_orders where id = o.id;
  end if;
  return query select o.id, o.event_id, o.order_no, o.full_name, o.phone, o.moto_type, o.moto_model, o.shirt_size,
                      o.status, o.checked_in_at, o.checked_in_by, o.shirt_collected_at, o.shirt_collected_by, v_already;
end;
$$;

-- Counter: the events this login may open.
create or replace function public.event_my_events()
returns table (id text, title text, event_date date, can_work boolean)
language sql stable security definer set search_path = public
as $$
  select e.id, e.title, e.event_date, public.can_work_event(e.id)
  from public.events e
  where public.can_read_event(e.id)
  order by e.event_date desc;
$$;

revoke all on function public.event_start_order(text, text, text, text, text, text, text),
  public.event_mark_paid(uuid, text, integer), public.event_mark_failed(uuid),
  public.skip_member_row_for_event_staff()
  from public, anon, authenticated;
grant execute on function public.event_start_order(text, text, text, text, text, text, text),
  public.event_mark_paid(uuid, text, integer), public.event_mark_failed(uuid)
  to service_role;

revoke all on function public.event_public(text), public.event_ticket(text), public.event_sizes_left(text)
  from public;
grant execute on function public.event_public(text), public.event_ticket(text), public.event_sizes_left(text)
  to anon, authenticated;

revoke all on function public.event_counter(text, text), public.event_my_events(),
  public.can_read_event(text), public.can_work_event(text), public.my_email()
  from public, anon;
grant execute on function public.event_counter(text, text), public.event_my_events(),
  public.can_read_event(text), public.can_work_event(text), public.my_email()
  to authenticated;

-- ---- Survey options (same as 009, so running this file again keeps them) ----
alter table public.events       add column if not exists interest_options text[] not null default '{}';
alter table public.event_orders add column if not exists interests        text[] not null default '{}';

update public.events
   set interest_options = '{"Scooter Show competition","Dyno competition"}'
 where id = 'isd-2026' and interest_options = '{}';

-- Public event details now include the survey options.
drop function if exists public.event_public(text);
create function public.event_public(p_event text)
returns table (id text, title text, subtitle text, venue text, event_date date, sales_close_at timestamptz,
               price_cents integer, sizes text[], sold_out_sizes text[], moto_types text[],
               organizer_name text, organizer_contact text, open boolean, closed_reason text, interest_options text[])
language sql stable security definer set search_path = public
as $$
  select e.id, e.title, e.subtitle, e.venue, e.event_date, e.sales_close_at, e.price_cents, e.sizes,
         coalesce((select array_agg(l.size) from public.event_sizes_left(e.id) l where l.sold_out), '{}'),
         e.moto_types, e.organizer_name, e.organizer_contact,
         e.is_open and now() < e.sales_close_at and e.toyyibpay_secret_name is not null and e.toyyibpay_category_code is not null,
         case when not e.is_open then 'Sales are closed.'
              when now() >= e.sales_close_at then 'Sales closed on ' || to_char(e.sales_close_at at time zone 'Asia/Kuala_Lumpur', 'DD Mon YYYY') || '.'
              when e.toyyibpay_secret_name is null or e.toyyibpay_category_code is null then 'Ticket sales open soon.'
         end,
         e.interest_options
  from public.events e
  where e.id = p_event;
$$;
revoke all on function public.event_public(text) from public;
grant execute on function public.event_public(text) to anon, authenticated;

-- Orders take the optional interests (only options listed for the event are kept).
drop function if exists public.event_start_order(text, text, text, text, text, text, text);
drop function if exists public.event_start_order(text, text, text, text, text, text, text, text[]);
create function public.event_start_order(
  p_event text, p_full_name text, p_phone text, p_email text, p_moto_type text, p_moto_model text, p_size text,
  p_interests text[] default '{}')
returns public.event_orders
language plpgsql security definer set search_path = public
as $$
declare
  e public.events%rowtype;
  v_name  text := upper(left(regexp_replace(btrim(coalesce(p_full_name, '')), '\s+', ' ', 'g'), 120));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_type  text := btrim(coalesce(p_moto_type, ''));
  v_model text := nullif(left(btrim(coalesce(p_moto_model, '')), 80), '');
  v_interests text[];
  r public.event_orders%rowtype;
begin
  select * into e from public.events where id = p_event for update;
  if not found then raise exception 'Event not found.' using errcode = 'P0001'; end if;
  if not e.is_open or now() >= e.sales_close_at then raise exception 'Ticket sales for this event are closed.' using errcode = 'P0001'; end if;
  if char_length(v_name) < 2 then raise exception 'Please enter your full name.' using errcode = 'P0001'; end if;
  if v_phone !~ '^\+?[0-9][0-9 -]{7,18}$' then raise exception 'Please enter a valid phone number.' using errcode = 'P0001'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'Please enter a valid email address.' using errcode = 'P0001'; end if;
  if not (v_type = any (e.moto_types)) then raise exception 'Please choose your scooter type.' using errcode = 'P0001'; end if;
  if not (p_size = any (e.sizes)) then raise exception 'Please choose a T-shirt size.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.event_sizes_left(e.id) l where l.size = p_size and l.sold_out) then
    raise exception 'Size % is sold out. Please choose another size.', p_size using errcode = 'P0001';
  end if;
  if (select count(*) from public.event_orders o
       where o.event_id = e.id and o.status = 'pending' and o.created_at > now() - interval '30 minutes'
         and (o.email = v_email or regexp_replace(o.phone, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g'))) >= 5 then
    raise exception 'Too many unfinished payments. Please wait a few minutes and try again.' using errcode = 'P0001';
  end if;
  -- keep only the event's own options, each once, in the event's order
  select coalesce(array_agg(opt order by ord), '{}') into v_interests
  from unnest(e.interest_options) with ordinality as t(opt, ord)
  where opt = any (coalesce(p_interests, '{}'));

  insert into public.event_orders (event_id, full_name, phone, email, moto_type, moto_model, shirt_size, amount_cents, interests)
  values (e.id, v_name, v_phone, v_email, v_type, v_model, p_size, e.price_cents, v_interests)
  returning * into r;
  return r;
end;
$$;
revoke all on function public.event_start_order(text, text, text, text, text, text, text, text[]) from public, anon, authenticated;
grant execute on function public.event_start_order(text, text, text, text, text, text, text, text[]) to service_role;
