-- =====================================================================
-- Vespa Club Malaysia: 014 fix members who log in with a different email
-- Some members were pre-registered with the email from the old Google Form
-- but log in to the portal with another email, so their member number is
-- "reserved" in the pre-registered list and cannot be given to the new
-- account. Two AJK (editor) tools:
--   admin_link_import(member, email)    move a pre-registration onto an
--                                        existing account, then remove it
--   admin_change_import_email(old, new) correct the email of a member who
--                                        has not logged in yet
-- Run AFTER 013. Safe to run again.
-- =====================================================================

create or replace function public.admin_link_import(p_member_id uuid, p_email text)
returns public.members
language plpgsql security definer set search_path = public
as $$
declare
  imp public.member_import%rowtype;
  m   public.members%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only AJK admins can do this' using errcode = '42501';
  end if;
  select * into imp from public.member_import where email = lower(btrim(p_email)) for update;
  if not found then raise exception 'That email is not in the pre-registered list' using errcode = 'P0001'; end if;
  select * into m from public.members where id = p_member_id for update;
  if not found then raise exception 'Member account not found' using errcode = 'P0001'; end if;
  if m.member_no is not null and imp.member_no is not null and m.member_no <> imp.member_no then
    raise exception 'This account already has member number %, but the pre-registration is for %', m.member_no, imp.member_no
      using errcode = 'P0001';
  end if;

  -- Free the number first (it is reserved while the pre-registration exists).
  delete from public.member_import where email = imp.email;
  update public.members
     set member_no  = coalesce(m.member_no, imp.member_no),
         expires_on = greatest(m.expires_on, imp.expires_on),
         full_name  = coalesce(m.full_name, imp.full_name),
         phone      = coalesce(m.phone, case when imp.phone ~ '^\+?[0-9][0-9 -]{7,18}$' then imp.phone end),
         joined_on  = least(m.joined_on, coalesce(imp.joined_on, m.joined_on))
   where id = m.id
  returning * into m;
  return m;
end;
$$;
revoke all on function public.admin_link_import(uuid, text) from public, anon;
grant execute on function public.admin_link_import(uuid, text) to authenticated;

create or replace function public.admin_change_import_email(p_old text, p_new text)
returns public.member_import
language plpgsql security definer set search_path = public
as $$
declare
  v_old text := lower(btrim(coalesce(p_old, '')));
  v_new text := lower(btrim(coalesce(p_new, '')));
  r public.member_import%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only AJK admins can do this' using errcode = '42501';
  end if;
  if v_new !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'Please enter a valid email address' using errcode = 'P0001'; end if;
  if v_new = v_old then
    select * into r from public.member_import where email = v_old;
    return r;
  end if;
  if exists (select 1 from public.members where lower(email) = v_new) then
    raise exception 'An account with % already exists. Open that member with Edit and use "Link pre-registration" instead.', v_new
      using errcode = 'P0001';
  end if;
  if exists (select 1 from public.member_import where email = v_new) then
    raise exception '% is already in the pre-registered list', v_new using errcode = 'P0001';
  end if;
  update public.member_import set email = v_new where email = v_old returning * into r;
  if not found then raise exception 'That email is not in the pre-registered list' using errcode = 'P0001'; end if;
  return r;
end;
$$;
revoke all on function public.admin_change_import_email(text, text) from public, anon;
grant execute on function public.admin_change_import_email(text, text) to authenticated;
