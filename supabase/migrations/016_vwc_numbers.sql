-- =====================================================================
-- Vespa Club Malaysia: 016 Vespa World Club (VWC) numbers on the member card
-- Each VCM member number can have a Vespa World Club number (MY + digits).
-- VWC numbers were given to members up to 2023. Kept by VCM member number, so
-- it also works for members who have not logged in yet: the card shows it as
-- soon as their account has that number.
--
--   vwc_numbers             member_no -> vwc_no, source 'member' or 'ajk'
--   my_vwc_no()             the logged-in member's VWC number (card, profile)
--   my_set_vwc_no()         a member adds / changes / clears their own number
--                           in the profile (until the AJK confirm it)
--   admin_set_vwc_no()      AJK editor sets / clears one number (confirmed)
--   admin_import_vwc()      AJK editor pastes many rows at once (confirmed)
--
-- Run AFTER 015. Safe to run again.
-- =====================================================================

create table if not exists public.vwc_numbers (
  member_no  text primary key check (member_no ~ '^VCM-[0-9]{4}$'),
  vwc_no     text not null unique check (vwc_no ~ '^MY[0-9]{4,10}$'),
  updated_at timestamptz not null default now(),
  updated_by text
);
-- 'member' = typed by the member in their profile, 'ajk' = set or confirmed by the AJK
alter table public.vwc_numbers add column if not exists source text not null default 'ajk';
alter table public.vwc_numbers drop constraint if exists vwc_numbers_source_check;
alter table public.vwc_numbers add constraint vwc_numbers_source_check check (source in ('member', 'ajk'));
alter table public.vwc_numbers enable row level security;
revoke all on public.vwc_numbers from anon, authenticated;
grant select on public.vwc_numbers to authenticated;
drop policy if exists vwc_numbers_staff_select on public.vwc_numbers;
create policy vwc_numbers_staff_select on public.vwc_numbers
  for select to authenticated using (public.is_staff());

-- "vcm 4", "VCM-0004", "0004" -> VCM-0004 ; "MY 123-4567" -> MY1234567
create or replace function public.vwc_norm_member_no(p text)
returns text language sql immutable as $$
  select case when m is null then null else 'VCM-' || lpad(ltrim(m[1], '0'), 4, '0') end
  from (select regexp_match(upper(btrim(coalesce(p, ''))), '^(?:VCM)?[\s-]*([0-9]{1,4})$') as m) x;
$$;
create or replace function public.vwc_norm_no(p text)
returns text language sql immutable as $$
  select nullif(regexp_replace(upper(coalesce(p, '')), '[\s-]', '', 'g'), '');
$$;

drop function if exists public.my_vwc_no();
create or replace function public.my_vwc_no()
returns table (vwc_no text, confirmed boolean)
language sql stable security definer set search_path = public
as $$
  select v.vwc_no, v.source = 'ajk' from public.vwc_numbers v
  join public.members m on m.member_no = v.member_no
  where m.id = auth.uid();
$$;

create or replace function public.my_set_vwc_no(p_vwc_no text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_member text;
  v_vwc text := public.vwc_norm_no(p_vwc_no);
  cur public.vwc_numbers%rowtype;
begin
  if auth.uid() is null then raise exception 'Not logged in' using errcode = '42501'; end if;
  select member_no into v_member from public.members where id = auth.uid();
  if v_member is null then
    raise exception 'You can add your Vespa World Club number once you have a VCM member number.' using errcode = 'P0001';
  end if;
  select * into cur from public.vwc_numbers where member_no = v_member;
  if found and cur.source = 'ajk' then
    if cur.vwc_no = coalesce(v_vwc, '') then return cur.vwc_no; end if;
    raise exception 'Your Vespa World Club number was confirmed by the AJK. Please contact the AJK to change it.' using errcode = 'P0001';
  end if;
  if v_vwc is null then
    delete from public.vwc_numbers where member_no = v_member;
    return null;
  end if;
  if v_vwc !~ '^MY[0-9]{4,10}$' then
    raise exception 'Vespa World Club number must start with MY followed by numbers, e.g. MY1234567' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.vwc_numbers where vwc_no = v_vwc and member_no <> v_member) then
    raise exception 'This Vespa World Club number is already registered to another member. Please contact the AJK.' using errcode = 'P0001';
  end if;
  insert into public.vwc_numbers (member_no, vwc_no, source, updated_by)
  values (v_member, v_vwc, 'member', public.my_email())
  on conflict (member_no) do update set vwc_no = excluded.vwc_no, source = 'member', updated_at = now(), updated_by = excluded.updated_by;
  return v_vwc;
end;
$$;

create or replace function public.admin_set_vwc_no(p_member_no text, p_vwc_no text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_member text := public.vwc_norm_member_no(p_member_no);
  v_vwc text := public.vwc_norm_no(p_vwc_no);
  v_other text;
begin
  if not public.is_admin() then
    raise exception 'Only AJK admins can do this' using errcode = '42501';
  end if;
  if v_member is null then raise exception 'Give the member a VCM number first (e.g. VCM-0012)' using errcode = 'P0001'; end if;
  if v_vwc is null then
    delete from public.vwc_numbers where member_no = v_member;
    return null;
  end if;
  if v_vwc !~ '^MY[0-9]{4,10}$' then
    raise exception 'VWC number must look like MY1234567' using errcode = 'P0001';
  end if;
  select member_no into v_other from public.vwc_numbers where vwc_no = v_vwc and member_no <> v_member;
  if found then raise exception 'VWC number % is already given to %', v_vwc, v_other using errcode = 'P0001'; end if;
  insert into public.vwc_numbers (member_no, vwc_no, source, updated_by)
  values (v_member, v_vwc, 'ajk', public.my_email())
  on conflict (member_no) do update set vwc_no = excluded.vwc_no, source = 'ajk', updated_at = now(), updated_by = excluded.updated_by;
  return v_vwc;
end;
$$;

-- p_rows: [{"member_no": "VCM-0004", "vwc_no": "MY1234567"}, ...]
create or replace function public.admin_import_vwc(p_rows jsonb)
returns table (saved integer, unchanged integer, problems text[])
language plpgsql security definer set search_path = public
as $$
declare
  r jsonb;
  v_member text;
  v_vwc text;
  v_other text;
  v_saved integer := 0;
  v_same integer := 0;
  v_problems text[] := '{}';
begin
  if not public.is_admin() then
    raise exception 'Only AJK admins can do this' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 3000 then
    raise exception 'Send up to 3000 rows at a time' using errcode = 'P0001';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_member := public.vwc_norm_member_no(r ->> 'member_no');
    v_vwc := public.vwc_norm_no(r ->> 'vwc_no');
    if v_member is null or v_vwc is null or v_vwc !~ '^MY[0-9]{4,10}$' then
      v_problems := v_problems || format('%s / %s: not a valid VCM or VWC number', coalesce(r ->> 'member_no', '?'), coalesce(r ->> 'vwc_no', '?'));
      continue;
    end if;
    if exists (select 1 from public.vwc_numbers where member_no = v_member and vwc_no = v_vwc and source = 'ajk') then
      v_same := v_same + 1;
      continue;
    end if;
    select member_no into v_other from public.vwc_numbers where vwc_no = v_vwc and member_no <> v_member;
    if found then
      v_problems := v_problems || format('%s: %s is already given to %s', v_member, v_vwc, v_other);
      continue;
    end if;
    insert into public.vwc_numbers (member_no, vwc_no, source, updated_by)
    values (v_member, v_vwc, 'ajk', public.my_email())
    on conflict (member_no) do update set vwc_no = excluded.vwc_no, source = 'ajk', updated_at = now(), updated_by = excluded.updated_by;
    v_saved := v_saved + 1;
  end loop;
  return query select v_saved, v_same, v_problems;
end;
$$;

revoke all on function public.vwc_norm_member_no(text), public.vwc_norm_no(text), public.my_vwc_no(), public.my_set_vwc_no(text),
  public.admin_set_vwc_no(text, text), public.admin_import_vwc(jsonb) from public, anon;
grant execute on function public.my_vwc_no(), public.my_set_vwc_no(text), public.admin_set_vwc_no(text, text), public.admin_import_vwc(jsonb)
  to authenticated;
