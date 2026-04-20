# Plan de Implementación: Google Calendar Integration

**Referencia:** `docs/brief-integrate-google-calendar.md`
**Fecha:** 2026-04-20

---

## Contexto del Proyecto

El proyecto es un monorepo con:
- **`apps/web`** — Next.js 16 (App Router) con rutas API y frontend React
- **`packages/agent`** — LangGraph runner, tools catalog y adapters
- **`packages/db`** — Cliente Supabase, migraciones SQL, queries y utils de cifrado

Ya existe un patrón OAuth completo para GitHub que se replicará para Google Calendar.

---

## Fases de Implementación

### Fase 1 — Variables de Entorno y Credenciales

**Archivo:** `apps/web/.env.local`

Agregar:
```
GOOGLE_CLIENT_ID=<from Google Cloud Console>
GOOGLE_CLIENT_SECRET=<from Google Cloud Console>
```

> `OAUTH_ENCRYPTION_KEY` ya existe. No se necesita nueva variable para cifrado.

**Configuración en Google Cloud Console:**
- Habilitar **Google Calendar API**
- Crear OAuth 2.0 Client ID (Web application)
- Authorized redirect URI: `${NEXT_PUBLIC_APP_URL}/api/auth/google/callback`

---

### Fase 2 — Migración de Base de Datos

**Archivo nuevo:** `packages/db/supabase/migrations/00002_google_calendar.sql`

```sql
-- No se requieren nuevas tablas.
-- user_integrations ya soporta provider='google_calendar'.
-- Solo se necesita asegurar que el índice existe.

CREATE UNIQUE INDEX IF NOT EXISTS user_integrations_user_provider
  ON user_integrations(user_id, provider);
```

> La tabla `user_integrations` ya tiene columnas `encrypted_tokens`, `provider`, `scopes`, `user_id`. El schema existente es suficiente.

---

### Fase 3 — Backend: Rutas OAuth

**Patrón base:** `apps/web/src/app/api/auth/github/` (replicar estructura)

#### 3.1 Iniciar flujo OAuth

**Archivo nuevo:** `apps/web/src/app/api/auth/google/route.ts`

Responsabilidades:
- Obtener usuario autenticado con Supabase
- Generar `state` = `user.id` (CSRF protection, mismo patrón GitHub)
- Construir URL de autorización de Google con:
  - `client_id`, `redirect_uri`, `response_type=code`
  - `scope=https://www.googleapis.com/auth/calendar.events`
  - `access_type=offline` (para obtener `refresh_token`)
  - `prompt=consent` (forzar entrega del `refresh_token` en re-autorizaciones)
  - `state=<user.id>`
- Redirigir al usuario a Google

#### 3.2 Callback OAuth

**Archivo nuevo:** `apps/web/src/app/api/auth/google/callback/route.ts`

Responsabilidades:
1. Validar `state` contra `user.id` (CSRF check)
2. Intercambiar `code` por tokens via `POST https://oauth2.googleapis.com/token`
3. Recibir `{ access_token, refresh_token, expires_in, token_type }`
4. Cifrar el objeto completo con `encryptToken()` de `packages/db/src/crypto.ts`
5. Upsert en `user_integrations` con `provider='google_calendar'`
6. Redirigir a `/settings` con query param de éxito

#### 3.3 Desconectar integración

**Archivo nuevo:** `apps/web/src/app/api/auth/google/disconnect/route.ts`

Responsabilidades:
- Eliminar el registro de `user_integrations` donde `provider='google_calendar'`
- Devolver `{ success: true }`

---

### Fase 4 — Gestión de Tokens (Refresh Automático)

**Archivo nuevo:** `packages/db/src/queries/google-tokens.ts`

Función `getValidGoogleTokens(userId: string)`:
1. Obtener integración de `user_integrations` donde `provider='google_calendar'`
2. Descifrar tokens con `decryptToken()`
3. Verificar si `access_token` está expirado (`expires_at < Date.now()`)
4. Si expirado: llamar a `POST https://oauth2.googleapis.com/token` con `grant_type=refresh_token`
5. Re-cifrar y actualizar `user_integrations` con nuevo `access_token` y `expires_at`
6. Retornar `access_token` válido

---

### Fase 5 — Inyección de Tokens al Agente

**Archivo modificado:** `apps/web/src/app/api/chat/route.ts`

Siguiendo el patrón existente en líneas 68-79 (GitHub token injection):

```typescript
// Después de obtener github_token, agregar:
const googleTokens = await getValidGoogleTokens(user.id);
const googleAccessToken = googleTokens?.access_token ?? null;
```

Pasar `googleAccessToken` al contexto de las tools junto con los demás tokens.

**Archivo modificado:** `apps/web/src/app/api/chat/confirm/route.ts`

Mismo patrón: inyectar `googleAccessToken` al ejecutar la herramienta aprobada vía `executeApprovedToolCall()`.

---

### Fase 6 — Tipos Compartidos

**Archivo modificado:** `packages/types/src/index.ts`

Agregar al tipo `AgentContext` (o equivalente):
```typescript
googleAccessToken?: string | null;
```

Agregar tipo de respuesta estructurada para confirmación (si no existe genérico):
```typescript
export interface ConfirmationRequired {
  pending_confirmation: true;
  tool_call_id: string;
  action: string;        // "confirm_attendance"
  params: Record<string, unknown>;
  description: string;   // texto legible para el usuario
}
```

---

### Fase 7 — Tools del Agente (LangGraph)

#### 7.1 Definición en el catálogo

**Archivo modificado:** `packages/agent/src/tools/catalog.ts`

Agregar al array de tools:

```typescript
{
  id: "google_calendar_get_events",
  name: "get_upcoming_events",
  description: "Lista los próximos eventos del calendario de Google del usuario",
  riskLevel: "low",
  requiresIntegration: "google_calendar",
},
{
  id: "google_calendar_confirm_attendance",
  name: "confirm_attendance",
  description: "Confirma la asistencia del usuario a un evento del calendario",
  riskLevel: "medium",  // requiere confirmación del usuario
  requiresIntegration: "google_calendar",
},
```

#### 7.2 Implementación en adapters

**Archivo modificado:** `packages/agent/src/tools/adapters.ts`

**Tool `get_upcoming_events`:**
- Schema Zod: `z.object({})` (sin parámetros)
- Implementación:
  - `GET https://www.googleapis.com/calendar/v3/calendars/primary/events`
  - Query params: `timeMin=<now ISO>`, `maxResults=10`, `singleEvents=true`, `orderBy=startTime`
  - Header: `Authorization: Bearer <googleAccessToken>`
  - Retornar array de `{ id, summary, start: { dateTime|date }, responseStatus }`

**Tool `confirm_attendance`:**
- Schema Zod: `z.object({ event_id: z.string() })`
- Implementación con confirmación (patrón `riskLevel: "medium"`):
  - Si no aprobado: retornar `ConfirmationRequired` (interrupt al grafo)
  - Si aprobado: `PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/<event_id>`
  - Body: `{ attendees: [{ email: <userEmail>, responseStatus: "accepted" }] }`
  - Header: `Authorization: Bearer <googleAccessToken>`

---

### Fase 8 — Frontend: Settings Page

**Archivo modificado:** `apps/web/src/app/settings/settings-form.tsx`

Agregar sección "Google Calendar" siguiendo el patrón de la sección GitHub:

```tsx
{/* Google Calendar Integration */}
<div className="integration-card">
  <h3>Google Calendar</h3>
  {isGoogleConnected ? (
    <>
      <span className="badge-connected">Conectado</span>
      <button onClick={handleGoogleDisconnect}>Desconectar</button>
    </>
  ) : (
    <a href="/api/auth/google">
      <button>Conectar Google Calendar</button>
    </a>
  )}
</div>
```

**Archivo modificado:** `apps/web/src/app/settings/page.tsx` (server component)

Agregar query para verificar si existe integración `google_calendar` para el usuario actual.

---

### Fase 9 — Frontend: UI de Confirmación

El framework de confirmación ya existe para GitHub (`github_create_issue`, `github_create_repo`). Solo se necesita:

**Archivo a revisar:** componente de chat que renderiza confirmaciones.

Verificar que el componente existente maneja el nuevo `action: "confirm_attendance"` mostrando texto legible. Si el componente es genérico, no se requieren cambios.

**Telegram:** El sistema de inline buttons ya existe en `apps/web/src/app/api/telegram/webhook/route.ts`. Verificar que el handler de `callback_query` llama al endpoint `/api/chat/confirm` — si sí, no se necesitan cambios adicionales.

---

## Orden de Ejecución

| # | Tarea | Archivos | Dependencias |
|---|-------|----------|--------------|
| 1 | Agregar env vars | `.env.local` | — |
| 2 | Migración SQL | `00002_google_calendar.sql` | — |
| 3 | Ruta OAuth init | `api/auth/google/route.ts` | 1 |
| 4 | Ruta OAuth callback | `api/auth/google/callback/route.ts` | 1, 3 |
| 5 | Ruta disconnect | `api/auth/google/disconnect/route.ts` | 2 |
| 6 | Google token refresh | `packages/db/src/queries/google-tokens.ts` | 2 |
| 7 | Tipos compartidos | `packages/types/src/index.ts` | — |
| 8 | Tool catalog | `packages/agent/src/tools/catalog.ts` | 7 |
| 9 | Tool adapters | `packages/agent/src/tools/adapters.ts` | 7, 8 |
| 10 | Inyección en chat API | `apps/web/src/app/api/chat/route.ts` | 6, 9 |
| 11 | Inyección en confirm API | `apps/web/src/app/api/chat/confirm/route.ts` | 6, 9 |
| 12 | Settings UI | `settings-form.tsx`, `settings/page.tsx` | 3, 5 |
| 13 | Verificar UI confirmación | chat component, telegram webhook | 10, 11 |

---

## Archivos Nuevos (resumen)

```
apps/web/src/app/api/auth/google/route.ts
apps/web/src/app/api/auth/google/callback/route.ts
apps/web/src/app/api/auth/google/disconnect/route.ts
packages/db/supabase/migrations/00002_google_calendar.sql
packages/db/src/queries/google-tokens.ts
```

## Archivos Modificados (resumen)

```
apps/web/.env.local
apps/web/src/app/api/chat/route.ts
apps/web/src/app/api/chat/confirm/route.ts
apps/web/src/app/settings/page.tsx
apps/web/src/app/settings/settings-form.tsx
packages/agent/src/tools/catalog.ts
packages/agent/src/tools/adapters.ts
packages/types/src/index.ts
```

---

## Notas de Seguridad

- `state` en OAuth = `user.id` (igual que GitHub) — protege contra CSRF
- Tokens cifrados con AES-256-GCM antes de persistir (reutiliza `crypto.ts` existente)
- `refresh_token` solo se obtiene con `access_type=offline` + `prompt=consent`
- Scope mínimo: `calendar.events` (no `calendar` completo)
- El descifrado solo ocurre en el servidor (rutas API), nunca en el cliente
