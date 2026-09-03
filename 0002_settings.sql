-- Server-side settings (bot token, webhook secret). Never exposed via PostgREST (RLS, no policies).
create table if not exists public.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.settings enable row level security;
