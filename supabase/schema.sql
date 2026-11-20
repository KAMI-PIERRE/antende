create extension if not exists pgcrypto;

create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  class_name text not null,
  description text,
  created_at timestamptz not null default now()
);

create unique index if not exists classes_name_unique
  on public.classes (lower(class_name));

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  student_id text not null,
  full_name text not null,
  gender text,
  phone text,
  email text,
  class_id uuid references public.classes(id) on delete set null,
  registration_date date not null default current_date,
  active_status boolean not null default true,
  exit_reason text,
  created_at timestamptz not null default now(),
  constraint students_uid_hex check (student_id ~ '^[0-9A-Fa-f]{4,20}$')
);

alter table public.students add column if not exists exit_reason text;
alter table public.students drop constraint if exists students_student_id_key;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.students'::regclass
      and conname = 'students_exit_reason_check'
  ) then
    alter table public.students
      add constraint students_exit_reason_check
      check (exit_reason is null or exit_reason in ('finished', 'dropped'));
  end if;
end;
$$;

create unique index if not exists students_active_uid_unique
  on public.students(student_id)
  where active_status;

create index if not exists students_class_id_idx on public.students(class_id);
create index if not exists students_full_name_idx on public.students using btree (full_name);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete restrict,
  session_id text not null,
  attendance_date date not null,
  attendance_time time not null,
  status text not null default 'present' check (status in ('present')),
  device_id text,
  created_at timestamptz not null default now(),
  constraint attendance_one_per_student_session unique (student_id, session_id)
);

create index if not exists attendance_date_idx on public.attendance(attendance_date desc);
create index if not exists attendance_student_date_idx on public.attendance(student_id, attendance_date desc);

create table if not exists public.registration_requests (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  status text not null default 'pending'
    check (status in ('pending', 'scanned', 'expired', 'cancelled')),
  uid text,
  expires_at timestamptz not null,
  scanned_at timestamptz,
  created_at timestamptz not null default now(),
  constraint registration_request_uid_hex
    check (uid is null or uid ~ '^[0-9A-Fa-f]{4,20}$')
);

create index if not exists registration_requests_pending_idx
  on public.registration_requests(device_id, created_at)
  where status = 'pending';

alter table public.classes enable row level security;
alter table public.students enable row level security;
alter table public.attendance enable row level security;
alter table public.registration_requests enable row level security;

-- The Express server uses the server-only service role key. Do not expose it to browsers or firmware.
-- No anon/authenticated policies are created; direct client access is intentionally denied.
