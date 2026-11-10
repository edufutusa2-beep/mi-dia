-- ============ Mi Día · configuración de la base de datos ============
-- 1) Datos de la app (agenda, movimientos, presupuesto), privados por usuario
create table if not exists public.items (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  data jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table public.items enable row level security;
drop policy if exists "Cada usuario solo ve y cambia lo suyo" on public.items;
create policy "Cada usuario solo ve y cambia lo suyo" on public.items
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create or replace function public.items_touch() returns trigger
  language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists items_touch on public.items;
create trigger items_touch before insert or update on public.items
  for each row execute function public.items_touch();
create index if not exists items_user_updated on public.items (user_id, updated_at);

-- 2) Dispositivos que reciben notificaciones
create table if not exists public.push_subs (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  tz text,
  ua text,
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists "Cada usuario gestiona sus dispositivos" on public.push_subs;
create policy "Cada usuario gestiona sus dispositivos" on public.push_subs
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 3) Registro de avisos ya enviados (para no repetirlos). Solo lo usa el servidor.
create table if not exists public.push_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.push_log enable row level security;

-- 4) Extensiones para lanzar la función cada 15 minutos
create extension if not exists pg_cron;
create extension if not exists pg_net;
