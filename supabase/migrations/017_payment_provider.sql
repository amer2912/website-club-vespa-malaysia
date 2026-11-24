-- =====================================================================
-- Vespa Club Malaysia: 017 record which payment gateway a payment used
-- Membership fees can now be paid through Billplz as well as ToyyibPay.
-- The create-bill function chooses the gateway (Supabase secret
-- MEMBERSHIP_GATEWAY = billplz or toyyibpay) and records it here, so the
-- Billplz callback only touches Billplz bills, and an older unpaid Billplz
-- bill is cancelled when the member starts a new one (no double payment
-- for the same year).
-- Online (FPX) payments: provider = 'toyyibpay' or 'billplz'.
-- Cash, transfer and old Google Form records: provider stays empty.
-- Run AFTER 016. Safe to run again.
-- =====================================================================

alter table public.payments add column if not exists provider text;
alter table public.payments drop constraint if exists payments_provider_check;
alter table public.payments add constraint payments_provider_check
  check (provider is null or provider in ('toyyibpay', 'billplz'));

-- Every online payment so far went through ToyyibPay.
update public.payments set provider = 'toyyibpay' where method = 'fpx' and provider is null;

create index if not exists payments_member_pending on public.payments (member_id) where status = 'pending';
