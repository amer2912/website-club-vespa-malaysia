-- =====================================================================
-- Vespa Club Malaysia: 015 change a buyer's T-shirt size (super admin only)
-- A buyer who picked the wrong size can be changed at the event counter,
-- but ONLY by an AJK marked as super admin. Counter accounts (ISD1, VD1 …),
-- event organisers and other AJK editors cannot.
--
--   admins.is_super        true for the super admin(s)
--   event_change_size()    changes a paid ticket's size, keeps a record of
--                          the old size, who changed it and when
--   event_size_options()   sizes the counter page may offer (super admin only)
--
-- After running this file, mark yourself (your AJK login email):
--   update public.admins set is_super = true, role = 'editor'
--   where lower(email) = lower('your-email@example.com');
--
-- Run AFTER 014. Safe to run again.
-- =====================================================================

alter table public.admins add column if not exists is_super boolean not null default false;

alter table public.event_orders add column if not exists size_changed_from text;
alter table public.event_orders add column if not exists size_changed_at timestamptz;
alter table public.event_orders add column if not exists size_changed_by text;
alter table public.event_orders drop constraint if exists event_orders_size_changed_from_check;
alter table public.event_orders add constraint event_orders_size_changed_from_check check (char_length(size_changed_from) <= 10);

-- Super admin: an AJK editor with is_super = true.
create or replace function public.is_super_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and role = 'editor' and is_super
  );
$$;

-- Counter page: the sizes a super admin may choose for this event; null for everyone else.
create or replace function public.event_size_options(p_event text)
returns text[]
language sql stable security definer set search_path = public
as $$
  select e.sizes from public.events e where e.id = p_event and public.is_super_admin();
$$;

create or replace function public.event_change_size(p_order uuid, p_size text, p_note text default null)
returns table (order_id uuid, order_no text, shirt_size text, size_note text,
               size_changed_from text, size_changed_at timestamptz, size_changed_by text)
language plpgsql security definer set search_path = public
as $$
declare
  o public.event_orders%rowtype;
  e public.events%rowtype;
  v_size text := btrim(coalesce(p_size, ''));
  v_note text := nullif(left(btrim(regexp_replace(coalesce(p_note, ''), '\s+', ' ', 'g')), 100), '');
  v_taken integer;
begin
  if not public.is_super_admin() then
    raise exception 'Only the super admin can change sizes.' using errcode = '42501';
  end if;
  select * into o from public.event_orders where id = p_order for update;
  if not found then raise exception 'Ticket not found.' using errcode = 'P0001'; end if;
  if o.status <> 'paid' then raise exception 'This ticket is not paid.' using errcode = 'P0001'; end if;
  select * into e from public.events where id = o.event_id;
  if not (v_size = any (e.sizes)) then
    raise exception 'Size % is not sold for this event.', v_size using errcode = 'P0001';
  end if;
  if v_size = 'Custom' and v_note is null then
    raise exception 'Please write the custom size.' using errcode = 'P0001';
  end if;
  if v_size = o.shirt_size and coalesce(v_note, '') = coalesce(o.size_note, '') then
    raise exception 'The ticket already has size %.', v_size using errcode = 'P0001';
  end if;
  -- A size with a stock limit: do not go over it.
  if v_size <> o.shirt_size and e.size_stock ? v_size then
    select count(*) into v_taken from public.event_orders x
     where x.event_id = e.id and x.shirt_size = v_size and x.id <> o.id
       and (x.status = 'paid' or (x.status = 'pending' and x.created_at > now() - interval '30 minutes'));
    if v_taken >= (e.size_stock ->> v_size)::integer then
      raise exception 'Size % is sold out.', v_size using errcode = 'P0001';
    end if;
  end if;

  update public.event_orders x
     set shirt_size        = v_size,
         size_note         = case when v_size = 'Custom' then v_note end,
         -- keep the size the buyer first paid for, even after several changes
         size_changed_from = coalesce(x.size_changed_from, o.shirt_size),
         size_changed_at   = now(),
         size_changed_by   = public.my_email()
   where x.id = o.id
  returning * into o;
  return query select o.id, o.order_no, o.shirt_size, o.size_note, o.size_changed_from, o.size_changed_at, o.size_changed_by;
end;
$$;

revoke all on function public.is_super_admin(), public.event_size_options(text), public.event_change_size(uuid, text, text)
  from public, anon;
grant execute on function public.is_super_admin(), public.event_size_options(text), public.event_change_size(uuid, text, text)
  to authenticated;
