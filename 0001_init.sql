-- Expense tracker: initial schema

create table if not exists public.users (
  telegram_id bigint primary key,
  username text,
  first_name text,
  base_currency text not null default 'RUB',
  created_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id bigserial primary key,
  user_id bigint not null references public.users(telegram_id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'RUB',
  description text not null default '',
  category text not null default 'Прочее',
  raw_text text,
  spent_at date not null default (now()::date),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists expenses_user_spent_idx on public.expenses(user_id, spent_at desc);

create table if not exists public.budgets (
  user_id bigint not null references public.users(telegram_id) on delete cascade,
  category text not null,
  monthly_limit numeric(12,2) not null check (monthly_limit > 0),
  currency text not null default 'RUB',
  created_at timestamptz not null default now(),
  primary key (user_id, category)
);

-- One-time deep-link tokens issued by the bot ("Открыть панель" button)
create table if not exists public.login_tokens (
  token text primary key,
  telegram_id bigint not null references public.users(telegram_id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  used_at timestamptz
);

-- Long-lived web session, addressed by an opaque cookie value
create table if not exists public.sessions (
  token text primary key,
  telegram_id bigint not null references public.users(telegram_id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);

create index if not exists sessions_telegram_idx on public.sessions(telegram_id);

-- Lock every table down from the auto-generated PostgREST API.
-- All real access happens inside Edge Functions using the service role key.
alter table public.users enable row level security;
alter table public.expenses enable row level security;
alter table public.budgets enable row level security;
alter table public.login_tokens enable row level security;
alter table public.sessions enable row level security;
-- (no policies created => anon/authenticated roles get zero rows; service_role bypasses RLS)
