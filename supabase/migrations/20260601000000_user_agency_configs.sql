-- Per-user agency configuration.
-- One row per authenticated user; config is a free-form JSONB blob
-- that the portal merges over the built-in AGENCY_CONFIG defaults.

create table public.user_agency_configs (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  config     jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_agency_configs enable row level security;

create policy "Users manage their own config"
  on public.user_agency_configs
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);
