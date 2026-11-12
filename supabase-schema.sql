-- ACTIVE TONIGHT database. Run in Supabase > SQL Editor.
-- Safe to run on a fresh project AND to re-run on the earlier milestone's database.
create extension if not exists pgcrypto;

-- ───────── profiles ─────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'customer' check(role in ('customer','organizer','admin')),
  created_at timestamptz not null default now()
);
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin insert into public.profiles(id,full_name) values(new.id,coalesce(new.raw_user_meta_data->>'full_name','')) on conflict(id) do nothing; return new; end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

-- Role helpers (security definer so policies can use them without recursion)
create or replace function public.my_role() returns text language sql stable security definer set search_path=public as $$
  select role from public.profiles where id=auth.uid() $$;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path=public as $$
  select coalesce((select role='admin' from public.profiles where id=auth.uid()),false) $$;

-- ───────── events ─────────
create table if not exists public.events(
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references auth.users(id) on delete cascade,
  title text not null, description text, category text not null default 'Parties',
  city text not null, venue text, address text,
  starts_at timestamptz not null, ends_at timestamptz,
  price numeric(12,2) not null default 0 check(price>=0),
  cover_url text,
  status text not null default 'pending' check(status in('draft','pending','published','rejected','cancelled')),
  popularity integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.events add column if not exists capacity integer check(capacity is null or capacity>0);
alter table public.events add column if not exists tickets_sold integer not null default 0;

-- ───────── orders (created before tickets so tickets can reference it) ─────────
create table if not exists public.orders(
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  user_id uuid not null references auth.users(id),
  quantity integer not null check(quantity between 1 and 10),
  unit_price numeric(12,2) not null,
  total_amount numeric(12,2) not null,
  currency text not null default 'NGN',
  payment_reference text unique not null,
  payment_status text not null default 'pending',
  created_at timestamptz not null default now()
);
alter table public.orders add column if not exists commission_rate numeric(5,4) not null default 0.05;
alter table public.orders add column if not exists platform_fee numeric(12,2) not null default 0;
alter table public.orders add column if not exists organizer_amount numeric(12,2) not null default 0;
alter table public.orders add column if not exists gateway text not null default 'korapay';
alter table public.orders add column if not exists paid_at timestamptz;
alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check(payment_status in ('pending','paid','failed','refunded','needs_refund'));

-- ───────── tickets: ONE ROW PER ADMISSION (one QR code each) ─────────
create table if not exists public.tickets(
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  event_id uuid not null references public.events(id),
  user_id uuid not null references auth.users(id),
  ticket_code text unique not null default encode(gen_random_bytes(12),'hex'),
  status text not null default 'valid' check(status in ('valid','used','cancelled','refunded')),
  created_at timestamptz not null default now()
);
alter table public.tickets add column if not exists checked_in_at timestamptz;
alter table public.tickets add column if not exists checked_in_by uuid references auth.users(id);
alter table public.tickets drop column if exists quantity;  -- old milestone stored N people in one row
do $$ begin
  if not exists (select 1 from pg_constraint where conname='tickets_order_id_fkey') then
    alter table public.tickets add constraint tickets_order_id_fkey foreign key(order_id) references public.orders(id);
  end if;
end $$;

create table if not exists public.favorites(
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id,event_id)
);

create index if not exists idx_tickets_event on public.tickets(event_id);
create index if not exists idx_tickets_user on public.tickets(user_id);
create index if not exists idx_orders_event on public.orders(event_id);
create index if not exists idx_orders_user on public.orders(user_id);

-- Stop organizers from faking sales/popularity or reassigning an event.
create or replace function public.protect_event_columns() returns trigger language plpgsql as $$
begin
  if coalesce(auth.role(),'') in ('anon','authenticated') and not public.is_admin() then
    if tg_op='INSERT' then new.tickets_sold:=0; new.popularity:=0;
    else new.tickets_sold:=old.tickets_sold; new.popularity:=old.popularity; new.organizer_id:=old.organizer_id; end if;
  end if;
  return new;
end; $$;
drop trigger if exists protect_event_columns on public.events;
create trigger protect_event_columns before insert or update on public.events for each row execute procedure public.protect_event_columns();

-- ───────── Row Level Security ─────────
alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.orders enable row level security;
alter table public.tickets enable row level security;
alter table public.favorites enable row level security;

drop policy if exists "Profiles view own" on public.profiles;
create policy "Profiles view own" on public.profiles for select to authenticated using(id=auth.uid());
drop policy if exists "Admins view profiles" on public.profiles;
create policy "Admins view profiles" on public.profiles for select to authenticated using(public.is_admin());
drop policy if exists "Profiles update own" on public.profiles;
-- Users may edit their own profile but never change their own role.
create policy "Profiles update own" on public.profiles for update to authenticated
  using(id=auth.uid()) with check(id=auth.uid() and role=public.my_role());

drop policy if exists "Public view published events" on public.events;
create policy "Public view published events" on public.events for select using(status='published' or organizer_id=auth.uid());
drop policy if exists "Admins view all events" on public.events;
create policy "Admins view all events" on public.events for select to authenticated using(public.is_admin());
drop policy if exists "Signed in users submit events" on public.events;
create policy "Signed in users submit events" on public.events for insert to authenticated with check(organizer_id=auth.uid() and status='pending');
drop policy if exists "Owners edit pending events" on public.events;
create policy "Owners edit pending events" on public.events for update to authenticated
  using(organizer_id=auth.uid() and status in('draft','pending')) with check(organizer_id=auth.uid() and status in('draft','pending'));
drop policy if exists "Admins update events" on public.events;
create policy "Admins update events" on public.events for update to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists "Customers read own orders" on public.orders;
create policy "Customers read own orders" on public.orders for select to authenticated using(user_id=auth.uid());
drop policy if exists "Organizers read event orders" on public.orders;
create policy "Organizers read event orders" on public.orders for select to authenticated
  using(exists(select 1 from public.events e where e.id=orders.event_id and e.organizer_id=auth.uid()));
drop policy if exists "Admins read orders" on public.orders;
create policy "Admins read orders" on public.orders for select to authenticated using(public.is_admin());

drop policy if exists "Customers read own tickets" on public.tickets;
create policy "Customers read own tickets" on public.tickets for select to authenticated using(user_id=auth.uid());
drop policy if exists "Organizers read event tickets" on public.tickets;
create policy "Organizers read event tickets" on public.tickets for select to authenticated
  using(exists(select 1 from public.events e where e.id=tickets.event_id and e.organizer_id=auth.uid()));
drop policy if exists "Admins read tickets" on public.tickets;
create policy "Admins read tickets" on public.tickets for select to authenticated using(public.is_admin());

drop policy if exists "Customers manage own favorites" on public.favorites;
create policy "Customers manage own favorites" on public.favorites for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());

-- ───────── Atomic payment fulfilment ─────────
-- Called ONLY by the server (service role) after Korapay confirms payment.
-- Locks the order and event rows, so double-calls, refreshes and webhook/return-page
-- races can never create duplicate tickets or oversell capacity.
create or replace function public.fulfil_order(p_reference text, p_amount_paid numeric) returns jsonb
language plpgsql security definer set search_path=public as $$
declare o public.orders%rowtype; ev public.events%rowtype;
begin
  select * into o from public.orders where payment_reference=p_reference for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if o.payment_status='paid' then return jsonb_build_object('status','already_paid'); end if;
  if o.payment_status in ('refunded','needs_refund') then return jsonb_build_object('status',o.payment_status); end if;
  if round(p_amount_paid,2) <> round(o.total_amount,2) then return jsonb_build_object('status','amount_mismatch'); end if;

  select * into ev from public.events where id=o.event_id for update;
  if ev.capacity is not null and ev.tickets_sold + o.quantity > ev.capacity then
    update public.orders set payment_status='needs_refund' where id=o.id;
    return jsonb_build_object('status','needs_refund');
  end if;

  insert into public.tickets(order_id,event_id,user_id) select o.id,o.event_id,o.user_id from generate_series(1,o.quantity);
  update public.orders set payment_status='paid', paid_at=now() where id=o.id;
  update public.events set tickets_sold=tickets_sold+o.quantity, popularity=popularity+o.quantity where id=o.event_id;
  return jsonb_build_object('status','paid','tickets',o.quantity);
end; $$;
revoke all on function public.fulfil_order(text,numeric) from public, anon, authenticated;
grant execute on function public.fulfil_order(text,numeric) to service_role;

-- Orders and tickets have NO insert/update policies on purpose: only the server may create them.

-- ───────── Make yourself the first admin (edit the email, then run) ─────────
-- update public.profiles set role='admin' where id=(select id from auth.users where email='you@example.com');
