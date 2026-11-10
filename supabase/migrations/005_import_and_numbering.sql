-- =====================================================================
-- Vespa Club Malaysia: member numbers like the master list, and full
-- imports. Run after 001-004. Safe to run more than once.
--
--   * Member numbers use the master-list format "VCM-0519". Numbers typed
--     as VCM0519, vcm 519 or VCM-519 are stored as VCM-0519.
--   * Automatic numbers continue after the highest master-list number
--     (VCM-0518), so the next new member gets VCM-0519.
--   * member_import can carry the whole profile and the 2026 payment, so
--     an imported member sees a complete profile, an active card and the
--     payment in their history on first login.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Member number format
-- ---------------------------------------------------------------------
create or replace function public.clean_member_no(p text)
returns text
language plpgsql immutable
as $$
declare
  v text := nullif(upper(btrim(coalesce(p, ''))), '');
  m text[];
begin
  if v is null then
    return null;
  end if;
  m := regexp_match(v, '^VCM\s*-?\s*0*(\d{1,4})$');
  if m is not null then
    return 'VCM-' || lpad(m[1], 4, '0');
  end if;
  if v !~ '^[A-Z0-9-]{1,20}$' then
    raise exception 'Member number can only use letters, numbers and "-" (max 20)' using errcode = 'P0001';
  end if;
  return v;
end;
$$;

-- Existing numbers: VCM0442 -> VCM-0442 (members and pre-registrations).
update public.member_import set member_no = public.clean_member_no(member_no)
 where member_no is not null and member_no is distinct from public.clean_member_no(member_no);
update public.members set member_no = public.clean_member_no(member_no)
 where member_no is not null and member_no is distinct from public.clean_member_no(member_no);

-- Numbers given automatically after a first payment.
create or replace function public.apply_paid_payment(p_payment_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  p public.payments%rowtype;
  v_no text;
begin
  select * into p from public.payments where id = p_payment_id;
  update public.members
     set expires_on = greatest(coalesce(expires_on, make_date(p.coverage_year, 12, 31)),
                               make_date(p.coverage_year, 12, 31))
   where id = p.member_id;

  if (select member_no from public.members where id = p.member_id) is null then
    loop
      v_no := 'VCM-' || lpad(nextval('public.member_no_seq')::text, 4, '0');
      exit when not exists (select 1 from public.members where member_no = v_no)
            and not exists (select 1 from public.member_import where member_no = v_no);
    end loop;
    update public.members set member_no = v_no where id = p.member_id;
  end if;
end;
$$;
revoke all on function public.apply_paid_payment(uuid) from public, anon, authenticated;

-- Continue after VCM-0518 (or after the highest number already given
-- below 5000, if that is higher). Numbers that are taken are skipped.
select setval('public.member_no_seq',
  greatest(518, coalesce((
    select max((regexp_match(n, '^VCM-(\d{4})$'))[1]::int)
    from (select member_no as n from public.members
          union all select member_no from public.member_import) x
    where n ~ '^VCM-\d{4}$' and (regexp_match(n, '^VCM-(\d{4})$'))[1]::int < 5000), 0)),
  true);

-- ---------------------------------------------------------------------
-- 2. Full profile and payment in the import list
-- ---------------------------------------------------------------------
alter table public.member_import
  add column if not exists nationality             text,
  add column if not exists nric                    text,
  add column if not exists gender                  text,
  add column if not exists age                     smallint,
  add column if not exists address                 text,
  add column if not exists state                   text,
  add column if not exists vespa_model             text,
  add column if not exists plate_no                text,
  add column if not exists beneficiary_name        text,
  add column if not exists beneficiary_nric        text,
  add column if not exists beneficiary_relation    text,
  add column if not exists oku                     text,
  add column if not exists tshirt_size             text,
  add column if not exists club_group              text,
  add column if not exists remark                  text,
  add column if not exists declaration_accepted_at timestamptz,
  add column if not exists paid_year               integer,
  add column if not exists paid_amount_cents       integer,
  add column if not exists paid_kind               text,
  add column if not exists paid_note               text;

-- Keep a value only if it fits the members table rules; otherwise leave it
-- empty for the member to fill in (a first login must never fail).
create or replace function public.import_ok(v text, pattern text, max_len integer default 300)
returns text
language sql immutable
as $$
  select case when nullif(btrim(v), '') is not null
               and char_length(btrim(v)) <= max_len
               and btrim(v) ~ pattern
              then btrim(v) end
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  imp public.member_import%rowtype;
  v_no text;
  v_id text;
  v_bid text;
begin
  select * into imp from public.member_import where email = lower(new.email);

  v_no := public.clean_member_no(imp.member_no);
  if v_no is not null and exists (select 1 from public.members where member_no = v_no) then
    v_no := null;
  end if;
  v_id  := nullif(upper(regexp_replace(coalesce(imp.nric, ''), '[\s-]', '', 'g')), '');
  v_bid := nullif(upper(regexp_replace(coalesce(imp.beneficiary_nric, ''), '[\s-]', '', 'g')), '');

  insert into public.members (
    id, email, member_no, full_name, phone, expires_on, joined_on,
    nationality, nric, gender, age, address, state, vespa_model, plate_no,
    beneficiary_name, beneficiary_nric, beneficiary_relation, oku,
    tshirt_size, club_group, remark, declaration_accepted_at)
  values (
    new.id, lower(new.email), v_no,
    left(nullif(btrim(imp.full_name), ''), 120),
    public.import_ok(imp.phone, '^\+?[0-9][0-9 -]{7,18}$', 20),
    imp.expires_on,
    coalesce(imp.joined_on, public.today_myt()),
    public.import_ok(imp.nationality, '.', 60),
    case when v_id ~ '^[A-Z0-9]{5,20}$' then v_id end,
    case when imp.gender in ('Male', 'Female') then imp.gender end,
    case when imp.age between 5 and 120 then imp.age end,
    public.import_ok(imp.address, '.', 300),
    case when imp.state in ('Johor','Kedah','Kelantan','Melaka','Negeri Sembilan','Pahang',
                            'Perak','Perlis','Pulau Pinang','Sabah','Sarawak','Selangor',
                            'Terengganu','W.P. Kuala Lumpur','W.P. Labuan','W.P. Putrajaya') then imp.state end,
    public.import_ok(imp.vespa_model, '.', 80),
    public.import_ok(imp.plate_no, '.', 20),
    public.import_ok(imp.beneficiary_name, '.', 120),
    case when v_bid ~ '^[A-Z0-9]{5,20}$' then v_bid end,
    public.import_ok(imp.beneficiary_relation, '.', 40),
    public.import_ok(imp.oku, '.', 120),
    case when imp.tshirt_size in ('Not needed','XS','S','M','L','XL','XXL','3XL','4XL','5XL') then imp.tshirt_size end,
    public.import_ok(imp.club_group, '.', 120),
    public.import_ok(imp.remark, '.', 500),
    imp.declaration_accepted_at)
  on conflict (id) do nothing;

  -- Payment already made outside the portal (e.g. the old Google Form).
  if imp.paid_year is not null then
    insert into public.payments (member_id, coverage_year, amount_cents, method, kind, status, note, recorded_by, paid_at)
    values (new.id, imp.paid_year, greatest(coalesce(imp.paid_amount_cents, 0), 0), 'legacy',
            case when imp.paid_kind = 'new' then 'new' else 'renewal' end,
            'paid', coalesce(imp.paid_note, 'Imported from Google Form'), 'import',
            coalesce(imp.declaration_accepted_at, now()));
  end if;
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Import list: tidy email and member number the same way.
create or replace function public.member_import_normalise()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(btrim(new.email));
  new.member_no := public.clean_member_no(new.member_no);
  return new;
end;
$$;
