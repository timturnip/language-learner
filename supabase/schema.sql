-- Run in Supabase SQL editor (Project → SQL → New query → paste → Run).
-- Idempotent: safe to re-run.

------------------------------------------------------------
-- TABLES
------------------------------------------------------------

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  play_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.sentences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  english text not null,
  korean text not null,
  group_ids uuid[] not null default '{}',
  audio_path text,            -- e.g. "<user_id>/<sentence_id>.mp3" in the audio bucket
  audio_voice text,           -- e.g. "ko-KR-Neural2-A"; null = no audio yet
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sentences_user_idx on public.sentences(user_id);
create index if not exists sentences_group_ids_idx on public.sentences using gin(group_ids);
create index if not exists groups_user_idx on public.groups(user_id);

------------------------------------------------------------
-- updated_at trigger
------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sentences_touch on public.sentences;
create trigger sentences_touch
  before update on public.sentences
  for each row execute function public.touch_updated_at();

drop trigger if exists groups_touch on public.groups;
create trigger groups_touch
  before update on public.groups
  for each row execute function public.touch_updated_at();

------------------------------------------------------------
-- RLS
------------------------------------------------------------

alter table public.sentences enable row level security;
alter table public.groups enable row level security;

drop policy if exists "own sentences" on public.sentences;
create policy "own sentences" on public.sentences
  for all
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "own groups" on public.groups;
create policy "own groups" on public.groups
  for all
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

------------------------------------------------------------
-- STORAGE: private "audio" bucket; objects keyed by <user_id>/<file>
------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('audio', 'audio', false)
on conflict (id) do nothing;

drop policy if exists "audio: own read" on storage.objects;
create policy "audio: own read" on storage.objects
  for select
  using (
    bucket_id = 'audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "audio: own write" on storage.objects;
create policy "audio: own write" on storage.objects
  for insert
  with check (
    bucket_id = 'audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "audio: own update" on storage.objects;
create policy "audio: own update" on storage.objects
  for update
  using (
    bucket_id = 'audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "audio: own delete" on storage.objects;
create policy "audio: own delete" on storage.objects
  for delete
  using (
    bucket_id = 'audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

------------------------------------------------------------
-- Convenience: bump groups.play_count atomically
------------------------------------------------------------

create or replace function public.increment_group_play_count(g uuid)
returns void language sql security definer as $$
  update public.groups
     set play_count = play_count + 1
   where id = g and user_id = auth.uid();
$$;
revoke all on function public.increment_group_play_count(uuid) from public;
grant execute on function public.increment_group_play_count(uuid) to authenticated;
