-- =====================================================================
-- Vespa Club Malaysia: 010 "Custom" T-shirt size with a pit / chest note
-- Buyers who choose the Custom size must give their measurement; it is
-- stored in event_orders.size_note and shown at the counter and in the CSV.
-- Run AFTER 009. Safe to run again.
--   add the size to an event:
--   update public.events set sizes = array_append(sizes, 'Custom')
--    where id = 'isd-2026' and not ('Custom' = any (sizes));
--   stop new Custom orders later (shows "Sold out" on that size):
--   update public.events set size_stock = size_stock || '{"Custom": 0}' where id = 'isd-2026';
-- =====================================================================

alter table public.event_orders add column if not exists size_note text;
alter table public.event_orders drop constraint if exists event_orders_size_note_check;
alter table public.event_orders add constraint event_orders_size_note_check check (char_length(size_note) <= 100);

-- Orders take the optional interests (only options listed for the event are kept)
-- and, for the "Custom" size, the buyer's pit / chest measurement.
drop function if exists public.event_start_order(text, text, text, text, text, text, text);
drop function if exists public.event_start_order(text, text, text, text, text, text, text, text[]);
drop function if exists public.event_start_order(text, text, text, text, text, text, text, text[], text);
create function public.event_start_order(
  p_event text, p_full_name text, p_phone text, p_email text, p_moto_type text, p_moto_model text, p_size text,
  p_interests text[] default '{}', p_size_note text default null)
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
  v_note  text := nullif(left(btrim(regexp_replace(coalesce(p_size_note, ''), '\s+', ' ', 'g')), 100), '');
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
  -- keep only the event's own options, each once, in the event's order
  select coalesce(array_agg(opt order by ord), '{}') into v_interests
  from unnest(e.interest_options) with ordinality as t(opt, ord)
  where opt = any (coalesce(p_interests, '{}'));

  insert into public.event_orders (event_id, full_name, phone, email, moto_type, moto_model, shirt_size, amount_cents, interests, size_note)
  values (e.id, v_name, v_phone, v_email, v_type, v_model, p_size, e.price_cents, v_interests, v_note)
  returning * into r;
  return r;
end;
$$;
revoke all on function public.event_start_order(text, text, text, text, text, text, text, text[], text) from public, anon, authenticated;
grant execute on function public.event_start_order(text, text, text, text, text, text, text, text[], text) to service_role;
