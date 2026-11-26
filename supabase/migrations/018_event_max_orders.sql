-- =====================================================================
-- Vespa Club Malaysia: 018 overall order limit per event
-- events.max_orders: the most paid orders an event may have (all sizes
-- together). Empty = no overall limit (per-size limits in size_stock
-- still apply).
--   * A new order is refused once paid orders plus orders being paid right
--     now (pending, less than 30 minutes old) reach the limit, so the last
--     packs cannot be oversold.
--   * When the limit is reached, the event closes itself (is_open = false),
--     so the event page shows sales as closed.
-- Works for website checkout, counter walk-ins and manual group orders.
-- Run AFTER 017. Safe to run again.
-- =====================================================================

alter table public.events add column if not exists max_orders integer;
alter table public.events drop constraint if exists events_max_orders_check;
alter table public.events add constraint events_max_orders_check check (max_orders is null or max_orders > 0);

create or replace function public.event_orders_check_limit()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_max integer;
  v_taken integer;
begin
  select max_orders into v_max from public.events where id = new.event_id for update;
  if v_max is null then return new; end if;
  select count(*) into v_taken from public.event_orders o
   where o.event_id = new.event_id
     and (o.status = 'paid' or (o.status = 'pending' and o.created_at > now() - interval '30 minutes'));
  if v_taken >= v_max then
    raise exception 'Sold out · Habis dijual.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists event_orders_limit on public.event_orders;
create trigger event_orders_limit
  before insert on public.event_orders
  for each row execute function public.event_orders_check_limit();

-- Close the event once the paid orders reach the limit.
create or replace function public.event_orders_close_when_full()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_max integer;
begin
  select max_orders into v_max from public.events where id = new.event_id;
  if v_max is not null
     and (select count(*) from public.event_orders where event_id = new.event_id and status = 'paid') >= v_max then
    update public.events set is_open = false where id = new.event_id and is_open;
  end if;
  return null;
end;
$$;

drop trigger if exists event_orders_full on public.event_orders;
create trigger event_orders_full
  after update of status on public.event_orders
  for each row when (new.status = 'paid' and old.status is distinct from 'paid')
  execute function public.event_orders_close_when_full();

revoke all on function public.event_orders_check_limit(), public.event_orders_close_when_full() from public, anon, authenticated;
