-- =====================================================================
-- Vespa Club Malaysia: full membership profile (same details as the old
-- Google Form). Run after 001, 002 and 003. Safe to run more than once.
--
-- Adds the ROS registration details, beneficiary, T-shirt size and a
-- declaration. "claimed_member_no" is what the member types as their old
-- VCM number: for AJK reference only. It never changes the real member
-- number or the fee; AJK set the real number with Edit.
--
-- Every existing member is asked to complete the new profile on their
-- next login.
-- =====================================================================

alter table public.members
  add column if not exists nationality            text check (char_length(nationality) <= 60),
  add column if not exists nric                   text check (nric ~ '^[A-Z0-9]{5,20}$'),
  add column if not exists gender                 text check (gender in ('Male', 'Female')),
  add column if not exists age                    smallint check (age between 5 and 120),
  add column if not exists address                text check (char_length(address) <= 300),
  add column if not exists beneficiary_name       text check (char_length(beneficiary_name) <= 120),
  add column if not exists beneficiary_nric       text check (beneficiary_nric ~ '^[A-Z0-9]{5,20}$'),
  add column if not exists beneficiary_relation   text check (char_length(beneficiary_relation) <= 40),
  add column if not exists oku                    text check (char_length(oku) <= 120),
  add column if not exists tshirt_size            text check (tshirt_size in ('Not needed', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL')),
  add column if not exists club_group             text check (char_length(club_group) <= 120),
  add column if not exists remark                 text check (char_length(remark) <= 500),
  add column if not exists claimed_member_no      text check (claimed_member_no ~ '^[A-Z0-9-]{1,20}$'),
  add column if not exists declaration_accepted_at timestamptz;

-- Tidy values and decide when the profile is complete.
create or replace function public.members_before_write()
returns trigger
language plpgsql
as $$
begin
  new.full_name            := upper(nullif(btrim(new.full_name), ''));
  new.phone                := nullif(btrim(new.phone), '');
  new.state                := nullif(btrim(new.state), '');
  new.vespa_model          := nullif(btrim(new.vespa_model), '');
  new.plate_no             := upper(nullif(btrim(new.plate_no), ''));
  new.nationality          := nullif(btrim(new.nationality), '');
  new.nric                 := nullif(upper(regexp_replace(coalesce(new.nric, ''), '[\s-]', '', 'g')), '');
  new.address              := nullif(btrim(new.address), '');
  new.beneficiary_name     := upper(nullif(btrim(new.beneficiary_name), ''));
  new.beneficiary_nric     := nullif(upper(regexp_replace(coalesce(new.beneficiary_nric, ''), '[\s-]', '', 'g')), '');
  new.beneficiary_relation := nullif(btrim(new.beneficiary_relation), '');
  new.oku                  := nullif(btrim(new.oku), '');
  new.club_group           := nullif(btrim(new.club_group), '');
  new.remark               := nullif(btrim(new.remark), '');
  new.claimed_member_no    := nullif(upper(regexp_replace(coalesce(new.claimed_member_no, ''), '\s', '', 'g')), '');
  new.updated_at           := now();

  if new.full_name is not null and new.phone is not null and new.state is not null
     and new.vespa_model is not null and new.plate_no is not null
     and new.nationality is not null and new.nric is not null and new.gender is not null
     and new.age is not null and new.address is not null
     and new.beneficiary_name is not null and new.beneficiary_nric is not null
     and new.beneficiary_relation is not null and new.tshirt_size is not null
     and new.declaration_accepted_at is not null then
    new.profile_completed_at := coalesce(new.profile_completed_at, now());
  else
    new.profile_completed_at := null;
  end if;
  return new;
end;
$$;

-- Members may edit these fields on their own row (row level security still applies).
grant update (full_name, phone, state, vespa_model, plate_no,
              nationality, nric, gender, age, address,
              beneficiary_name, beneficiary_nric, beneficiary_relation, oku,
              tshirt_size, club_group, remark, claimed_member_no, declaration_accepted_at)
  on public.members to authenticated;

-- Re-check every existing profile against the new required fields
-- (members with missing details will be asked to complete them).
update public.members set updated_at = now();
