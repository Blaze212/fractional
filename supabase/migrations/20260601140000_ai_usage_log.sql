create table public.ai_usage_log (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users(id),
  session_id    text        null,
  feature       text        not null,
  provider      text        not null,
  model         text        not null,
  input_tokens  int         not null default 0,
  output_tokens int         not null default 0,
  total_tokens  int         not null generated always as (input_tokens + output_tokens) stored,
  latency_ms    int         not null default 0,
  success       boolean     not null default true,
  error_code    text        null,
  created_at    timestamptz not null default now()
);

create index ai_usage_log_user_id_created_at_idx
  on public.ai_usage_log (user_id, created_at desc);

alter table public.ai_usage_log enable row level security;

create policy "users_select_own"
  on public.ai_usage_log
  for select
  using (auth.uid() = user_id);
