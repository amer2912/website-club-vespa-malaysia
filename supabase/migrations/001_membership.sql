-- =====================================================================
-- Vespa Club Malaysia: membership system
-- Run once in Supabase: Dashboard -> SQL Editor -> paste -> Run.
--
-- Rules enforced here (not only in the website):
--   * a member can read and edit only their own profile fields;
--   * a member can never change their own status, expiry date or member
--     number: those change only when a payment is confirmed;
--   * only AJK listed in public.admins can see every member.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Settings (one row). Change the fee in Table Editor -> settings.
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id                  boolean primary key default true check (id),
  fee_cents           integer  not null default 5000 check (fee_cents > 0), -- RM50.00
  renewal_opens_month smallint not null default 11 check (renewal_opens_month between 1 and 12),
  updated_at          timestamptz not null default now()
);
insert into public.settings default values on conflict do nothing;

-- ---------------------------------------------------------------------
-- AJK with admin access: add a row with their login email.
-- ---------------------------------------------------------------------
create table if not exists public.admins (
  email    text primary key,
  added_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Existing members to import (Table Editor -> member_import -> Import CSV).
-- When someone logs in for the first time with a matching email, their
-- member number, name, phone and expiry are copied into their profile.
-- ---------------------------------------------------------------------
create table if not exists public.member_import (
  email      text primary key,
  member_no  text unique,
  full_name  text,
  phone      text,
  expires_on date,
  joined_on  date
);

create sequence if not exists public.member_no_seq start 1;

-- ---------------------------------------------------------------------
-- Members (one row per login account)
-- ---------------------------------------------------------------------
create table if not exists public.members (
  id                   uuid primary key references auth.users (id) on delete cascade,
  email                text not null,
  member_no            text unique,
  full_name            text check (char_length(full_name) <= 120),
  phone                text check (phone ~ '^\+?[0-9][0-9 -]{7,18}$'),
  state                text check (state in (
                         'Johor','Kedah','Kelantan','Melaka','Negeri Sembilan','Pahang',
                         'Perak','Perlis','Pulau Pinang','Sabah','Sarawak','Selangor',
                         'Terengganu','W.P. Kuala Lumpur','W.P. Labuan','W.P. Putrajaya')),
  vespa_model          text check (char_length(vespa_model) <= 80),
  plate_no             text check (char_length(plate_no) <= 20),
  expires_on           date,
  joined_on            date not null default current_date,
  profile_completed_at timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Payments (FPX via ToyyibPay, or cash / transfer recorded by AJK)
-- ---------------------------------------------------------------------
create table if not exists public.payments (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid not null references public.members (id) on delete cascade,
  coverage_year integer not null check (coverage_year between 2019 and 2100),
  amount_cents  integer not null check (amount_cents > 0),
  method        text not null default 'fpx' check (method in ('fpx', 'cash', 'transfer')),
  status        text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  bill_code     text unique,
  provider_ref  text,
  note          text,
  recorded_by   text,
  created_at    timestamptz not null default now(),
  paid_at       timestamptz
);
create index if not exists payments_member_idx on public.payments (member_id, created_at desc);

-- =====================================================================
-- Helpers
-- =====================================================================
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.today_myt()
returns date
language sql stable
as $$ select (now() at time zone 'Asia/Kuala_Lumpur')::date $$;

-- Tidy profile fields and keep profile_completed_at in step.
create or replace function public.members_before_write()
returns trigger
language plpgsql
as $$
begin
  new.full_name   := nullif(btrim(new.full_name), '');
  new.phone       := nullif(btrim(new.phone), '');
  new.state       := nullif(btrim(new.state), '');
  new.vespa_model := nullif(btrim(new.vespa_model), '');
  new.plate_no    := upper(nullif(btrim(new.plate_no), ''));
  new.updated_at  := now();
  if new.full_name is not null and new.phone is not null
     and new.state is not null and new.vespa_model is not null then
    new.profile_completed_at := coalesce(new.profile_completed_at, now());
  else
    new.profile_completed_at := null;
  end if;
  return new;
end;
$$;
drop trigger if exists members_before_write on public.members;
create trigger members_before_write
  before insert or update on public.members
  for each row execute function public.members_before_write();

create or replace function public.member_import_normalise()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(btrim(new.email));
  new.member_no := nullif(upper(btrim(new.member_no)), '');
  return new;
end;
$$;
drop trigger if exists member_import_normalise on public.member_import;
create trigger member_import_normalise
  before insert or update on public.member_import
  for each row execute function public.member_import_normalise();

-- Create a member row for every new login account.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  imp public.member_import%rowtype;
begin
  select * into imp from public.member_import where email = lower(new.email);
  insert into public.members (id, email, member_no, full_name, phone, expires_on, joined_on)
  values (new.id, lower(new.email), imp.member_no, imp.full_name, imp.phone,
          imp.expires_on, coalesce(imp.joined_on, public.today_myt()))
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
-- Renewal
-- Membership follows the calendar year (1 Jan to 31 Dec, Malaysia time).
-- A member who is active for this year can pay for next year from
-- settings.renewal_opens_month (November by default).
-- =====================================================================
-- (dropped first so this file can be re-run after 003 changed its columns)
drop function if exists public.renewal_quote();
create function public.renewal_quote()
returns table (allowed boolean, reason text, coverage_year integer, amount_cents integer)
language plpgsql stable security definer set search_path = public
as $$
declare
  m public.members%rowtype;
  s public.settings%rowtype;
  today date := public.today_myt();
  y integer := extract(year from today)::integer;
begin
  select * into m from public.members where id = auth.uid();
  if not found then
    return query select false, 'Member profile not found.', null::integer, null::integer;
    return;
  end if;
  select * into s from public.settings limit 1;

  if m.profile_completed_at is null then
    return query select false, 'Please complete your profile first.', null::integer, s.fee_cents;
  elsif m.expires_on >= make_date(y + 1, 12, 31) then
    return query select false, format('Your membership is already paid until %s.', to_char(m.expires_on, 'DD Mon YYYY')), null::integer, s.fee_cents;
  elsif m.expires_on >= make_date(y, 12, 31) then
    if extract(month from today) >= s.renewal_opens_month then
      return query select true, null::text, y + 1, s.fee_cents;
    else
      return query select false,
        format('Your membership is active until %s. Renewal for %s opens on 1 %s.',
               to_char(m.expires_on, 'DD Mon YYYY'), y + 1,
               trim(to_char(make_date(y, s.renewal_opens_month, 1), 'Month'))),
        null::integer, s.fee_cents;
    end if;
  else
    return query select true, null::text, y, s.fee_cents;
  end if;
end;
$$;

-- Called by the create-bill function with the member's own login.
create or replace function public.start_renewal()
returns public.payments
language plpgsql security definer set search_path = public
as $$
declare
  q record;
  p public.payments%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not logged in' using errcode = '42501';
  end if;
  select * into q from public.renewal_quote();
  if not q.allowed then
    raise exception '%', q.reason using errcode = 'P0001';
  end if;
  if (select count(*) from public.payments
      where member_id = auth.uid() and status = 'pending'
        and created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'Too many payment attempts. Please wait 10 minutes and try again.' using errcode = 'P0001';
  end if;
  insert into public.payments (member_id, coverage_year, amount_cents, method)
  values (auth.uid(), q.coverage_year, q.amount_cents, 'fpx')
  returning * into p;
  return p;
end;
$$;

-- Shared by FPX confirmation and AJK manual records.
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
      v_no := 'VCM' || lpad(nextval('public.member_no_seq')::text, 4, '0');
      exit when not exists (select 1 from public.members where member_no = v_no)
            and not exists (select 1 from public.member_import where member_no = v_no);
    end loop;
    update public.members set member_no = v_no where id = p.member_id;
  end if;
end;
$$;

-- Called only by the toyyibpay-callback function (service role) after it
-- has checked the payment with ToyyibPay. Safe to call twice.
create or replace function public.mark_payment_paid(p_payment_id uuid, p_provider_ref text, p_amount_cents integer)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  p public.payments%rowtype;
begin
  select * into p from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'Payment % not found', p_payment_id;
  end if;
  if p.status = 'paid' then
    return false;
  end if;
  if p.amount_cents <> p_amount_cents then
    raise exception 'Amount mismatch for payment %: expected %, got %', p_payment_id, p.amount_cents, p_amount_cents;
  end if;
  update public.payments
     set status = 'paid', paid_at = now(), provider_ref = p_provider_ref
   where id = p_payment_id;
  perform public.apply_paid_payment(p_payment_id);
  return true;
end;
$$;

create or replace function public.mark_payment_failed(p_payment_id uuid)
returns void
language sql security definer set search_path = public
as $$
  update public.payments set status = 'failed' where id = p_payment_id and status = 'pending';
$$;

-- AJK records a cash or bank-transfer payment.
create or replace function public.admin_record_payment(
  p_member_id uuid, p_coverage_year integer, p_amount_cents integer, p_method text, p_note text default null)
returns public.payments
language plpgsql security definer set search_path = public
as $$
declare
  p public.payments%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only AJK admins can record payments' using errcode = '42501';
  end if;
  if p_method not in ('cash', 'transfer') then
    raise exception 'Method must be cash or transfer' using errcode = 'P0001';
  end if;
  insert into public.payments (member_id, coverage_year, amount_cents, method, status, note, recorded_by, paid_at)
  values (p_member_id, p_coverage_year, p_amount_cents, p_method, 'paid', p_note, auth.jwt() ->> 'email', now())
  returning * into p;
  perform public.apply_paid_payment(p.id);
  return p;
end;
$$;

-- =====================================================================
-- Access control
-- =====================================================================
alter table public.settings      enable row level security;
alter table public.admins        enable row level security;
alter table public.member_import enable row level security;
alter table public.members       enable row level security;
alter table public.payments      enable row level security;

-- Supabase grants everything to the website roles by default; take it back.
revoke all on public.settings, public.admins, public.member_import,
              public.members, public.payments from anon, authenticated;
revoke all on sequence public.member_no_seq from anon, authenticated;

-- Members: read own row (AJK read all); edit only these profile fields.
grant select on public.members to authenticated;
grant update (full_name, phone, state, vespa_model, plate_no) on public.members to authenticated;

drop policy if exists members_select on public.members;
create policy members_select on public.members
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists members_update_own on public.members;
create policy members_update_own on public.members
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Payments: read own (AJK read all). Writes go through the functions above.
grant select on public.payments to authenticated;
drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments
  for select to authenticated
  using (member_id = auth.uid() or public.is_admin());

-- Functions: members may call these ...
revoke all on function public.renewal_quote(), public.start_renewal(),
  public.admin_record_payment(uuid, integer, integer, text, text), public.is_admin()
  from public, anon;
grant execute on function public.renewal_quote(), public.start_renewal(),
  public.admin_record_payment(uuid, integer, integer, text, text), public.is_admin()
  to authenticated;

-- ... and these are for the payment functions on the server only.
revoke all on function public.apply_paid_payment(uuid),
  public.mark_payment_paid(uuid, text, integer), public.mark_payment_failed(uuid),
  public.handle_new_user() from public, anon, authenticated;
grant execute on function public.mark_payment_paid(uuid, text, integer),
  public.mark_payment_failed(uuid) to service_role;

-- Keep-alive for the free plan: an outside scheduler (e.g. cron-job.org)
-- calls this every few days so the project is not paused. It touches no data.
create or replace function public.ping()
returns text
language sql stable
as $$ select 'ok'::text $$;
revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;
