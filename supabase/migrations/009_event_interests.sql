-- =====================================================================
-- Vespa Club Malaysia: 009 optional "interested in" survey on event orders
-- e.g. ISD 2.0: Scooter Show competition, Dyno competition (tick any).
-- Run AFTER 008. Safe to run again.
-- =====================================================================

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
