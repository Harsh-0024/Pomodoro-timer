-- Muhurata cloud sync: the Supabase side.
--
-- Paste this whole file into Supabase -> SQL Editor -> New query -> Run.
-- It is safe to run again: everything is "create if missing" or replaced.
--
-- How it fits together
--   * Every computer keeps its own full copy in SQLite (see migration 0002).
--     This database is where computers exchange changes; it is not the only
--     copy of anyone's data.
--   * The app signs in as the user and talks to these tables directly
--     through Supabase's REST API. Row-level security (bottom of file) means
--     each person can only ever read and write their own rows, so the
--     public "anon" key is safe to ship inside the app.
--   * Rows are never deleted here. A delete on one computer arrives as
--     deleted_at being set, so the other computers delete their copy too.
--   * Newest change wins: an upload that is older than what is already
--     stored is ignored (see keep_newest()).
--   * server_updated_at is stamped by the server on every write. Computers
--     download "everything changed since I last looked" by this column, so a
--     computer with a wrong clock cannot make changes go missing.

-- --------------------------------------------------------------------------
-- tables
-- --------------------------------------------------------------------------
create table if not exists public.activity_segments (
    user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
    uuid              uuid not null,
    day               text not null,
    kind              text not null,
    started_at        text not null,
    ended_at          text not null,
    duration_sec      double precision not null,
    productive_sec    double precision not null default 0,
    rest_sec          double precision not null default 0,
    preset_id         text,
    preset_name       text,
    phase_index       integer,
    details_json      text not null default '{}',
    created_at        text not null,
    updated_at        text not null,          -- the computer's change time (newest wins)
    deleted_at        text,                   -- set instead of deleting
    server_updated_at timestamptz not null default now(),
    primary key (user_id, uuid)
);

-- The computer that recorded the session (added later, so it is an
-- ALTER: running this file again upgrades an existing project).
alter table public.activity_segments add column if not exists device_id uuid;

create table if not exists public.custom_presets (
    user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
    uuid              uuid not null,
    name              text not null,
    work_min          integer not null,
    short_rest_min    integer not null,
    long_rest_min     integer not null,
    created_at        text not null,
    updated_at        text not null,
    deleted_at        text,
    server_updated_at timestamptz not null default now(),
    primary key (user_id, uuid)
);

-- One settings row per person (not per computer). The app leaves out
-- settings that belong to one computer, such as sound volume.
create table if not exists public.app_settings (
    user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
    json              text not null default '{}',
    updated_at        text not null,
    deleted_at        text,                   -- unused; keeps every table the same shape for the app
    server_updated_at timestamptz not null default now(),
    primary key (user_id)
);

-- Focus minutes per day per computer. Each computer only writes its own
-- rows, so totals from several computers add up instead of overwriting.
create table if not exists public.focus_by_device (
    user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
    day               text not null,
    device_id         uuid not null,
    minutes           integer not null default 0,
    updated_at        text not null,
    deleted_at        text,                   -- unused, as above
    server_updated_at timestamptz not null default now(),
    primary key (user_id, day, device_id)
);

-- "What changed since I last looked", per person.
create index if not exists activity_segments_pull on public.activity_segments (user_id, server_updated_at);
create index if not exists custom_presets_pull    on public.custom_presets    (user_id, server_updated_at);
create index if not exists app_settings_pull      on public.app_settings      (user_id, server_updated_at);
create index if not exists focus_by_device_pull   on public.focus_by_device   (user_id, server_updated_at);

-- --------------------------------------------------------------------------
-- newest change wins, and the server stamps every write
-- --------------------------------------------------------------------------
create or replace function public.keep_newest()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if tg_op = 'UPDATE' then
        -- An upload older than (or the same as) what is stored changes
        -- nothing. Times are ISO strings in UTC, so text order is time order.
        if new.updated_at <= old.updated_at then
            return null;  -- skip this row's update
        end if;
        new.user_id := old.user_id;  -- a row can never be moved to another person
    end if;
    new.server_updated_at := clock_timestamp();
    return new;
end;
$$;

do $$
declare t text;
begin
    foreach t in array array['activity_segments', 'custom_presets', 'app_settings', 'focus_by_device'] loop
        execute format('drop trigger if exists keep_newest on public.%I', t);
        execute format(
            'create trigger keep_newest before insert or update on public.%I
             for each row execute function public.keep_newest()', t);
    end loop;
end;
$$;

-- --------------------------------------------------------------------------
-- own rows only
-- --------------------------------------------------------------------------
-- Signed-in people may read, add and change their own rows. There is no
-- delete rule, so nobody can delete rows through the API at all - not even
-- their own, and not by mistake. Signed-out requests ("anon") get nothing.
do $$
declare t text;
begin
    foreach t in array array['activity_segments', 'custom_presets', 'app_settings', 'focus_by_device'] loop
        execute format('alter table public.%I enable row level security', t);
        execute format('revoke all on public.%I from anon, authenticated', t);
        execute format('grant select, insert, update on public.%I to authenticated', t);
        execute format('drop policy if exists own_rows on public.%I', t);
        execute format(
            'create policy own_rows on public.%I for all to authenticated
             using (user_id = (select auth.uid()))
             with check (user_id = (select auth.uid()))', t);
    end loop;
end;
$$;
