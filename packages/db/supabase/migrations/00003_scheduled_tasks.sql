-- Allow background channel for cron-triggered agent sessions
alter table public.agent_sessions
  drop constraint if exists agent_sessions_channel_check;

alter table public.agent_sessions
  add constraint agent_sessions_channel_check
    check (channel in ('web', 'telegram', 'background'));

-- ============================================================
-- scheduled_tasks
-- ============================================================
create table public.scheduled_tasks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  prompt        text not null,
  schedule_type text not null check (schedule_type in ('one_time', 'recurring')),
  run_at        timestamptz,
  cron_expr     text,
  timezone      text not null default 'UTC',
  status        text not null default 'active'
    check (status in ('active', 'running', 'completed', 'failed', 'cancelled')),
  last_run_at   timestamptz,
  next_run_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.scheduled_tasks enable row level security;

create policy "Users can manage own scheduled tasks"
  on public.scheduled_tasks for all
  using (auth.uid() = user_id);

-- Fast lookup for the cron runner (uses service role, bypasses RLS)
create index scheduled_tasks_pending_idx
  on public.scheduled_tasks (next_run_at, status)
  where status = 'active';

-- ============================================================
-- scheduled_task_runs (audit log per execution)
-- ============================================================
create table public.scheduled_task_runs (
  id                   uuid primary key default gen_random_uuid(),
  task_id              uuid not null references public.scheduled_tasks(id) on delete cascade,
  status               text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  started_at           timestamptz not null default now(),
  finished_at          timestamptz,
  error                text,
  agent_session_id     uuid,
  notified             boolean not null default false,
  notified_skip_reason text
);

alter table public.scheduled_task_runs enable row level security;

create policy "Users can view own task runs"
  on public.scheduled_task_runs for select
  using (
    exists (
      select 1 from public.scheduled_tasks t
      where t.id = scheduled_task_runs.task_id
        and t.user_id = auth.uid()
    )
  );

create index scheduled_task_runs_task_idx
  on public.scheduled_task_runs (task_id, started_at desc);
