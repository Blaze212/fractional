-- Migration: Logo storage bucket + metadata table + RLS policies
-- Spec 002: Per-User Company Logo on Resume Export

-- Create the resume-logos storage bucket (private — not publicly accessible)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'resume-logos',
  'resume-logos',
  false,
  2097152, -- 2 MB in bytes
  array['image/png', 'image/jpeg']
)
on conflict (id) do nothing;

-- RLS policies for storage.objects in the resume-logos bucket
-- Allow authenticated users to manage only their own objects ({userId}/ prefix)

create policy "Users can insert their own logo"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'resume-logos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can select their own logo"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'resume-logos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can update their own logo"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'resume-logos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can delete their own logo"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'resume-logos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Metadata table for logo dimensions and mime type
create table if not exists public.user_resume_logo (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  storage_path text not null,
  mime_type    text not null,
  width_px     int  not null,
  height_px    int  not null,
  file_size    int  not null,
  updated_at   timestamptz not null default now()
);

alter table public.user_resume_logo enable row level security;

create policy "Users can select their own logo metadata"
  on public.user_resume_logo for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can insert their own logo metadata"
  on public.user_resume_logo for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can update their own logo metadata"
  on public.user_resume_logo for update
  to authenticated
  using (user_id = auth.uid());

create policy "Users can delete their own logo metadata"
  on public.user_resume_logo for delete
  to authenticated
  using (user_id = auth.uid());
