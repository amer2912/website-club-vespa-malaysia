-- =====================================================================
-- Vespa Club Malaysia: 006 old records (archive) and AJK follow-up
-- Run AFTER 005. Safe to run again.
--
-- member_archive : past members who cannot log in yet (no email, left
--                  the group, unclear records). AJK only. When AJK gets
--                  a member's email, admin_archive_to_import moves the
--                  record to the pre-registered list so the member keeps
--                  the old number on first login.
-- member_followup: per member number, the date a notice of unpaid fees
--                  was sent and a short AJK note (club constitution:
--                  arrears of more than three years' fees end the
--                  membership; legal action needs proof of notice).
-- =====================================================================

create table if not exists public.member_archive (
  member_no      text primary key check (member_no ~ '^VCM-[0-9]{4}$'),
  full_name      text check (char_length(full_name) <= 120),
  phone          text check (phone is null or phone ~ '^\+?[0-9][0-9 -]{7,18}$'),
  email          text check (email is null or email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'),
  last_paid_year integer check (last_paid_year between 2000 and 2100),
  note           text check (char_length(note) <= 500),
  updated_at     timestamptz not null default now(),
  updated_by     text
);

create table if not exists public.member_followup (
  member_no           text primary key check (member_no ~ '^VCM-[0-9]{4}$'),
  debt_notice_sent_on date,
  ajk_note            text check (char_length(ajk_note) <= 500),
  updated_at          timestamptz not null default now(),
  updated_by          text
);

alter table public.member_archive  enable row level security;
alter table public.member_followup enable row level security;
revoke all on public.member_archive, public.member_followup from anon, authenticated;
grant select on public.member_archive, public.member_followup to authenticated;

drop policy if exists member_archive_admin_select on public.member_archive;
create policy member_archive_admin_select on public.member_archive
  for select to authenticated using (public.is_admin());
drop policy if exists member_followup_admin_select on public.member_followup;
create policy member_followup_admin_select on public.member_followup
  for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------
-- AJK: add or edit an old record
-- ---------------------------------------------------------------------
create or replace function public.admin_upsert_archive(
  p_member_no text, p_full_name text, p_phone text, p_email text, p_last_paid_year integer, p_note text)
returns public.member_archive
language plpgsql security definer set search_path = public
as $$
declare
  v_no    text := public.clean_member_no(p_member_no);
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  r public.member_archive%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only AJK admins can edit old records' using errcode = '42501';
  end if;
  if v_no is null or v_no !~ '^VCM-[0-9]{4}$' then
    raise exception 'Please enter a member number like VCM-0123' using errcode = 'P0001';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9][0-9 -]{7,18}$' then
    raise exception 'Please enter a valid phone number' using errcode = 'P0001';
  end if;
  if v_email is not null and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    raise exception 'Please enter a valid email address' using errcode = 'P0001';
  end if;
  if p_last_paid_year is not null and p_last_paid_year not between 2000 and 2100 then
    raise exception 'Please check the last year paid' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.members where member_no = v_no)
     or exists (select 1 from public.member_import where member_no = v_no) then
    raise exception 'Member number % is already in the portal (account or pre-registered list)', v_no using errcode = 'P0001';
  end if;
  insert into public.member_archive (member_no, full_name, phone, email, last_paid_year, note, updated_at, updated_by)
  values (v_no, left(nullif(btrim(coalesce(p_full_name, '')), ''), 120), v_phone, v_email, p_last_paid_year,
          left(nullif(btrim(coalesce(p_note, '')), ''), 500), now(), auth.jwt() ->> 'email')
  on conflict (member_no) do update
    set full_name = excluded.full_name, phone = excluded.phone, email = excluded.email,
        last_paid_year = excluded.last_paid_year, note = excluded.note,
        updated_at = now(), updated_by = excluded.updated_by
  returning * into r;
  return r;
end;
$$;

create or replace function public.admin_delete_archive(p_member_no text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only AJK admins can remove old records' using errcode = '42501';
  end if;
  delete from public.member_archive where member_no = public.clean_member_no(p_member_no);
end;
$$;

-- ---------------------------------------------------------------------
-- AJK: old record -> pre-registered list (member can then log in and
-- keeps the old number). Membership stays expired until they renew.
-- ---------------------------------------------------------------------
create or replace function public.admin_archive_to_import(p_member_no text, p_email text)
returns public.member_import
language plpgsql security definer set search_path = public
as $$
declare
  a public.member_archive%rowtype;
  r public.member_import%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only AJK admins can move old records' using errcode = '42501';
  end if;
  select * into a from public.member_archive where member_no = public.clean_member_no(p_member_no) for update;
  if not found then
    raise exception 'Old record not found' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.member_import where email = lower(btrim(coalesce(p_email, '')))) then
    raise exception 'This email is already in the pre-registered list' using errcode = 'P0001';
  end if;
  delete from public.member_archive where member_no = a.member_no;
  r := public.admin_upsert_import(p_email, a.member_no, a.full_name, a.phone,
         case when a.last_paid_year is not null then make_date(a.last_paid_year, 12, 31) end);
  return r;
end;
$$;

-- ---------------------------------------------------------------------
-- AJK: notice of unpaid fees and note, for any member number
-- ---------------------------------------------------------------------
create or replace function public.admin_set_followup(p_member_no text, p_notice_sent_on date, p_note text)
returns public.member_followup
language plpgsql security definer set search_path = public
as $$
declare
  v_no text := public.clean_member_no(p_member_no);
  r public.member_followup%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only AJK admins can update follow-up notes' using errcode = '42501';
  end if;
  if v_no is null or v_no !~ '^VCM-[0-9]{4}$' then
    raise exception 'This member has no member number yet' using errcode = 'P0001';
  end if;
  if p_notice_sent_on > public.today_myt() then
    raise exception 'The notice date cannot be in the future' using errcode = 'P0001';
  end if;
  insert into public.member_followup (member_no, debt_notice_sent_on, ajk_note, updated_at, updated_by)
  values (v_no, p_notice_sent_on, left(nullif(btrim(coalesce(p_note, '')), ''), 500), now(), auth.jwt() ->> 'email')
  on conflict (member_no) do update
    set debt_notice_sent_on = excluded.debt_notice_sent_on, ajk_note = excluded.ajk_note,
        updated_at = now(), updated_by = excluded.updated_by
  returning * into r;
  return r;
end;
$$;

revoke all on function public.admin_upsert_archive(text, text, text, text, integer, text),
  public.admin_delete_archive(text), public.admin_archive_to_import(text, text),
  public.admin_set_followup(text, date, text)
  from public, anon;
grant execute on function public.admin_upsert_archive(text, text, text, text, integer, text),
  public.admin_delete_archive(text), public.admin_archive_to_import(text, text),
  public.admin_set_followup(text, date, text)
  to authenticated;
