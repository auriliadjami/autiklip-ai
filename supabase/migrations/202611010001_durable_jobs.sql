-- AUTOCLIP AI: durable job metadata and render queue foundation
-- Run this migration in the Supabase SQL Editor.

alter table public.clips
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists clips_status_created_at_idx
  on public.clips (status, created_at);

create table if not exists public.render_queue (
  id uuid primary key default gen_random_uuid(),
  clip_id uuid not null references public.clips(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clip_id)
);

create index if not exists render_queue_claim_idx
  on public.render_queue (status, available_at, created_at);

-- Atomically claims one available item. Call only from the trusted server
-- using the Supabase service-role key; never expose this RPC to browser clients.
create or replace function public.claim_next_render_job(worker_name text)
returns setof public.render_queue
language sql
security definer
set search_path = public
as $$
  update public.render_queue q
  set status = 'processing',
      attempts = q.attempts + 1,
      locked_at = now(),
      locked_by = worker_name,
      updated_at = now()
  where q.id = (
    select id
    from public.render_queue
    where status = 'queued'
      and available_at <= now()
    order by created_at
    for update skip locked
    limit 1
  )
  returning q.*;
$$;

revoke all on function public.claim_next_render_job(text) from public, anon, authenticated;
grant execute on function public.claim_next_render_job(text) to service_role;

-- Allow a crashed worker's lease to be returned to the queue after 15 minutes.
create or replace function public.requeue_stale_render_jobs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare changed integer;
begin
  update public.render_queue
  set status = 'queued', locked_at = null, locked_by = null,
      available_at = now(), updated_at = now(),
      last_error = coalesce(last_error, 'Worker lease expired; queued again.')
  where status = 'processing'
    and locked_at < now() - interval '15 minutes';
  get diagnostics changed = row_count;
  return changed;
end;
$$;

revoke all on function public.requeue_stale_render_jobs() from public, anon, authenticated;
grant execute on function public.requeue_stale_render_jobs() to service_role;
