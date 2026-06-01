create or replace function public.upsert_usage_limit(p_user_id uuid, p_tool text)
returns void
language sql
security definer
as $$
  insert into public.usage_limits (user_id, tool, usage_count, period_start, lifetime_count)
  values (p_user_id, p_tool, 1, now(), 1)
  on conflict (user_id, tool) do update set
    usage_count    = case
                       when usage_limits.period_start + interval '7 days' <= now()
                       then 1
                       else usage_limits.usage_count + 1
                     end,
    period_start   = case
                       when usage_limits.period_start + interval '7 days' <= now()
                       then now()
                       else usage_limits.period_start
                     end,
    lifetime_count = usage_limits.lifetime_count + 1;
$$;
