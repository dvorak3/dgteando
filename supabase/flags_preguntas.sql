create extension if not exists pg_net with schema extensions;

create table if not exists public.flags_preguntas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pregunta_id text not null,
  test_id integer not null,
  pregunta_idx integer not null,
  enunciado text not null,
  opciones jsonb not null,
  correcta smallint not null,
  explicacion text,
  nota text,
  aplicado boolean not null default false,
  aplicado_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint flags_preguntas_user_pregunta_unique unique (user_id, pregunta_id),
  constraint flags_preguntas_opciones_array check (jsonb_typeof(opciones) = 'array'),
  constraint flags_preguntas_opciones_count check (jsonb_array_length(opciones) between 2 and 3),
  constraint flags_preguntas_correcta_range check (correcta >= 0 and correcta < jsonb_array_length(opciones)),
  constraint flags_preguntas_test_nonnegative check (test_id > 0),
  constraint flags_preguntas_indice_nonnegative check (pregunta_idx >= 0)
);

create table if not exists public.flags_sesiones (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  flags_count integer not null check (flags_count > 0),
  created_at timestamptz not null default now()
);

alter table public.flags_preguntas enable row level security;
alter table public.flags_sesiones enable row level security;

drop policy if exists "Users can read their own question flags" on public.flags_preguntas;
create policy "Users can read their own question flags"
  on public.flags_preguntas for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can add their own question flags" on public.flags_preguntas;
create policy "Users can add their own question flags"
  on public.flags_preguntas for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own question flags" on public.flags_preguntas;
create policy "Users can update their own question flags"
  on public.flags_preguntas for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can add their own flag session markers" on public.flags_sesiones;
create policy "Users can add their own flag session markers"
  on public.flags_sesiones for insert to authenticated
  with check ((select auth.uid()) = user_id);

revoke all on public.flags_preguntas from anon, authenticated;
grant select on public.flags_preguntas to authenticated;
grant insert (
  user_id, pregunta_id, test_id, pregunta_idx,
  enunciado, opciones, correcta, explicacion, nota
) on public.flags_preguntas to authenticated;
grant update (
  user_id, pregunta_id, test_id, pregunta_idx,
  enunciado, opciones, correcta, explicacion, nota
) on public.flags_preguntas to authenticated;

revoke all on public.flags_sesiones from anon, authenticated;
grant insert (id, user_id, flags_count) on public.flags_sesiones to authenticated;

create or replace function public.preparar_flag_pregunta()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();

  if tg_op = 'UPDATE' and (
    new.enunciado is distinct from old.enunciado
    or new.opciones is distinct from old.opciones
    or new.correcta is distinct from old.correcta
    or new.explicacion is distinct from old.explicacion
    or new.nota is distinct from old.nota
  ) then
    new.aplicado := false;
    new.aplicado_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists flags_preguntas_preparar on public.flags_preguntas;
create trigger flags_preguntas_preparar
  before insert or update on public.flags_preguntas
  for each row execute function public.preparar_flag_pregunta();

create or replace function public.enviar_dispatch_aplicar_flags()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_pat text;
begin
  select decrypted_secret into v_url
  from vault.decrypted_secrets
  where name = 'github_dispatch_url'
  limit 1;

  select decrypted_secret into v_pat
  from vault.decrypted_secrets
  where name = 'github_dispatch_pat'
  limit 1;

  if coalesce(v_url, '') = '' or coalesce(v_pat, '') = '' then
    raise exception 'Faltan los secretos github_dispatch_url o github_dispatch_pat en Supabase Vault';
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_pat,
      'Content-Type', 'application/json',
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28'
    ),
    body := jsonb_build_object('event_type', 'aplicar-flags')
  );

  return new;
end;
$$;

revoke all on function public.enviar_dispatch_aplicar_flags() from public, anon, authenticated;

drop trigger if exists flags_sesiones_repository_dispatch on public.flags_sesiones;
create trigger flags_sesiones_repository_dispatch
  after insert on public.flags_sesiones
  for each row execute function public.enviar_dispatch_aplicar_flags();
