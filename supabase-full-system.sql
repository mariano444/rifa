-- Sistema completo de sorteos para Supabase
-- Incluye campañas, compras, referidos, pagos y Storage.

create extension if not exists pgcrypto;
create schema if not exists app_private;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'campaign_status') then
    create type campaign_status as enum ('draft', 'active', 'paused', 'finished');
  end if;
  if not exists (select 1 from pg_type where typname = 'package_status') then
    create type package_status as enum ('active', 'inactive');
  end if;
  if not exists (select 1 from pg_type where typname = 'participant_status') then
    create type participant_status as enum ('lead', 'active', 'blocked');
  end if;
  if not exists (select 1 from pg_type where typname = 'order_status') then
    create type order_status as enum ('draft', 'pending_payment', 'paid', 'failed', 'cancelled', 'refunded');
  end if;
  if not exists (select 1 from pg_type where typname = 'payment_provider') then
    create type payment_provider as enum ('mercado_pago', 'galiopay', 'manual');
  end if;
  if not exists (select 1 from pg_type where typname = 'payment_environment') then
    create type payment_environment as enum ('sandbox', 'production');
  end if;
  if not exists (select 1 from pg_type where typname = 'admin_role') then
    create type admin_role as enum ('super_admin', 'operator', 'finance', 'content');
  end if;
  if not exists (select 1 from pg_type where typname = 'referral_status') then
    create type referral_status as enum ('pending', 'awarded', 'cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'media_kind') then
    create type media_kind as enum ('image', 'video');
  end if;
end $$;

create or replace function public.handle_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  phone text,
  avatar_url text,
  city text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_users (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  role admin_role not null default 'operator',
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  subtitle text,
  description text,
  legal_text text,
  hero_badge text,
  draw_at timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  max_entries integer not null default 0,
  sold_entries integer not null default 0,
  referral_bonus_min integer not null default 2,
  referral_bonus_max integer not null default 2,
  referral_reward_message text default 'Tu amigo compró y sumaste chances extra.',
  status campaign_status not null default 'draft',
  cover_image_url text,
  terms_url text,
  whatsapp_number text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaigns_referral_bonus_check check (
    referral_bonus_min >= 0 and referral_bonus_max >= referral_bonus_min
  )
);

create table if not exists public.packages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  name text not null,
  description text,
  entries_qty integer not null,
  bonus_entries integer not null default 0,
  price_ars numeric(12,2) not null,
  featured boolean not null default false,
  status package_status not null default 'active',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint packages_entries_qty_check check (entries_qty > 0),
  constraint packages_bonus_entries_check check (bonus_entries >= 0),
  constraint packages_price_ars_check check (price_ars >= 0)
);

create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  full_name text not null,
  email text,
  phone text,
  city text,
  source text default 'landing',
  status participant_status not null default 'active',
  total_entries integer not null default 0,
  referral_link_code text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.participants
add column if not exists is_public_name boolean not null default true;

alter table public.participants
add column if not exists public_display_code text;

create unique index if not exists participants_public_display_code_uidx
on public.participants (public_display_code)
where public_display_code is not null;

create or replace function public.generate_public_participant_code()
returns text
language plpgsql
as $$
declare
  v_code text;
begin
  loop
    v_code := 'USR-' || upper(substr(encode(gen_random_bytes(5), 'hex'), 1, 8));
    exit when not exists (
      select 1
      from public.participants
      where public_display_code = v_code
    );
  end loop;

  return v_code;
end;
$$;

update public.participants
set public_display_code = public.generate_public_participant_code()
where coalesce(is_public_name, true) = false
  and public_display_code is null;

create unique index if not exists participants_campaign_phone_uidx
on public.participants (campaign_id, phone)
where phone is not null;

create unique index if not exists participants_campaign_email_uidx
on public.participants (campaign_id, email)
where email is not null;

create table if not exists public.referral_links (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  owner_participant_id uuid not null references public.participants(id) on delete cascade,
  code text not null unique,
  status text not null default 'active',
  clicks_count integer not null default 0,
  last_clicked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint referral_links_status_check check (status in ('active', 'disabled'))
);

create unique index if not exists referral_links_owner_campaign_uidx
on public.referral_links (campaign_id, owner_participant_id);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete restrict,
  package_id uuid not null references public.packages(id) on delete restrict,
  referral_link_id uuid references public.referral_links(id) on delete set null,
  provider payment_provider not null default 'manual',
  status order_status not null default 'draft',
  quantity integer not null default 1,
  base_entries integer not null,
  bonus_entries integer not null default 0,
  referral_bonus_entries integer not null default 0,
  total_entries integer not null,
  amount_ars numeric(12,2) not null,
  currency text not null default 'ARS',
  external_reference text not null unique default encode(gen_random_bytes(9), 'hex'),
  provider_checkout_id text,
  provider_payment_id text,
  provider_preference_id text,
  payment_url text,
  paid_at timestamptz,
  entries_applied_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_quantity_check check (quantity > 0),
  constraint orders_amount_ars_check check (amount_ars >= 0),
  constraint orders_total_entries_check check (total_entries >= 0)
);

create index if not exists orders_campaign_status_idx
on public.orders (campaign_id, status, created_at desc);

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  provider payment_provider not null,
  status text not null,
  amount_ars numeric(12,2) not null default 0,
  provider_payment_id text,
  provider_external_reference text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists payment_transactions_order_idx
on public.payment_transactions (order_id, created_at desc);

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  referral_link_id uuid not null references public.referral_links(id) on delete cascade,
  referrer_participant_id uuid not null references public.participants(id) on delete cascade,
  referred_participant_id uuid not null references public.participants(id) on delete cascade,
  referred_order_id uuid not null unique references public.orders(id) on delete cascade,
  bonus_entries_awarded integer not null,
  status referral_status not null default 'awarded',
  awarded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint referrals_bonus_entries_awarded_check check (bonus_entries_awarded >= 0)
);

create table if not exists public.campaign_media (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  kind media_kind not null default 'image',
  bucket_name text not null default 'campaign-media',
  storage_path text not null,
  public_url text,
  alt_text text,
  sort_order integer not null default 0,
  is_cover boolean not null default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_provider_configs (
  id uuid primary key default gen_random_uuid(),
  provider payment_provider not null,
  environment payment_environment not null default 'sandbox',
  is_active boolean not null default false,
  public_key text,
  access_token text,
  webhook_secret text,
  extra_config jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, environment)
);

create table if not exists public.system_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references public.profiles(id),
  entity_name text not null,
  entity_id text not null,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.generate_referral_code()
returns text
language plpgsql
as $$
declare
  v_code text;
begin
  loop
    v_code := lower(substring(encode(gen_random_bytes(6), 'hex') from 1 for 10));
    exit when not exists (select 1 from public.referral_links where code = v_code);
  end loop;
  return v_code;
end;
$$;

create or replace function app_private.is_admin(check_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = check_user_id
      and is_active = true
  );
$$;

create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_private.is_admin(auth.uid());
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    new.email,
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
  set email = excluded.email,
      full_name = coalesce(excluded.full_name, public.profiles.full_name),
      avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
      updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.prepare_order_totals()
returns trigger
language plpgsql
as $$
begin
  if new.base_entries is null or new.base_entries = 0 then
    select (entries_qty * new.quantity), (bonus_entries * new.quantity), (price_ars * new.quantity)
      into new.base_entries, new.bonus_entries, new.amount_ars
    from public.packages
    where id = new.package_id;
  end if;

  if new.referral_bonus_entries is null then
    new.referral_bonus_entries := 0;
  end if;

  new.total_entries := coalesce(new.base_entries, 0)
                     + coalesce(new.bonus_entries, 0)
                     + coalesce(new.referral_bonus_entries, 0);

  return new;
end;
$$;

drop trigger if exists trg_prepare_order_totals on public.orders;
create trigger trg_prepare_order_totals
before insert or update on public.orders
for each row execute procedure public.prepare_order_totals();

create or replace function public.ensure_participant_referral_link(p_participant_id uuid, p_campaign_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link_id uuid;
begin
  select id
    into v_link_id
  from public.referral_links
  where owner_participant_id = p_participant_id
    and campaign_id = p_campaign_id;

  if v_link_id is null then
    insert into public.referral_links (campaign_id, owner_participant_id, code)
    values (p_campaign_id, p_participant_id, public.generate_referral_code())
    returning id into v_link_id;

    update public.participants
    set referral_link_code = (select code from public.referral_links where id = v_link_id),
        updated_at = now()
    where id = p_participant_id;
  end if;

  return v_link_id;
end;
$$;

create or replace function public.apply_paid_order_effects()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.referral_links%rowtype;
  v_bonus integer;
begin
  if new.status = 'paid' and new.entries_applied_at is null then
    update public.participants
    set total_entries = total_entries + new.total_entries,
        updated_at = now()
    where id = new.participant_id;

    update public.campaigns
    set sold_entries = sold_entries + new.total_entries,
        updated_at = now()
    where id = new.campaign_id;

    if exists (
      select 1
      from public.participants
      where id = new.participant_id
        and total_entries >= 3
    ) then
      perform public.ensure_participant_referral_link(new.participant_id, new.campaign_id);
    end if;

    if new.referral_link_id is not null then
      select *
        into v_link
      from public.referral_links
      where id = new.referral_link_id
        and campaign_id = new.campaign_id
        and status = 'active';

      if found
         and v_link.owner_participant_id <> new.participant_id
         and not exists (
           select 1
           from public.referrals
           where referred_order_id = new.id
         ) then
        select greatest(referral_bonus_min, 0)
          into v_bonus
        from public.campaigns
        where id = new.campaign_id;

        insert into public.referrals (
          campaign_id,
          referral_link_id,
          referrer_participant_id,
          referred_participant_id,
          referred_order_id,
          bonus_entries_awarded,
          status,
          awarded_at
        )
        values (
          new.campaign_id,
          v_link.id,
          v_link.owner_participant_id,
          new.participant_id,
          new.id,
          v_bonus,
          'awarded',
          now()
        );

        update public.participants
        set total_entries = total_entries + v_bonus,
            updated_at = now()
        where id = v_link.owner_participant_id;
      end if;
    end if;

    update public.orders
    set entries_applied_at = now(),
        paid_at = coalesce(paid_at, now()),
        updated_at = now()
    where id = new.id;

    insert into public.audit_logs (actor_user_id, entity_name, entity_id, action, payload)
    values (
      auth.uid(),
      'orders',
      new.id::text,
      'order_paid',
      jsonb_build_object(
        'campaign_id', new.campaign_id,
        'participant_id', new.participant_id,
        'provider', new.provider,
        'amount_ars', new.amount_ars
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_apply_paid_order_effects on public.orders;
create trigger trg_apply_paid_order_effects
after insert or update on public.orders
for each row execute procedure public.apply_paid_order_effects();

create or replace function public.touch_referral_click(p_code text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.referral_links
  set clicks_count = clicks_count + 1,
      last_clicked_at = now(),
      updated_at = now()
  where code = p_code
    and status = 'active';
$$;

create or replace function public.list_public_participants(p_campaign_slug text)
returns table (
  display_name text,
  full_name text,
  is_anonymous boolean,
  public_code text,
  city text,
  purchased_entries integer,
  total_entries integer,
  joined_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    case
      when coalesce(p.is_public_name, true) then p.full_name
      else 'Anonimo ' || coalesce(p.public_display_code, public.generate_public_participant_code())
    end as display_name,
    p.full_name,
    not coalesce(p.is_public_name, true) as is_anonymous,
    p.public_display_code as public_code,
    coalesce(p.city, 'Argentina') as city,
    coalesce((
      select sum(o.total_entries)::int
      from public.orders o
      where o.participant_id = p.id
        and o.status = 'paid'
    ), 0) as purchased_entries,
    p.total_entries,
    p.created_at as joined_at
  from public.participants p
  join public.campaigns c on c.id = p.campaign_id
  where c.slug = p_campaign_slug
    and c.status = 'active'
    and p.status = 'active'
    and p.total_entries > 0
  order by p.created_at desc
  limit 200;
$$;

drop function if exists public.create_order_from_landing(text, uuid, text, text, text, payment_provider, text);

create or replace function public.create_order_from_landing(
  p_campaign_slug text,
  p_package_id uuid,
  p_full_name text,
  p_phone text,
  p_city text default null,
  p_show_public_name boolean default true,
  p_payment_provider payment_provider default 'manual',
  p_referral_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.campaigns%rowtype;
  v_package public.packages%rowtype;
  v_participant public.participants%rowtype;
  v_referral_link_id uuid;
  v_order public.orders%rowtype;
begin
  select *
    into v_campaign
  from public.campaigns
  where slug = p_campaign_slug
    and status = 'active'
  limit 1;

  if v_campaign.id is null then
    raise exception 'No hay una campaña activa disponible';
  end if;

  select *
    into v_package
  from public.packages
  where id = p_package_id
    and campaign_id = v_campaign.id
    and status = 'active'
  limit 1;

  if v_package.id is null then
    raise exception 'El paquete seleccionado no está disponible';
  end if;

  if coalesce(trim(p_full_name), '') = '' or coalesce(trim(p_phone), '') = '' then
    raise exception 'Nombre y WhatsApp son obligatorios';
  end if;

  select *
    into v_participant
  from public.participants
  where campaign_id = v_campaign.id
    and phone = p_phone
  limit 1;

  if v_participant.id is null then
    insert into public.participants (
      campaign_id,
      full_name,
      phone,
      city,
      is_public_name,
      public_display_code,
      source,
      status
    )
    values (
      v_campaign.id,
      trim(p_full_name),
      trim(p_phone),
      nullif(trim(coalesce(p_city, '')), ''),
      coalesce(p_show_public_name, true),
      case
        when coalesce(p_show_public_name, true) then null
        else public.generate_public_participant_code()
      end,
      case when p_referral_code is not null then 'referral_link' else 'landing' end,
      'active'
    )
    returning * into v_participant;
  else
    update public.participants
    set full_name = trim(p_full_name),
        city = coalesce(nullif(trim(coalesce(p_city, '')), ''), city),
        is_public_name = coalesce(p_show_public_name, true),
        public_display_code = case
          when coalesce(p_show_public_name, true) then public_display_code
          else coalesce(public_display_code, public.generate_public_participant_code())
        end,
        updated_at = now()
    where id = v_participant.id
    returning * into v_participant;
  end if;

  if p_referral_code is not null and trim(p_referral_code) <> '' then
    perform public.touch_referral_click(trim(p_referral_code));

    select id
      into v_referral_link_id
    from public.referral_links
    where code = trim(p_referral_code)
      and campaign_id = v_campaign.id
      and status = 'active'
    limit 1;
  end if;

  insert into public.orders (
    campaign_id,
    participant_id,
    package_id,
    referral_link_id,
    provider,
    status,
    quantity,
    base_entries,
    amount_ars,
    total_entries
  )
  values (
    v_campaign.id,
    v_participant.id,
    v_package.id,
    v_referral_link_id,
    p_payment_provider,
    'pending_payment',
    1,
    0,
    0,
    0
  )
  returning * into v_order;

  return jsonb_build_object(
    'order_id', v_order.id,
    'participant_id', v_participant.id,
    'external_reference', v_order.external_reference,
    'status', v_order.status,
    'provider', v_order.provider,
    'package_name', v_package.name,
    'entries', v_package.entries_qty + v_package.bonus_entries,
    'share_unlocked_after_payment', (v_package.entries_qty + v_package.bonus_entries) >= 3
  );
end;
$$;

create or replace function public.get_public_order_status(p_external_reference text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'order_id', o.id,
    'status', o.status,
    'provider', o.provider,
    'paid_at', o.paid_at,
    'created_at', o.created_at,
    'participant_id', p.id,
    'participant_name', p.full_name,
    'city', coalesce(p.city, 'Argentina'),
    'purchased_entries', coalesce((
      select sum(po.total_entries)::int
      from public.orders po
      where po.participant_id = p.id
        and po.status = 'paid'
    ), 0),
    'total_entries', p.total_entries,
    'referral_link_code', p.referral_link_code,
    'share_unlocked', (p.referral_link_code is not null),
    'campaign_slug', c.slug
  )
  from public.orders o
  join public.participants p on p.id = o.participant_id
  join public.campaigns c on c.id = o.campaign_id
  where o.external_reference = p_external_reference
  limit 1;
$$;

create or replace function public.admin_mark_order_paid(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_referral_code text;
begin
  if not public.current_user_is_admin() then
    raise exception 'No autorizado';
  end if;

  update public.orders
  set status = 'paid',
      updated_at = now()
  where id = p_order_id
  returning * into v_order;

  if v_order.id is null then
    raise exception 'Orden no encontrada';
  end if;

  select referral_link_code
    into v_referral_code
  from public.participants
  where id = v_order.participant_id;

  return jsonb_build_object(
    'order_id', v_order.id,
    'participant_id', v_order.participant_id,
    'campaign_id', v_order.campaign_id,
    'status', v_order.status,
    'paid_at', v_order.paid_at,
    'referral_link_code', v_referral_code
  );
end;
$$;

create or replace function public.admin_get_provider_config(
  p_provider payment_provider,
  p_environment payment_environment
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.payment_provider_configs%rowtype;
begin
  if not public.current_user_is_admin() then
    raise exception 'No autorizado';
  end if;

  select *
    into v_row
  from public.payment_provider_configs
  where provider = p_provider
    and environment = p_environment
  limit 1;

  return jsonb_build_object(
    'id', v_row.id,
    'provider', v_row.provider,
    'environment', v_row.environment,
    'is_active', coalesce(v_row.is_active, false),
    'public_key', v_row.public_key,
    'access_token', v_row.access_token,
    'webhook_secret', v_row.webhook_secret,
    'extra_config', coalesce(v_row.extra_config, '{}'::jsonb)
  );
end;
$$;

create or replace function public.admin_upsert_provider_config(
  p_provider payment_provider,
  p_environment payment_environment,
  p_is_active boolean,
  p_public_key text,
  p_access_token text,
  p_webhook_secret text,
  p_extra_config jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.payment_provider_configs%rowtype;
begin
  if not public.current_user_is_admin() then
    raise exception 'No autorizado';
  end if;

  insert into public.payment_provider_configs (
    provider,
    environment,
    is_active,
    public_key,
    access_token,
    webhook_secret,
    extra_config,
    updated_by
  )
  values (
    p_provider,
    p_environment,
    coalesce(p_is_active, false),
    nullif(trim(coalesce(p_public_key, '')), ''),
    nullif(trim(coalesce(p_access_token, '')), ''),
    nullif(trim(coalesce(p_webhook_secret, '')), ''),
    coalesce(p_extra_config, '{}'::jsonb),
    auth.uid()
  )
  on conflict (provider, environment)
  do update
  set is_active = excluded.is_active,
      public_key = excluded.public_key,
      access_token = excluded.access_token,
      webhook_secret = excluded.webhook_secret,
      extra_config = excluded.extra_config,
      updated_by = auth.uid(),
      updated_at = now()
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'provider', v_row.provider,
    'environment', v_row.environment,
    'is_active', v_row.is_active,
    'updated_at', v_row.updated_at
  );
end;
$$;

grant usage on schema app_private to anon, authenticated;
grant execute on function app_private.is_admin(uuid) to anon, authenticated;
grant execute on function public.current_user_is_admin() to anon, authenticated;
grant execute on function public.list_public_participants(text) to anon, authenticated;
grant execute on function public.create_order_from_landing(text, uuid, text, text, text, boolean, payment_provider, text) to anon, authenticated;
grant execute on function public.get_public_order_status(text) to anon, authenticated;
grant execute on function public.admin_mark_order_paid(uuid) to authenticated;
grant execute on function public.admin_get_provider_config(payment_provider, payment_environment) to authenticated;
grant execute on function public.admin_upsert_provider_config(payment_provider, payment_environment, boolean, text, text, text, jsonb) to authenticated;

create or replace function public.admin_get_provider_config(
  p_provider text,
  p_environment text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.admin_get_provider_config(
    p_provider::payment_provider,
    p_environment::payment_environment
  );
end;
$$;

create or replace function public.admin_upsert_provider_config(
  p_provider text,
  p_environment text,
  p_is_active boolean,
  p_public_key text,
  p_access_token text,
  p_webhook_secret text,
  p_extra_config jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.admin_upsert_provider_config(
    p_provider::payment_provider,
    p_environment::payment_environment,
    p_is_active,
    p_public_key,
    p_access_token,
    p_webhook_secret,
    p_extra_config
  );
end;
$$;

grant execute on function public.admin_get_provider_config(text, text) to authenticated;
grant execute on function public.admin_upsert_provider_config(text, text, boolean, text, text, text, jsonb) to authenticated;

notify pgrst, 'reload schema';

create or replace view public.participant_dashboard as
select
  p.id,
  p.campaign_id,
  p.full_name,
  p.email,
  p.phone,
  p.city,
  p.total_entries,
  p.referral_link_code,
  count(distinct o.id) filter (where o.status = 'paid') as paid_orders_count,
  coalesce(sum(r.bonus_entries_awarded), 0) as referral_entries_won,
  max(o.paid_at) as last_payment_at
from public.participants p
left join public.orders o on o.participant_id = p.id
left join public.referrals r on r.referrer_participant_id = p.id
group by p.id;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute procedure public.handle_updated_at();

drop trigger if exists trg_admin_users_updated_at on public.admin_users;
create trigger trg_admin_users_updated_at
before update on public.admin_users
for each row execute procedure public.handle_updated_at();

drop trigger if exists trg_campaigns_updated_at on public.campaigns;
create trigger trg_campaigns_updated_at
before update on public.campaigns
for each row execute procedure public.handle_updated_at();

drop trigger if exists trg_packages_updated_at on public.packages;
create trigger trg_packages_updated_at
before update on public.packages
for each row execute procedure public.handle_updated_at();

drop trigger if exists trg_participants_updated_at on public.participants;
create trigger trg_participants_updated_at
before update on public.participants
for each row execute procedure public.handle_updated_at();

drop trigger if exists trg_referral_links_updated_at on public.referral_links;
create trigger trg_referral_links_updated_at
before update on public.referral_links
for each row execute procedure public.handle_updated_at();

drop trigger if exists trg_orders_updated_at on public.orders;
create trigger trg_orders_updated_at
before update on public.orders
for each row execute procedure public.handle_updated_at();

drop trigger if exists trg_campaign_media_updated_at on public.campaign_media;
create trigger trg_campaign_media_updated_at
before update on public.campaign_media
for each row execute procedure public.handle_updated_at();

drop trigger if exists trg_payment_provider_configs_updated_at on public.payment_provider_configs;
create trigger trg_payment_provider_configs_updated_at
before update on public.payment_provider_configs
for each row execute procedure public.handle_updated_at();

drop trigger if exists trg_system_settings_updated_at on public.system_settings;
create trigger trg_system_settings_updated_at
before update on public.system_settings
for each row execute procedure public.handle_updated_at();

alter table public.profiles enable row level security;
alter table public.admin_users enable row level security;
alter table public.campaigns enable row level security;
alter table public.packages enable row level security;
alter table public.participants enable row level security;
alter table public.referral_links enable row level security;
alter table public.orders enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.referrals enable row level security;
alter table public.campaign_media enable row level security;
alter table public.payment_provider_configs enable row level security;
alter table public.system_settings enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists "profiles_select_self_or_admin" on public.profiles;
create policy "profiles_select_self_or_admin"
on public.profiles
for select
using (auth.uid() = id or public.current_user_is_admin());

drop policy if exists "profiles_update_self_or_admin" on public.profiles;
create policy "profiles_update_self_or_admin"
on public.profiles
for update
using (auth.uid() = id or public.current_user_is_admin())
with check (auth.uid() = id or public.current_user_is_admin());

drop policy if exists "profiles_insert_self_or_admin" on public.profiles;
create policy "profiles_insert_self_or_admin"
on public.profiles
for insert
with check (auth.uid() = id or public.current_user_is_admin());

drop policy if exists "admin_users_admin_only" on public.admin_users;
create policy "admin_users_admin_only"
on public.admin_users
for all
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "campaigns_public_read_active" on public.campaigns;
create policy "campaigns_public_read_active"
on public.campaigns
for select
using (status = 'active');

drop policy if exists "campaigns_admin_all" on public.campaigns;
create policy "campaigns_admin_all"
on public.campaigns
for all
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "packages_public_read_active" on public.packages;
create policy "packages_public_read_active"
on public.packages
for select
using (
  status = 'active'
  and exists (
    select 1 from public.campaigns c
    where c.id = campaign_id and c.status = 'active'
  )
);

drop policy if exists "packages_admin_all" on public.packages;
create policy "packages_admin_all"
on public.packages
for all
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "participants_admin_all" on public.participants;
create policy "participants_admin_all"
on public.participants
for all
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "participants_select_self" on public.participants;
create policy "participants_select_self"
on public.participants
for select
using (profile_id = auth.uid());

drop policy if exists "referral_links_admin_all" on public.referral_links;
create policy "referral_links_admin_all"
on public.referral_links
for all
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "referral_links_select_owner" on public.referral_links;
create policy "referral_links_select_owner"
on public.referral_links
for select
using (
  exists (
    select 1 from public.participants p
    where p.id = owner_participant_id and p.profile_id = auth.uid()
  )
);

drop policy if exists "orders_admin_all" on public.orders;
create policy "orders_admin_all"
on public.orders
for all
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "orders_select_owner" on public.orders;
create policy "orders_select_owner"
on public.orders
for select
using (
  exists (
    select 1 from public.participants p
    where p.id = participant_id and p.profile_id = auth.uid()
  )
);

drop policy if exists "payment_transactions_admin_all" on public.payment_transactions;
create policy "payment_transactions_admin_all"
on public.payment_transactions
for all
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "referrals_admin_all" on public.referrals;
create policy "referrals_admin_all"
on public.referrals
for all
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "referrals_select_owner" on public.referrals;
create policy "referrals_select_owner"
on public.referrals
for select
using (
  exists (
    select 1 from public.participants p
    where p.id = referrer_participant_id and p.profile_id = auth.uid()
  )
);

drop policy if exists "campaign_media_public_read_active_campaigns" on public.campaign_media;
create policy "campaign_media_public_read_active_campaigns"
on public.campaign_media
for select
using (
  exists (
    select 1 from public.campaigns c
    where c.id = campaign_id and c.status = 'active'
  )
);

drop policy if exists "campaign_media_admin_all" on public.campaign_media;
create policy "campaign_media_admin_all"
on public.campaign_media
for all
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "payment_provider_configs_admin_all" on public.payment_provider_configs;
create policy "payment_provider_configs_admin_all"
on public.payment_provider_configs
for all
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "system_settings_admin_all" on public.system_settings;
create policy "system_settings_admin_all"
on public.system_settings
for all
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists "audit_logs_admin_all" on public.audit_logs;
create policy "audit_logs_admin_all"
on public.audit_logs
for all
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

insert into storage.buckets (id, name, public)
values ('campaign-media', 'campaign-media', true)
on conflict (id) do nothing;

drop policy if exists "campaign_media_bucket_public_read" on storage.objects;
create policy "campaign_media_bucket_public_read"
on storage.objects
for select
using (bucket_id = 'campaign-media');

drop policy if exists "campaign_media_bucket_admin_insert" on storage.objects;
create policy "campaign_media_bucket_admin_insert"
on storage.objects
for insert
with check (bucket_id = 'campaign-media' and public.current_user_is_admin());

drop policy if exists "campaign_media_bucket_admin_update" on storage.objects;
create policy "campaign_media_bucket_admin_update"
on storage.objects
for update
using (bucket_id = 'campaign-media' and public.current_user_is_admin())
with check (bucket_id = 'campaign-media' and public.current_user_is_admin());

drop policy if exists "campaign_media_bucket_admin_delete" on storage.objects;
create policy "campaign_media_bucket_admin_delete"
on storage.objects
for delete
using (bucket_id = 'campaign-media' and public.current_user_is_admin());

insert into public.system_settings (key, value)
values
  ('checkout', jsonb_build_object('landing_base_url', 'https://tu-dominio.com', 'default_provider', 'mercado_pago')),
  ('referrals', jsonb_build_object('enabled', true, 'default_bonus_min', 2, 'default_bonus_max', 2, 'unlock_after_entries', 3))
on conflict (key) do nothing;

comment on table public.payment_provider_configs is
'Credenciales editables desde el panel admin. En producción conviene migrar los secretos a Supabase Vault.';

comment on function public.ensure_participant_referral_link(uuid, uuid) is
'Genera el enlace único del comprador cuando tiene una compra procesada.';

comment on function public.apply_paid_order_effects() is
'Cuando una orden pasa a paid suma chances, crea link único y premia referidos con 2 o 3 chances según campaña.';

-- Usuario administrador inicial:
-- insert into public.admin_users (user_id, role)
-- values ('UUID_DEL_USUARIO', 'super_admin')
-- on conflict (user_id) do update
-- set role = excluded.role,
--     is_active = true;
