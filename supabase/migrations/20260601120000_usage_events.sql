create table public.usage_events (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id),
  event_type text        not null,
  created_at timestamptz not null default now()
);

create index usage_events_user_id_created_at_idx
  on public.usage_events (user_id, created_at desc);

alter table public.usage_events enable row level security;

-- Users can read only their own rows; service-role bypasses RLS for inserts
create policy "users_select_own"
  on public.usage_events
  for select
  using (auth.uid() = user_id);
