create table public.usage_limits (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references auth.users(id),
  tool           text        not null,
  usage_count    int         not null default 0,
  override_limit int         null,
  period_start   timestamptz not null default now(),
  lifetime_count bigint      not null default 0,
  unique (user_id, tool)
);

create index usage_limits_user_id_tool_idx
  on public.usage_limits (user_id, tool);

alter table public.usage_limits enable row level security;

create policy "users_select_own"
  on public.usage_limits
  for select
  using (auth.uid() = user_id);
