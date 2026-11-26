# Correcciones automáticas de preguntas

## Preparación de Supabase

1. En **Authentication → Sign In / Providers**, habilita **Anonymous Sign-Ins**. El navegador crea o reutiliza un usuario anónimo; su `auth.uid()` identifica los flags y permite aplicar RLS. No se requiere colocar una clave de servicio en el cliente.
2. Ejecuta `supabase/flags_preguntas.sql` en **SQL Editor**. Crea `flags_preguntas`, `flags_sesiones`, las políticas RLS y un trigger que envía un único dispatch al insertar el marcador de una sesión.
3. En **Project Settings → Vault** (o **Integrations → Vault**), crea estos secretos:
   - Nombre `github_dispatch_url`, valor `https://api.github.com/repos/<USUARIO>/<REPO>/dispatches` (sustituye ambos marcadores).
   - Nombre `github_dispatch_pat`, valor de un fine-grained Personal Access Token limitado al repositorio, con permiso **Contents: Read and write**. GitHub requiere este permiso para `repository_dispatch`.
   No incluyas el PAT en el SQL, el frontend, el repositorio ni los logs.
4. Verifica que la extensión `pg_net` esté habilitada. El SQL la crea si no existe; Supabase Vault debe estar habilitado en el proyecto.

## Webhook de Supabase → GitHub

El envío usa un trigger SQL con `pg_net` y Vault, no un Database Webhook estándar del Dashboard. El webhook estándar envía su propio evento `record` y no permite configurar el cuerpo fijo requerido por GitHub; además, si escucha `flags_preguntas`, dispararía una ejecución por fila.

El trigger escucha únicamente `INSERT` en `public.flags_sesiones`, cuya clave UUID hace idempotente el envío por sesión. La petición resultante es:

- **Método:** `POST`
- **URL:** `https://api.github.com/repos/<USUARIO>/<REPO>/dispatches`
- **Headers:**
  - `Authorization: Bearer <GITHUB_PAT>` (se obtiene de Vault; nunca se configura en el cliente)
  - `Content-Type: application/json`
  - `Accept: application/vnd.github+json`
  - `X-GitHub-Api-Version: 2022-11-28`
- **Body:** `{"event_type":"aplicar-flags"}`

El frontend sube todos los flags pendientes de la sesión a `flags_preguntas` en un `.upsert()` y después inserta un único marcador en `flags_sesiones`. El trigger crea el dispatch solo al insertar ese marcador; reintentar la misma sesión no crea otro marcador.

> **Aviso de acceso:** Anonymous Sign-Ins identifica sesiones, pero no verifica a la persona. Como el workflow aplica correcciones automáticamente, cualquier visitante que pueda usar la app puede proponer contenido. Antes de habilitarlo en producción, limita el envío (por ejemplo, autenticación verificada, CAPTCHA o una etapa de moderación).

## Secretos de GitHub Actions

En **Settings → Secrets and variables → Actions** del repositorio, crea:

- `SUPABASE_URL`: URL del proyecto Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: clave `service_role` del proyecto. Solo se usa en Actions; nunca la publiques ni la pongas en archivos.

El workflow `.github/workflows/aplicar-flags.yml` se inicia con el dispatch o manualmente. Aplica los JSON, hace push si hay cambios y solo entonces marca las filas de Supabase como aplicadas. Si falla el push, los flags permanecen pendientes.

## Ejecución manual local (Node.js 20+)

```sh
SUPABASE_URL="https://<PROJECT>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<SERVICE_ROLE_KEY>" \
node scripts/aplicar_flags.js --dry-run
```

Sin `--dry-run`, el script modifica `data/test_XXX.json` y marca las filas que aplicó. Para automatización, el workflow usa `--defer-mark` y `--mark-applied` en fases separadas para no perder correcciones si el push no llega a completarse.
